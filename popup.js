const getElement = (id) => document.getElementById(id);
const statusElement = getElement('status');
let renderedHistorySignature = '';
let currentPlayback = null;
let lastRenderedState = null;

function formatPlaybackTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = String(safeSeconds % 60).padStart(2, '0');

    return `${minutes}:${remainder}`;
}

function renderPlaybackProgress() {
    const panel = getElement('room-playback');

    if (!currentPlayback) {
        panel.classList.add('hidden');
        return;
    }

    panel.classList.remove('hidden');
    getElement('room-playback-title').textContent =
        currentPlayback.title || '当前视频';
    getElement('room-playback-status').textContent = currentPlayback.paused
        ? '已暂停'
        : '播放中';

    const elapsed = currentPlayback.paused
        ? currentPlayback.time
        : currentPlayback.time +
          Math.max(0, (Date.now() - currentPlayback.at) / 1000) *
              (currentPlayback.rate || 1);
    const duration = Number(currentPlayback.duration) || 0;

    getElement('room-playback-current').textContent =
        formatPlaybackTime(elapsed);
    getElement('room-playback-duration').textContent = duration
        ? formatPlaybackTime(duration)
        : '时长未知';
    getElement('room-playback-progress').value = duration
        ? Math.min(100, (elapsed / duration) * 100)
        : 0;
}

