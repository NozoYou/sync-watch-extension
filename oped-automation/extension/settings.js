(() => {
    const enabled = document.getElementById('oped-enabled');
    const mode = document.getElementById('oped-mode');
    const server = document.getElementById('oped-server');
    const token = document.getElementById('oped-token');
    const message = document.getElementById('oped-status');
    const cloud = document.getElementById('oped-cloud-settings');

    async function save() {
        cloud.hidden = false;
        await chrome.storage.local.set({
            opedSettings: {
                enabled: enabled.checked, mode: mode.value,
                server: server.value.trim(), token: token.value.trim(),
            },
            opedStatus: enabled.checked ? '打开 B 站番剧页面后自动检测。' : '音频识别已关闭。',
        });
    }
    chrome.storage.local.get(['opedSettings', 'opedStatus']).then(saved => {
        const settings = saved.opedSettings || {};
        enabled.checked = settings.enabled === true;
        mode.value = settings.mode === 'cloud' ? 'cloud' : 'local';
        server.value = settings.server || '';
        token.value = settings.token || '';
        cloud.hidden = false;
        message.textContent = saved.opedStatus || '支持 B 站番剧，优先使用最低码率独立音轨。';
    });
    for (const element of [enabled, mode, server, token]) element.addEventListener('change', save);
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.opedStatus) message.textContent = changes.opedStatus.newValue || '';
    });
})();
