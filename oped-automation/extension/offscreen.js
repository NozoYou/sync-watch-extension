let running = null;

function compute(message, transfers = [], signal) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('worker.js');
        const timer = setTimeout(() => finish(new Error('音频分析超时。')), 180000);
        function finish(error, result) {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            worker.terminate();
            if (error) reject(error);
            else resolve(result);
        }
        const cancel = () => finish(new Error('检测已取消。'));
        if (signal?.aborted) return cancel();
        signal?.addEventListener('abort', cancel, { once: true });
        worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
        worker.onerror = () => finish(new Error('音频分析线程失败。'));
        worker.postMessage(message, transfers);
    });
}

async function readAudio(url, signal) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.bilivideo.com')) {
        throw new Error('音频地址不属于支持的 B 站媒体域名。');
    }
    const response = await fetch(url, { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`音轨下载失败（${response.status}）。`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('音轨超过 64 MB，已停止下载。');
        }
        chunks.push(value);
    }
    return new Blob(chunks).arrayBuffer();
}

async function run(job) {
    const control = new AbortController();
    running = control;
    const timer = setTimeout(() => control.abort(), 15 * 60 * 1000);
    const heartbeat = setInterval(() => chrome.runtime.sendMessage({ type: 'OPED_HEARTBEAT', jobId: job.jobId }).catch(() => {}), 20000);
    try {
        const episodes = [];
        for (const episode of job.episodes) {
            await chrome.runtime.sendMessage({ type: 'OPED_PROGRESS', jobId: job.jobId, message: `正在获取第 ${episode.number} 集低码率音频…` });
            const bytes = await readAudio(episode.audioUrl, control.signal);
            const context = new OfflineAudioContext(1, 1, 8000);
            const decoded = await context.decodeAudioData(bytes);
            if (decoded.duration > 3600) throw new Error('暂仅支持单集一小时以内的内容。');
            const samples = new Float32Array(decoded.length);
            for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
                const data = decoded.getChannelData(channel);
                for (let i = 0; i < samples.length; i += 1) samples[i] += data[i] / decoded.numberOfChannels;
            }
            if (control.signal.aborted) throw new Error('检测已取消。');
            const features = await compute({ type: 'extract', samples: samples.buffer }, [samples.buffer], control.signal);
            episodes.push({ id: episode.id, ...features });
        }
        if (control.signal.aborted) throw new Error('检测已取消。');
        await chrome.runtime.sendMessage({ type: 'OPED_PROGRESS', jobId: job.jobId, message: '正在比对三集音频…' });
        let result;
        if (job.settings.mode === 'cloud') {
            const response = await fetch(`${job.settings.server.replace(/\/$/, '')}/detect`, {
                method: 'POST', signal: control.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.settings.token}` },
                body: JSON.stringify({ episodes, metadata: job.metadata }),
            });
            if (!response.ok) throw new Error(`云端检测失败（${response.status}）。`);
            result = await response.json();
        } else {
            result = await compute({ type: 'detect', episodes }, [], control.signal);
        }
        let recordStatus = result.recordStatus || 'not_configured';
        if (job.settings.mode !== 'cloud' && job.settings.server && job.settings.token) {
            try {
                const server = new URL(job.settings.server);
                const isLocal = server.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(server.hostname);
                if (server.protocol !== 'https:' && !isLocal) throw new Error('Invalid record server.');
                // Local analysis uploads only the result and viewing metadata.
                const response = await fetch(`${job.settings.server.replace(/\/$/, '')}/records`, {
                    method: 'POST', signal: AbortSignal.any([control.signal, AbortSignal.timeout(15000)]),
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.settings.token}` },
                    body: JSON.stringify({ metadata: job.metadata, result }),
                });
                recordStatus = response.ok ? 'saved' : 'failed';
            } catch {
                recordStatus = 'failed';
            }
        }
        if (!control.signal.aborted) {
            await chrome.runtime.sendMessage({ type: 'OPED_COMPLETE', jobId: job.jobId, result, recordStatus, episodeIds: job.episodes.map(item => item.id) });
        }
    } catch (error) {
        await chrome.runtime.sendMessage({ type: 'OPED_FAILED', jobId: job.jobId, message: control.signal.aborted ? '检测已取消。' : error.message }).catch(() => {});
    } finally {
        clearTimeout(timer);
        clearInterval(heartbeat);
        running = null;
    }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'OPED_RUN') {
        if (running) respond({ success: false });
        else {
            void run(message.job);
            respond({ success: true });
        }
    } else if (message.type === 'OPED_CANCEL') {
        running?.abort();
        respond({ success: true });
    }
});