function safeHistoryUrl(value) {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function getConfig() {
    return {
        server: getElement('server').value.trim(),
    };
}

function renderHostMemberSettings(state) {
    const settingsPanel = getElement('host-member-settings');
    const settingsList = getElement('member-settings-list');
    const members = (state.members || []).filter(
        (clientId) => clientId !== state.hostClientId,
    );

    settingsList.replaceChildren();

    for (const [index, clientId] of members.entries()) {
        const settings = {
            canControlPlayback: true,
            canSeek: true,
            autoFollow: false,
            canManageAutoPause: false,
            autoPauseEnabled: false,
            canManagePauseOnBuffer: false,
            pauseOnBufferEnabled: false,
            ...(state.memberSettings?.[clientId] || {}),
        };
        const card = document.createElement('div');
        card.className = 'member-setting-card';

        const name = document.createElement('strong');
        name.className = 'member-setting-name';
        name.textContent = `成员 ${index + 1} · ${clientId.slice(-4)}`;

        const options = document.createElement('div');
        options.className = 'member-setting-options';

        const fields = [
            ['canControlPlayback', '播放 / 暂停'],
            ['canSeek', '进度条跳转'],
            ['autoFollow', '自动跟随新视频'],
            ['canManageAutoPause', '允许成员自选新视频就绪暂停'],
            ['canManagePauseOnBuffer', '允许成员自选卡顿触发暂停'],
        ];

        for (const [key, labelText] of fields) {
            const label = document.createElement('label');
            label.className = 'setting-checkbox member-setting-option';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = !!settings[key];
            checkbox.disabled = !state.connected;
            checkbox.addEventListener('change', () => {
                settings[key] = checkbox.checked;
                chrome.runtime.sendMessage({
                    type: 'UPDATE_MEMBER_SETTINGS',
                    targetClientId: clientId,
                    key,
                    value: checkbox.checked,
                });
            });

            label.append(checkbox, document.createTextNode(labelText));
            options.append(label);
        }

        const applyToRoomButton = document.createElement('button');
        applyToRoomButton.className = 'quiet member-settings-apply-all';
        applyToRoomButton.type = 'button';
        applyToRoomButton.textContent = '将此成员权限应用到全房间';
        applyToRoomButton.disabled = !state.connected || members.length < 2;
        applyToRoomButton.title =
            '把上方勾选的权限设置应用给房间内的所有成员';
        applyToRoomButton.addEventListener('click', () => {
            const permissionSettings = Object.fromEntries(
                fields.map(([key]) => [key, !!settings[key]]),
            );

            chrome.runtime.sendMessage({
                type: 'APPLY_MEMBER_SETTINGS_TO_ROOM',
                sourceClientId: clientId,
                settings: permissionSettings,
            });
        });

        card.append(name, options, applyToRoomButton);
        settingsList.append(card);
    }

    settingsPanel.classList.toggle(
        'hidden',
        state.role !== 'host' || members.length === 0,
    );
}

function renderInjectionDebug(state) {
    const panel = getElement('injection-debug');
    const list = getElement('injection-debug-list');

    panel.classList.toggle('hidden', state.role !== 'host');
    if (state.role !== 'host') return;

    list.replaceChildren();

    for (const [index, clientId] of (state.members || []).entries()) {
        const report = state.memberInjectionStatus?.[clientId];
        const isFresh =
            !!report && Date.now() - Number(report.receivedAt || 0) < 15_000;
        const isRefreshing = report?.refreshing && isFresh;
        let statusLabel = '等待成员上报';

        if (isRefreshing) {
            statusLabel = '重新注入中';
        } else if (report?.refreshError) {
            statusLabel = '重新注入失败';
        } else if (report?.refreshing) {
            statusLabel = '刷新请求超时';
        } else if (report && !isFresh) {
            statusLabel = '无响应：脚本未注入、页面受限或连接中断';
        } else if (isFresh && !report.responsive) {
            statusLabel = '暂未收到标签页内容脚本响应';
        } else if (isFresh && report.hasVideo && report.videoBound) {
            statusLabel = `已注入 · 视频监听已绑定 (#${report.videoBindingId || 1})`;
        } else if (isFresh && report.hasVideo) {
            statusLabel = '已注入 · 找到视频，但监听未绑定';
        } else if (isFresh) {
            statusLabel = '已注入 · 当前标签页未检测到视频';
        }

        const row = document.createElement('div');
        row.className = 'injection-debug-row';

        const heading = document.createElement('div');
        heading.className = 'injection-debug-heading';

        const memberName = document.createElement('strong');
        memberName.textContent =
            clientId === state.hostClientId ? '主机' : `成员 ${index + 1}`;

        const result = document.createElement('span');
        result.textContent = statusLabel;
        heading.append(memberName, result);

        const detail = document.createElement('div');
        detail.className = 'injection-debug-detail';
        const pageDescription = report?.pageTitle || '未获取页面标题';
        const siteDescription = report?.site ? ` · ${report.site}` : '';
        const frameDescription = report?.frameCount
            ? ` · ${report.frameCount} 个 frame`
            : '';
        detail.textContent = report
            ? `${pageDescription}${siteDescription}${frameDescription}`
            : '等待该成员扩展发送状态';

        const actions = document.createElement('div');
        actions.className = 'injection-debug-actions';

        const refreshButton = document.createElement('button');
        refreshButton.type = 'button';
        refreshButton.className = 'quiet';
        refreshButton.textContent = isRefreshing ? '处理中…' : '重新注入';
        refreshButton.disabled = !state.connected || !!isRefreshing;
        refreshButton.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'REFRESH_MEMBER_INJECTION',
                clientId,
            });
        });

        actions.append(refreshButton);
        row.append(heading, detail, actions);
        list.append(row);
    }
}

function renderSelfInjectionControl(state) {
    const panel = getElement('self-injection-control');
    const refreshButton = getElement('refresh-my-injection');
    const statusLabel = getElement('self-injection-status');
    const autoReinjectToggle = getElement('auto-reinject-same-page');
    const isInRoom = !!state.room;
    const report = state.memberInjectionStatus?.[state.clientId];

    panel.classList.toggle('hidden', !isInRoom);
    if (!isInRoom) return;

    autoReinjectToggle.checked = !!state.autoReinjectSamePage;

    if (report?.refreshing) {
        statusLabel.textContent = '正在重新注入…';
    } else if (report?.refreshError) {
        statusLabel.textContent = `重新注入失败：${report.refreshError}`;
    } else if (report?.responsive && report.hasVideo) {
        statusLabel.textContent = report.videoBound
            ? '脚本已注入，视频监听正常。'
            : '脚本已注入，当前页面尚未绑定视频。';
    } else if (report?.responsive) {
        statusLabel.textContent = '脚本已注入，当前标签页未检测到视频。';
    } else {
        statusLabel.textContent =
            '如果页面关闭后重新打开了相同视频，可在这里重新注入。';
    }

    refreshButton.disabled = !state.connected || !!report?.refreshing;
    refreshButton.textContent = report?.refreshing
        ? '处理中…'
        : '重新注入我的标签页';
}

