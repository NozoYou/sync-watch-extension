const getElement = (id) => document.getElementById(id);
const statusElement = getElement('status');
let renderedHistorySignature = '';
let currentPlayback = null;
let lastRenderedState = null;
let memberSearchQuery = '';
let selectedPermissionTemplate = '';
let displayNameEdited = false;
let pendingDisplayNameSave = null;
let displayNameComposing = false;
let selectedUiStyle = '1';

function applyUiStyle(style) {
    selectedUiStyle = style === '2' ? '2' : '1';
    document.body.classList.toggle('style-2', selectedUiStyle === '2');
    getElement('ui-style').value = selectedUiStyle;
}

function updateLocalGreeting() {
    const hour = new Date().getHours();
    let greeting = '晚上好';

    if (hour >= 5 && hour < 11) greeting = '早上好';
    else if (hour >= 11 && hour < 13) greeting = '中午好';
    else if (hour >= 13 && hour < 18) greeting = '下午好';

    getElement('local-greeting').textContent = greeting;
}

function setDisplayNameEditing(isEditing) {
    getElement('display-name-trigger').classList.toggle('hidden', isEditing);
    getElement('display-name-editor').classList.toggle('hidden', !isEditing);

    if (isEditing) {
        getElement('display-name').focus();
        getElement('display-name').select();
    }
}

function formatPlaybackTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = String(safeSeconds % 60).padStart(2, '0');

    return `${minutes}:${remainder}`;
}

function renderPlaybackProgress() {
    const panel = getElement('room-playback');
    const videoUrl = safeHistoryUrl(
        lastRenderedState?.sharedNavigation?.url || currentPlayback?.url,
    );

    panel.classList.toggle('is-openable', !!videoUrl);
    panel.setAttribute('aria-disabled', String(!videoUrl));
    panel.tabIndex = videoUrl ? 0 : -1;
    panel.title = videoUrl ? '点击在当前标签页打开房间正在播放的视频' : '';

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
          Math.max(
              0,
              (Date.now() -
                  (Number(currentPlayback.receivedAt) || currentPlayback.at)) /
                  1000,
          ) *
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

function renderSavedProgress(state) {
    const list = getElement('saved-progress-list');
    const items = Array.isArray(state.savedProgress) ? state.savedProgress : [];
    const canSave = !!state.room && !!state.connected && !!state.currentPlayback;

    getElement('saved-progress-summary').textContent = items.length
        ? `本地保存的进度（${items.length}）`
        : '本地保存的进度';
    getElement('save-current-progress').disabled = !canSave;
    getElement('save-current-progress').title = canSave
        ? '保存房间当前视频和播放进度'
        : '加入已连接的房间并显示播放进度后即可保存';
    getElement('saved-progress-empty').classList.toggle(
        'hidden',
        items.length > 0,
    );
    list.replaceChildren();

    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'saved-progress-item';

        const details = document.createElement('div');
        details.className = 'saved-progress-details';

        const title = document.createElement('strong');
        title.textContent = item.title || '已保存的视频';
        title.title = item.url;

        const time = document.createElement('span');
        time.textContent = `进度 ${formatPlaybackTime(item.time)}`;
        details.append(title, time);

        const actions = document.createElement('div');
        actions.className = 'saved-progress-actions';
        const openButton = document.createElement('button');
        openButton.className = 'quiet';
        openButton.type = 'button';
        openButton.textContent = '打开';
        openButton.title = '在新标签页打开并定位到保存进度';
        openButton.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'OPEN_SAVED_PROGRESS',
                id: item.id,
            });
        });

        const removeButton = document.createElement('button');
        removeButton.className = 'quiet';
        removeButton.type = 'button';
        removeButton.textContent = '删除';
        removeButton.title = '删除这条本地记录';
        removeButton.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'DELETE_SAVED_PROGRESS',
                id: item.id,
            });
        });

        actions.append(openButton, removeButton);
        row.append(details, actions);
        list.append(row);
    }
}

