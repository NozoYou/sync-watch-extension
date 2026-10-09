const getElement = (id) => document.getElementById(id);
const statusElement = getElement('status');

function getConfig() {
    return {
        server: getElement('server').value.trim(),
    };
}

function saveConfig() {
    const config = getConfig();

    // Store configuration locally and notify the service worker immediately.
    chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', ...config });
    chrome.storage.local.set(config);
}

function render(state) {
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
        'hostClientId',
        'pendingNavigation',
        'sharedNavigation',
        'followResponses',
    ],
    render,
);

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE') render(message.state);
});

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

getElement('copy-room').onclick = async () => {
    await navigator.clipboard.writeText(getElement('room-code').textContent);
    statusElement.textContent = '房间码已复制。';
};