function renderShareHistory(history = []) {
    const panel = getElement('share-history');
    const recentList = getElement('recent-share-list');
    const olderList = getElement('older-share-list');
    const olderDetails = getElement('older-shares');
    const newestFirst = [...history].slice(0, 15);
    const signature = JSON.stringify(newestFirst);

    // Keep expanded older entries open during unrelated popup state updates.
    if (signature === renderedHistorySignature) return;
    renderedHistorySignature = signature;
    const recent = newestFirst.slice(0, 3);
    const older = newestFirst.slice(3);

    recentList.replaceChildren();
    olderList.replaceChildren();
    panel.classList.toggle('hidden', newestFirst.length === 0);
    olderDetails.classList.toggle('hidden', older.length === 0);
    getElement('older-shares-summary').textContent = `更早的分享（${older.length}）`;

    function createOpenButton(navigation) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quiet share-history-open';
        button.textContent = '↗ 新标签页';
        button.title = '在新标签页打开此视频';
        button.addEventListener('click', () => {
            try {
                const url = new URL(navigation.url);
                if (['http:', 'https:'].includes(url.protocol)) {
                    chrome.tabs.create({ url: url.href });
                }
            } catch {
                // Ignore malformed URLs from stale or invalid room history.
            }
        });
        return button;
    }

    for (const navigation of recent) {
        const row = document.createElement('div');
        row.className = 'share-history-item';
        const main = document.createElement('div');
        main.className = 'share-history-item-main';

        const title = document.createElement('strong');
        title.className = 'share-history-title';
        title.textContent = navigation.title || navigation.url || '未命名视频';

        const link = document.createElement('a');
        link.className = 'share-history-url';
        link.href = safeHistoryUrl(navigation.url) || '#';
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = navigation.url || '';

        main.append(title, link);
        row.append(main, createOpenButton(navigation));
        recentList.append(row);
    }

    for (const navigation of older) {
        const row = document.createElement('div');
        row.className = 'share-history-item';
        const main = document.createElement('div');
        main.className = 'share-history-item-main';
        const details = document.createElement('details');
        const title = document.createElement('summary');
        title.className = 'share-history-title';
        title.textContent = navigation.title || '未命名视频';

        const link = document.createElement('a');
        link.className = 'share-history-url';
        link.href = safeHistoryUrl(navigation.url) || '#';
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = navigation.url || '';

        details.append(title, link);
        main.append(details);
        row.append(main, createOpenButton(navigation));
        olderList.append(row);
    }
}

function saveConfig() {
    const config = getConfig();

    // Store configuration locally and notify the service worker immediately.
    chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', ...config });
    chrome.storage.local.set(config);
}

