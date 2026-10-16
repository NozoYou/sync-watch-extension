(() => {
    const enabled = document.getElementById('oped-enabled');
    const modes = [...document.querySelectorAll('input[name="oped-mode"]')];
    const server = document.getElementById('oped-server');
    const token = document.getElementById('oped-token');
    const message = document.getElementById('oped-status');

    async function save() {
        await chrome.storage.local.set({
            opedSettings: {
                enabled: enabled.checked,
                mode: modes.find(input => input.checked)?.value || 'local',
                server: server.value.trim(), token: token.value.trim(),
            },
            opedStatus: enabled.checked ? '打开 B 站番剧页面后自动检测。' : '音频识别已关闭。',
        });
    }
    chrome.storage.local.get(['opedSettings', 'opedStatus']).then(saved => {
        const settings = saved.opedSettings || {};
        enabled.checked = settings.enabled === true;
        for (const input of modes) {
            input.checked = input.value === (settings.mode === 'cloud' ? 'cloud' : 'local');
        }
        server.value = settings.server || '';
        token.value = settings.token || '';
        message.textContent = saved.opedStatus || '支持 B 站番剧，优先使用最低码率独立音轨。';
    });
    // Expansion is local UI state; changing modes never forces a panel open.
    for (const element of [enabled, ...modes, server, token]) {
        element.addEventListener('change', save);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.opedStatus) message.textContent = changes.opedStatus.newValue || '';
    });
})();
