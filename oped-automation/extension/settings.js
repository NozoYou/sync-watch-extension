(() => {
    const enabled = document.getElementById('oped-enabled');
    const modes = [...document.querySelectorAll('input[name="oped-mode"]')];
    const server = document.getElementById('oped-server');
    const token = document.getElementById('oped-token');
    const message = document.getElementById('oped-status');
    const redetect = document.getElementById('oped-redetect');
    redetect.addEventListener('click', async () => {
        redetect.disabled = true;
        try {
            const reply = await chrome.runtime.sendMessage({ type: 'OPED_REDETECT' });
            message.textContent = reply?.error || (reply?.pending
                ? '已开始重新识别当前系列，完成后逐批上报结果。'
                : '重新识别未启动，请确认识别已开启且当前页面可访问。');
        } catch (error) {
            message.textContent = `重新识别未启动：${error.message}`;
        } finally {
            redetect.disabled = false;
        }
    });

    async function save() {
        redetect.disabled = !enabled.checked;
        await chrome.storage.local.set({
            opedSettings: {
                enabled: enabled.checked,
                mode: modes.find(input => input.checked)?.value || 'local',
                server: server.value.trim(), token: token.value.trim(),
            },
            opedStatus: enabled.checked ? '打开 B 站、AGE、樱花或 OmoFun 支持的连续剧集页面后自动检测。' : '音频识别已关闭。',
        });
    }
    chrome.storage.local.get(['opedSettings', 'opedStatus']).then(saved => {
        const settings = saved.opedSettings || {};
        enabled.checked = settings.enabled === true;
        redetect.disabled = !enabled.checked;
        for (const input of modes) {
            input.checked = input.value === (settings.mode === 'cloud' ? 'cloud' : 'local');
        }
        server.value = settings.server || '';
        token.value = settings.token || '';
        message.textContent = saved.opedStatus || '支持 B 站及 AGE、樱花、OmoFun 可解析的连续剧集；优先独立音轨。';
    });
    // Expansion is local UI state; changing modes never forces a panel open.
    for (const element of [enabled, ...modes, server, token]) {
        element.addEventListener('change', save);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.opedStatus) message.textContent = changes.opedStatus.newValue || '';
    });
})();