function render(state) {
    lastRenderedState = state;
    currentPlayback = state.currentPlayback || null;
    renderPlaybackProgress();

    if (state.server) {
        getElement('server').value = state.server;
        getElement('settings-summary').textContent = '连接设置（已配置）';
    } else {
        getElement('settings-summary').textContent = '连接设置（请先填写服务器地址）';
        getElement('connection-settings').open = true;
    }

    if (state.room) {
        getElement('room-box').classList.remove('hidden');
        getElement('room-code').textContent = state.room;
        getElement('room-connection').textContent = state.connected
            ? '已连接'
            : '连接中 / 正在重连';
        getElement('room-members').textContent =
            `房间人数：${state.memberCount || 0}/${state.roomLimit || 4}`;

        const isGuest = state.role !== 'host';
        getElement('auto-follow-control').classList.toggle('hidden', !isGuest);
        getElement('auto-follow').checked = !!
            state.memberSettings?.[state.clientId]?.autoFollow;
        getElement('auto-follow').disabled = !state.connected;
        getElement('modify-tab-icon').checked = !!state.modifyTabIcon;
        getElement('modify-tab-icon').disabled = false;
        renderHostMemberSettings(state);
        renderInjectionDebug(state);
        renderSelfInjectionControl(state);

        const isHost = state.role === 'host';
        const ownSettings = state.memberSettings?.[state.clientId] || {};
        const canManageAutoPause =
            isHost || ownSettings.canManageAutoPause === true;
        const canManageBufferPause =
            isHost || ownSettings.canManagePauseOnBuffer === true;
        const autoPause = state.autoPause || { enabled: false, duration: 5 };
        getElement('auto-pause-label').textContent = isHost
            ? '新视频就绪后自动暂停（本机）'
            : '我跟随的新视频就绪后自动暂停';
        getElement('auto-pause').checked = isHost
            ? !!autoPause.enabled
            : canManageAutoPause
              ? !!ownSettings.autoPauseEnabled
              : !!autoPause.enabled;
        getElement('auto-pause').disabled =
            !canManageAutoPause || !state.connected;
        getElement('auto-pause-duration').value = String(autoPause.duration || 5);
        getElement('auto-pause-duration').disabled = !isHost || !state.connected;
        getElement('auto-pause-owner').textContent = canManageAutoPause
            ? '暂停时长由房主管理。'
            : '自动暂停开关与时长由房主管理。';
        getElement('auto-pause-owner').classList.toggle('hidden', isHost);
        getElement('pause-on-buffer-label').textContent = isHost
            ? '有人卡顿时暂停全房间'
            : '我的卡顿触发全房间暂停';
        getElement('pause-on-buffer').checked = isHost
            ? !!state.pauseOnBuffer
            : canManageBufferPause
              ? !!ownSettings.pauseOnBufferEnabled
              : !!state.pauseOnBuffer;
        getElement('pause-on-buffer').disabled =
            !canManageBufferPause || !state.connected;
        getElement('pause-on-buffer-duration').value = String(
            state.pauseOnBufferDelay || 5,
        );
        getElement('pause-on-buffer-duration').disabled =
            !isHost || !state.connected;
        getElement('pause-on-buffer-owner').textContent = canManageBufferPause
            ? '卡顿等待时长由房主管理。'
            : '卡顿开关权限与等待时长由房主管理。';
        getElement('pause-on-buffer-owner').classList.toggle('hidden', isHost);
        renderShareHistory(state.navigationHistory || []);

        const navigation = state.pendingNavigation || state.sharedNavigation;

        if (navigation) {
            getElement('navigation-panel').classList.remove('hidden');
            getElement('navigation-title').textContent = state.pendingNavigation
                ? `主机分享：${navigation.title || navigation.url}`
                : `当前分享：${navigation.title || navigation.url}`;
            getElement('navigation-url').textContent = navigation.url || '';
            getElement('navigation-url').href = navigation.url || '#';
            getElement('follow-actions').classList.toggle(
                'hidden',
                !state.pendingNavigation,
            );

            const members = (state.members || []).filter(
                (clientId) => clientId !== state.hostClientId,
            );
            const statusLabels = {
                pending: '待回应',
                following: '已跟随',
                'not-following': '未跟随',
            };

            getElement('follow-summary').textContent = members.length
                ? members
                      .map((clientId, index) => {
                          const response = (state.followResponses || []).find(
                              (item) => item.clientId === clientId,
                          );
                          const responseLabel =
                              statusLabels[response?.status] || '待回应';

                          return `成员 ${index + 1}：${responseLabel}`;
                      })
                      .join('　')
                : '目前没有其他成员。';
        } else {
            getElement('navigation-panel').classList.add('hidden');
        }
    } else {
        getElement('room-box').classList.add('hidden');
        getElement('room-playback').classList.add('hidden');
        getElement('auto-follow-control').classList.add('hidden');
        getElement('modify-tab-icon').checked = !!state.modifyTabIcon;
        getElement('modify-tab-icon').disabled = true;
        getElement('host-member-settings').classList.add('hidden');
        getElement('injection-debug').classList.add('hidden');
        getElement('self-injection-control').classList.add('hidden');
        getElement('auto-pause-panel').classList.add('hidden');
        getElement('pause-on-buffer').checked = false;
        getElement('pause-on-buffer').disabled = true;
        getElement('pause-on-buffer-duration').value = '5';
        getElement('pause-on-buffer-duration').disabled = true;
        getElement('pause-on-buffer-owner').classList.add('hidden');
        getElement('share-history').classList.add('hidden');
    }

    if (state.status) statusElement.textContent = state.status;
}