async function openRoomVideoInCurrentTab() {
    const videoUrl = safeHistoryUrl(
        lastRenderedState?.sharedNavigation?.url || currentPlayback?.url,
    );
    if (!videoUrl) return;

    // Let the background pause and gate playback before navigating this tab.
    const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    chrome.runtime.sendMessage({
        type: 'OPEN_ROOM_VIDEO',
        url: videoUrl,
        tabId: activeTab?.id,
    });
}

getElement('room-playback').addEventListener('click', () => {
    openRoomVideoInCurrentTab();
});

getElement('room-playback').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;

    event.preventDefault();
    openRoomVideoInCurrentTab();
});

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

    const templateSelect = getElement('member-settings-template');
    const currentTemplate = selectedPermissionTemplate;
    templateSelect.replaceChildren();

    for (const [index, clientId] of members.entries()) {
        const option = document.createElement('option');
        option.value = clientId;
        option.textContent = `${getMemberDisplayName(state, clientId, index)} · ${clientId.slice(-6)}`;
        templateSelect.append(option);
    }

    if (members.includes(currentTemplate)) {
        templateSelect.value = currentTemplate;
    } else if (members.length) {
        selectedPermissionTemplate = members[0];
        templateSelect.value = selectedPermissionTemplate;
    }

    getElement('apply-member-settings-all').disabled =
        !state.connected || members.length < 2;

    settingsList.replaceChildren();

    for (const [index, clientId] of members.entries()) {
        const displayName = getMemberDisplayName(state, clientId, index);
        const searchable = `${displayName} ${clientId}`.toLowerCase();
        if (memberSearchQuery && !searchable.includes(memberSearchQuery)) continue;

        const settings = {
            canControlPlayback: true,
            canSeek: true,
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
        name.textContent = `${displayName} · ${clientId.slice(-6)}`;

        const options = document.createElement('div');
        options.className = 'member-setting-options';

        const fields = [
            ['canControlPlayback', '播放 / 暂停'],
            ['canSeek', '进度条跳转'],
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

        card.append(name, options);
        settingsList.append(card);
    }

    settingsPanel.classList.toggle(
        'hidden',
        state.role !== 'host' || members.length === 0,
    );
}

function getMemberDisplayName(state, clientId, index = 0) {
    if (clientId === state.hostClientId) {
        return state.memberNames?.[clientId] || '房主';
    }

    return state.memberNames?.[clientId] || `成员 ${index + 1}`;
}

function renderRoomMemberList(state) {
    const list = getElement('room-member-list');
    list.replaceChildren();

    for (const [index, clientId] of (state.members || []).entries()) {
        const chip = document.createElement('span');
        chip.className = 'room-member-chip';
        const isHost = clientId === state.hostClientId;
        chip.textContent = `${getMemberDisplayName(state, clientId, index)}${isHost ? ' · 房主' : ''}`;
        chip.title = clientId;
        list.append(chip);
    }
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
            statusLabel = '正在刷新';
        } else if (report?.refreshError) {
            statusLabel = '刷新失败';
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
        refreshButton.className = 'icon-button';
        refreshButton.textContent = '↻';
        refreshButton.setAttribute('aria-label', '刷新成员同步');
        refreshButton.title = isRefreshing ? '正在刷新' : '刷新成员同步';
        refreshButton.classList.toggle('is-refreshing', !!isRefreshing);
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
    getElement('tab-settings').classList.toggle('hidden', !isInRoom);
    refreshButton.classList.toggle('hidden', !isInRoom);
    if (!isInRoom) return;

    autoReinjectToggle.checked = !!state.autoReinjectSamePage;

    if (report?.refreshing) {
        statusLabel.textContent = '正在刷新同步…';
    } else if (report?.refreshError) {
        statusLabel.textContent = `刷新失败：${report.refreshError}`;
    } else if (report?.responsive && report.hasVideo) {
        statusLabel.textContent = report.videoBound
            ? '当前视频已连接同步。'
            : '已找到视频，正在连接同步。';
    } else if (report?.responsive) {
        statusLabel.textContent = '当前页面暂未发现视频。';
    } else {
        statusLabel.textContent =
            '可刷新当前页的同步状态。';
    }

    refreshButton.disabled = !state.connected || !!report?.refreshing;
    refreshButton.textContent = '↻';
    refreshButton.classList.toggle('is-refreshing', !!report?.refreshing);
    refreshButton.title = report?.refreshing ? '正在刷新' : '刷新当前页同步';
    refreshButton.setAttribute('aria-label', refreshButton.title);
}

function renderShareHistory(history = []) {
    const panels = [
        {
            panel: getElement('share-history'),
            recentList: getElement('recent-share-list'),
            olderList: getElement('older-share-list'),
            openInCurrentTab: false,
        },
        {
            panel: getElement('share-history-current'),
            recentList: getElement('recent-share-current-list'),
            olderList: getElement('older-share-current-list'),
            openInCurrentTab: true,
        },
    ];
    const newestFirst = [...history].slice(0, 15);
    const signature = JSON.stringify(newestFirst);

    // Keep expanded entries open during unrelated popup state updates.
    if (signature === renderedHistorySignature) return;
    renderedHistorySignature = signature;
    const recent = newestFirst.slice(0, 3);
    const older = newestFirst.slice(3);

    function createOpenButton(navigation, currentTab = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quiet share-history-open';
        button.textContent = currentTab ? '当前页' : '↗ 新标签页';
        button.title = currentTab
            ? '在当前标签页打开此视频'
            : '在新标签页打开此视频';
        button.addEventListener('click', () => {
            const url = safeHistoryUrl(navigation.url);
            if (!url) return;

            if (currentTab) {
                chrome.tabs.update({ url });
            } else {
                chrome.tabs.create({ url });
            }
        });
        return button;
    }

    function createHistoryRow(navigation, targetList, openInCurrentTab) {
        const row = document.createElement('div');
        row.className = 'share-history-item';
        const main = document.createElement('div');
        main.className = 'share-history-item-main';

        if (openInCurrentTab) {
            const title = document.createElement('a');
            title.className = 'share-history-current-title';
            title.href = safeHistoryUrl(navigation.url) || '#';
            title.title = navigation.url || '';
            title.textContent = navigation.title || navigation.url || '未命名视频';
            title.addEventListener('click', (event) => {
                event.preventDefault();
                const url = safeHistoryUrl(navigation.url);
                if (url) chrome.tabs.update({ url });
            });
            main.append(title);
        } else {
            const details = document.createElement('details');
            const title = document.createElement('summary');
            title.className = 'share-history-title';
            title.textContent = navigation.title || navigation.url || '未命名视频';

            const link = document.createElement('a');
            link.className = 'share-history-url';
            link.href = safeHistoryUrl(navigation.url) || '#';
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.textContent = navigation.url || '';

            details.append(title, link);
            main.append(details);
        }

        const actions = document.createElement('div');
        actions.className = 'share-history-actions';
        actions.append(createOpenButton(navigation));

        if (!openInCurrentTab) {
            actions.prepend(createOpenButton(navigation, true));
        }

        row.append(main, actions);
        targetList.append(row);
    }

    for (const view of panels) {
        view.recentList.replaceChildren();
        view.olderList.replaceChildren();
        view.panel.classList.toggle('hidden', newestFirst.length === 0);
        view.olderList.classList.toggle('hidden', older.length === 0);

        for (const navigation of recent) {
            createHistoryRow(
                navigation,
                view.recentList,
                view.openInCurrentTab,
            );
        }

        for (const navigation of older) {
            createHistoryRow(
                navigation,
                view.olderList,
                view.openInCurrentTab,
            );
        }
    }
}

function renderRecommendations(state) {
    const panel = getElement('recommendations-panel');
    const list = getElement('recommendations-list');
    const items = state.role === 'host'
        ? (state.receivedRecommendations || []).slice(0, 20)
        : [];

    panel.classList.toggle('hidden', items.length === 0);
    getElement('recommendations-summary').textContent =
        `成员推荐（${items.length}）`;
    list.replaceChildren();

    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'recommendation-item';

        const details = document.createElement('div');
        details.className = 'recommendation-details';

        const title = document.createElement('strong');
        title.className = 'recommendation-title';
        title.textContent = item.title || '未命名页面';

        const source = document.createElement('span');
        source.className = 'recommendation-source';
        source.textContent = `${item.name || '成员'} 推荐 · ${item.hostname || ''}`;

        const actions = document.createElement('div');
        actions.className = 'recommendation-actions';

        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'quiet';
        openButton.textContent = '打开';
        openButton.title = `在新标签页打开 ${item.hostname || '推荐页面'}`;
        openButton.addEventListener('click', () => {
            const url = safeHistoryUrl(item.url);
            if (url) chrome.tabs.create({ url });
        });

        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.className = 'quiet';
        dismissButton.textContent = '移除';
        dismissButton.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'DISMISS_RECOMMENDATION',
                id: item.id,
            });
        });

        details.append(title, source);
        actions.append(openButton, dismissButton);
        row.append(details, actions);
        list.append(row);
    }
}