// Populate the popup from saved state, then keep it current while it is open.
chrome.storage.local.get(
    [
        'server',
        'room',
        'status',
        'connected',
        'memberCount',
        'roomLimit',
        'members',
        'memberSettings',
        'navigationHistory',
        'autoPause',
        'pauseOnBuffer',
        'pauseOnBufferDelay',
        'modifyTabIcon',
        'autoReinjectSamePage',
        'role',
        'clientId',
        'hostClientId',
        'pendingNavigation',
        'sharedNavigation',
        'followResponses',
        'currentPlayback',
        'memberInjectionStatus',
    ],
    render,
);

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE') render(message.state);
});

// Advance the displayed clock while the popup is open between room updates.
setInterval(renderPlaybackProgress, 1000);
setInterval(() => {
    if (lastRenderedState?.role === 'host') {
        renderInjectionDebug(lastRenderedState);
    }
}, 1000);

getElement('server').addEventListener('change', () => {
    saveConfig();
    getElement('server').type = 'password';
    getElement('toggle-server').textContent = '显示';
    getElement('connection-settings').open = false;
    getElement('settings-summary').textContent = '连接设置（已配置）';
});

getElement('toggle-server').onclick = () => {
    const input = getElement('server');
    const shouldShow = input.type === 'password';

    input.type = shouldShow ? 'text' : 'password';
    getElement('toggle-server').textContent = shouldShow ? '隐藏' : '显示';
};

getElement('follow-yes').onclick = () => {
    chrome.runtime.sendMessage({ type: 'FOLLOW_DECISION', follow: true });
};

getElement('follow-no').onclick = () => {
    chrome.runtime.sendMessage({ type: 'FOLLOW_DECISION', follow: false });
};

getElement('auto-follow').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_AUTO_FOLLOW',
        enabled: getElement('auto-follow').checked,
    });
});

getElement('modify-tab-icon').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_TAB_ICON',
        enabled: getElement('modify-tab-icon').checked,
    });
});

getElement('auto-reinject-same-page').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_AUTO_REINJECT_SAME_PAGE',
        enabled: getElement('auto-reinject-same-page').checked,
    });
});

getElement('auto-pause').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_AUTO_PAUSE',
        enabled: getElement('auto-pause').checked,
        duration: getElement('auto-pause-duration').value,
    });
});

getElement('auto-pause-duration').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_AUTO_PAUSE',
        enabled: getElement('auto-pause').checked,
        duration: getElement('auto-pause-duration').value,
    });
});

getElement('pause-on-buffer').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_PAUSE_ON_BUFFER',
        enabled: getElement('pause-on-buffer').checked,
        delay: Number(getElement('pause-on-buffer-duration').value),
    });
});

getElement('pause-on-buffer-duration').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_PAUSE_ON_BUFFER',
        enabled: getElement('pause-on-buffer').checked,
        delay: Number(getElement('pause-on-buffer-duration').value),
    });
});

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

getElement('create').onclick = async () => {
    saveConfig();
    const tab = await getActiveTab();

    chrome.runtime.sendMessage({
        type: 'CREATE_ROOM',
        server: getElement('server').value.trim(),
        tabId: tab?.id,
    });
};

getElement('join').onclick = async () => {
    saveConfig();
    const tab = await getActiveTab();

    chrome.runtime.sendMessage({
        type: 'JOIN_ROOM',
        server: getElement('server').value.trim(),
        room: getElement('room-input').value.trim(),
        tabId: tab?.id,
    });
};

getElement('leave').onclick = () => {
    chrome.runtime.sendMessage({ type: 'LEAVE' });
};

getElement('refresh-my-injection').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REFRESH_MY_INJECTION' });
});

getElement('copy-room').onclick = async () => {
    await navigator.clipboard.writeText(getElement('room-code').textContent);
    statusElement.textContent = '房间码已复制。';
};