function syncRecommendationButtonVisibility(state) {
    const button = getElement('recommend-page');
    const isInRoom = !!state.room && state.role !== 'host';
    button.classList.toggle('hidden', !isInRoom);

    if (!isInRoom) return;

    button.disabled = !state.connected;
    button.title = state.connected
        ? '推荐当前页面给房主'
        : '连接房间后即可推荐';
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
    renderSavedProgress(state);
    syncRecommendationButtonVisibility(state);

    const savedDisplayName = String(state.displayName || '').trim();
    getElement('display-name-label').textContent = savedDisplayName || '成员';
    updateLocalGreeting();

    const displayNameInput = getElement('display-name');
    if (pendingDisplayNameSave !== null) {
        displayNameInput.value = pendingDisplayNameSave;

        if (state.displayName === pendingDisplayNameSave) {
            pendingDisplayNameSave = null;
            displayNameEdited = false;
        }
    } else if (
        !displayNameEdited &&
        document.activeElement !== displayNameInput &&
        displayNameInput.value !== (state.displayName || '')
    ) {
        // Background updates must not erase text while the user is editing.
        displayNameInput.value = state.displayName || '';
    }

    if (state.server) {
        getElement('server').value = state.server;
        getElement('settings-summary').textContent = '连接设置（已配置）';
    } else {
        getElement('settings-summary').textContent = '连接设置（请先填写服务器地址）';
        getElement('connection-settings').open = true;
    }

    if (state.room) {
        getElement('room-box').classList.remove('hidden');
        getElement('playback-settings').classList.remove('hidden');
        getElement('room-code').textContent = state.room;
        getElement('room-connection').textContent = state.connected
            ? '已连接'
            : '连接中 / 正在重连';
        getElement('room-members').textContent =
            `房间人数：${state.memberCount || 0}/${state.roomLimit || 4}`;
        renderRoomMemberList(state);

        const isGuest = state.role !== 'host';
        const isHost = state.role === 'host';
        getElement('member-follow-settings').classList.remove('hidden');
        getElement('host-sharing-settings').classList.toggle('hidden', !isHost);
        getElement('auto-share').checked = !!state.autoShare;
        getElement('auto-share').disabled = !state.connected;
        getElement('share-current-page').disabled = !state.connected;
        getElement('auto-follow').checked =
            typeof state.memberSettings?.[state.clientId]?.autoFollow === 'boolean'
                ? state.memberSettings[state.clientId].autoFollow
                : true;
        getElement('auto-follow').disabled = !state.connected;
        getElement('follow-prompt-enabled').checked =
            state.followPromptEnabled !== false;
        getElement('follow-prompt-enabled').disabled = !state.connected;
        getElement('modify-tab-icon').checked = !!state.modifyTabIcon;
        getElement('modify-tab-icon').disabled = false;
        renderHostMemberSettings(state);
        renderInjectionDebug(state);
        renderSelfInjectionControl(state);

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
        renderRecommendations(state);

    } else {
        getElement('room-box').classList.add('hidden');
        getElement('room-member-list').replaceChildren();
        getElement('room-playback').classList.add('hidden');
        getElement('member-follow-settings').classList.add('hidden');
        getElement('host-sharing-settings').classList.add('hidden');
        getElement('auto-share').checked = false;
        getElement('auto-share').disabled = true;
        getElement('share-current-page').disabled = true;
        getElement('modify-tab-icon').checked = !!state.modifyTabIcon;
        getElement('modify-tab-icon').disabled = true;
        getElement('host-member-settings').classList.add('hidden');
        getElement('injection-debug').classList.add('hidden');
        getElement('self-injection-control').classList.add('hidden');
        getElement('tab-settings').classList.add('hidden');
        getElement('playback-settings').classList.add('hidden');
        getElement('refresh-my-injection').classList.add('hidden');
        getElement('auto-pause-panel').classList.add('hidden');
        getElement('pause-on-buffer').checked = false;
        getElement('pause-on-buffer').disabled = true;
        getElement('pause-on-buffer-duration').value = '5';
        getElement('pause-on-buffer-duration').disabled = true;
        getElement('pause-on-buffer-owner').classList.add('hidden');
        getElement('share-history').classList.add('hidden');
        getElement('share-history-current').classList.add('hidden');
        getElement('recommendations-panel').classList.add('hidden');
    }

    if (state.recommendationStatus) {
        statusElement.textContent = state.recommendationStatus;
    } else if (state.status) {
        statusElement.textContent = state.status;
    }
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
        'receivedRecommendations',
        'recommendationStatus',
        'autoPause',
        'pauseOnBuffer',
        'pauseOnBufferDelay',
        'modifyTabIcon',
        'autoReinjectSamePage',
        'hasSeenFollowPrompt',
        'followPromptEnabled',
        'role',
        'clientId',
        'hostClientId',
        'displayName',
        'pendingNavigation',
        'sharedNavigation',
        'followResponses',
        'currentPlayback',
        'savedProgress',
        'autoShare',
        'memberInjectionStatus',
        'memberNames',
    ],
    render,
);

chrome.storage.local.get('uiStyle', ({ uiStyle }) => {
    applyUiStyle(uiStyle);
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE') render(message.state);
});

// Advance the displayed clock while the popup is open between room updates.
setInterval(renderPlaybackProgress, 1000);

getElement('save-current-progress').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SAVE_CURRENT_PROGRESS' });
});
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

getElement('auto-follow').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_AUTO_FOLLOW',
        enabled: getElement('auto-follow').checked,
    });
});

getElement('auto-share').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_AUTO_SHARE',
        enabled: getElement('auto-share').checked,
    });
});

getElement('share-current-page').addEventListener('click', async () => {
    const tab = await getActiveTab();
    chrome.runtime.sendMessage({
        type: 'SHARE_CURRENT_PAGE',
        tabId: tab?.id,
    });
});

getElement('follow-prompt-enabled').addEventListener('change', () => {
    chrome.runtime.sendMessage({
        type: 'SET_FOLLOW_PROMPT_ENABLED',
        enabled: getElement('follow-prompt-enabled').checked,
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
    const requestedLimit = Number(getElement('room-capacity').value);
    const roomLimit = Number.isInteger(requestedLimit)
        ? Math.max(4, Math.min(16, requestedLimit))
        : 4;
    getElement('room-capacity').value = roomLimit;
    const tab = await getActiveTab();

    chrome.runtime.sendMessage({
        type: 'CREATE_ROOM',
        server: getElement('server').value.trim(),
        roomLimit,
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

const menuToggle = getElement('menu-toggle');
const mainMenuPanel = getElement('main-menu-panel');
const savedProgressToggle = getElement('saved-progress-toggle');
const savedProgressPanel = getElement('saved-progress-panel');

getElement('ui-style').addEventListener('change', (event) => {
    applyUiStyle(event.target.value);
    chrome.storage.local.set({ uiStyle: selectedUiStyle });
});

function setMenuOpen(isOpen) {
    mainMenuPanel.classList.toggle('hidden', !isOpen);
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) setSavedProgressOpen(false);
}

function setSavedProgressOpen(isOpen) {
    savedProgressPanel.classList.toggle('hidden', !isOpen);
    savedProgressPanel.open = isOpen;
    savedProgressToggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) setMenuOpen(false);
}

menuToggle.addEventListener('click', () => {
    setMenuOpen(mainMenuPanel.classList.contains('hidden'));
});

savedProgressToggle.addEventListener('click', () => {
    setSavedProgressOpen(savedProgressPanel.classList.contains('hidden'));
});

document.addEventListener('click', (event) => {
    if (
        !mainMenuPanel.contains(event.target) &&
        !menuToggle.contains(event.target)
    ) {
        setMenuOpen(false);
    }

    if (
        !savedProgressPanel.contains(event.target) &&
        !savedProgressToggle.contains(event.target)
    ) {
        setSavedProgressOpen(false);
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        setMenuOpen(false);
        setSavedProgressOpen(false);
    }
});

getElement('copy-room').onclick = async () => {
    await navigator.clipboard.writeText(getElement('room-code').textContent);
    statusElement.textContent = '房间码已复制。';
};

getElement('recommend-page').addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.url) {
        chrome.runtime.sendMessage({
            type: 'RECOMMEND_ACTIVE_PAGE',
            url: '',
            title: '',
        });
        return;
    }

    chrome.runtime.sendMessage({
        type: 'RECOMMEND_ACTIVE_PAGE',
        url: tab.url,
        title: tab.title || '',
    });
});

getElement('display-name-trigger').addEventListener('click', () => {
    setDisplayNameEditing(true);
});

getElement('save-display-name').addEventListener('click', () => {
    const name = getElement('display-name').value.trim().slice(0, 24);
    const savedName = name || '成员';
    pendingDisplayNameSave = name || '成员';
    displayNameEdited = false;
    chrome.storage.local.set({ displayName: savedName });
    chrome.runtime.sendMessage({ type: 'SET_DISPLAY_NAME', name });
    getElement('display-name').value = savedName;
    getElement('display-name-label').textContent = savedName;
    setDisplayNameEditing(false);
    statusElement.textContent = name
        ? '房间显示名称已保存。'
        : '名称已清空，将显示为“成员”。';
});

getElement('display-name').addEventListener('input', () => {
    displayNameEdited = true;
});

getElement('display-name').addEventListener('compositionstart', () => {
    displayNameComposing = true;
});

getElement('display-name').addEventListener('compositionend', () => {
    displayNameComposing = false;
});

getElement('display-name').addEventListener('keydown', (event) => {
    const isImeConfirm =
        displayNameComposing || event.isComposing || event.keyCode === 229;

    // Enter confirms the IME candidate first; only a later Enter saves the name.
    if (event.key === 'Enter' && !isImeConfirm) {
        event.preventDefault();
        getElement('save-display-name').click();
    }

    if (event.key === 'Escape') {
        displayNameEdited = false;
        getElement('display-name').value = lastRenderedState?.displayName || '';
        setDisplayNameEditing(false);
    }
});

updateLocalGreeting();
setInterval(updateLocalGreeting, 60_000);

getElement('member-search').addEventListener('input', (event) => {
    memberSearchQuery = event.target.value.trim().toLowerCase();
    if (lastRenderedState) renderHostMemberSettings(lastRenderedState);
});

getElement('member-settings-template').addEventListener('change', (event) => {
    selectedPermissionTemplate = event.target.value;
});

getElement('apply-member-settings-all').addEventListener('click', () => {
    if (!lastRenderedState) return;
    const sourceClientId = getElement('member-settings-template').value;
    const keys = [
        'canControlPlayback',
        'canSeek',
        'canManageAutoPause',
        'canManagePauseOnBuffer',
    ];
    const settings = lastRenderedState.memberSettings?.[sourceClientId] || {};

    chrome.runtime.sendMessage({
        type: 'APPLY_MEMBER_SETTINGS_TO_ROOM',
        sourceClientId,
        settings: Object.fromEntries(keys.map((key) => [key, !!settings[key]])),
    });
    statusElement.textContent = '已将该成员的权限应用给其他成员。';
});
