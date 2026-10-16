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

function log(jobId, step, details = {}) {
    // Forward logs to the service worker console, which is easier to inspect.
    chrome.runtime.sendMessage({ type: 'OPED_LOG', jobId, step, details }).catch(() => {});
}

async function readAudio(url, signal) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.bilivideo.com')) {
        throw new Error('音频地址不属于支持的 B 站媒体域名。');
    }
    // Audio is transient input; do not retain another copy in the HTTP cache.
    const response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`音轨下载失败（${response.status}）。`);
    log(currentJobId, '音轨响应已连接', { status: response.status });
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let lastReportedMB = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        const downloadedMB = Math.floor(size / (1024 * 1024));
        if (downloadedMB > lastReportedMB) {
            lastReportedMB = downloadedMB;
            log(currentJobId, '音轨下载进度', { downloadedMB });
        }
        if (size > 64 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('音轨超过 64 MB，已停止下载。');
        }
        chunks.push(value);
    }
    log(currentJobId, '音轨下载完成', { bytes: size });
    const buffer = await new Blob(chunks).arrayBuffer();
    chunks.length = 0;
    reader.releaseLock();
    return buffer;
}

let currentJobId = '';

async function extractEpisodeAudio(episode, jobId, signal) {
    const label = `第 ${episode.number} 集`;
    await chrome.runtime.sendMessage({ type: 'OPED_PROGRESS', jobId, message: `正在获取${label}低码率音频…` });
    log(jobId, `${label}：开始下载低码率音轨`, { bandwidth: episode.bandwidth });
    let bytes = await readAudio(episode.audioUrl, signal);
    log(jobId, `${label}：开始解码音轨`);
    let context = new OfflineAudioContext(1, 1, 8000);
    let decoded = await context.decodeAudioData(bytes);
    bytes = null;
    context = null;
    if (decoded.duration > 3600) throw new Error('暂仅支持单集一小时以内的内容。');
    log(jobId, `${label}：音轨解码完成`, {
        durationSeconds: Math.round(decoded.duration),
        channels: decoded.numberOfChannels,
        sampleRate: decoded.sampleRate,
    });
    const samples = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const data = decoded.getChannelData(channel);
        for (let i = 0; i < samples.length; i += 1) samples[i] += data[i] / decoded.numberOfChannels;
    }
    decoded = null;
    if (signal.aborted) throw new Error('检测已取消。');
    log(jobId, `${label}：开始提取音频特征`);
    // Transfer sample ownership to the short-lived worker, then terminate it.
    const features = await compute({ type: 'extract', samples: samples.buffer }, [samples.buffer], signal);
    log(jobId, `${label}：特征提取完成，原始音频数据已释放`, {
        featureFrames: features.features?.length || 0,
    });
    return { id: episode.id, ...features };
}

async function run(job) {
    const control = new AbortController();
    running = control;
    currentJobId = job.jobId;
    const timer = setTimeout(() => control.abort(), 15 * 60 * 1000);
    const heartbeat = setInterval(() => chrome.runtime.sendMessage({ type: 'OPED_HEARTBEAT', jobId: job.jobId }).catch(() => {}), 20000);
    const episodes = [];
    try {
        log(job.jobId, '开始浏览器本地音频处理', { episodeCount: job.episodes.length });
        for (const episode of job.episodes) {
            episodes.push(await extractEpisodeAudio(episode, job.jobId, control.signal));
        }
        if (control.signal.aborted) throw new Error('检测已取消。');
        await chrome.runtime.sendMessage({ type: 'OPED_PROGRESS', jobId: job.jobId, message: '正在比对三集音频…' });
        log(job.jobId, '开始比对三集 OP/ED 音频特征');
        let result;
        if (job.settings.mode === 'cloud') {
            log(job.jobId, '正在将音频特征发送到云端进行比对');
            const response = await fetch(`${job.settings.server.replace(/\/$/, '')}/detect`, {
                method: 'POST', signal: control.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.settings.token}` },
                body: JSON.stringify({ episodes, metadata: job.metadata }),
            });
            if (!response.ok) throw new Error(`云端检测失败（${response.status}）。`);
            log(job.jobId, '云端比对响应成功', { status: response.status });
            result = await response.json();
        } else {
            log(job.jobId, '在本地浏览器中运行 OP/ED 比对');
            result = await compute({ type: 'detect', episodes }, [], control.signal);
        }
        log(job.jobId, 'OP/ED 比对完成', {
            matchedSegments: result.episodes?.reduce((count, item) => count + (item.segments?.length || 0), 0) || 0,
        });
        episodes.length = 0;
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
                log(job.jobId, '云端记录上传完成', { status: response.status, saved: response.ok });
            } catch {
                recordStatus = 'failed';
                log(job.jobId, '云端记录上传失败');
            }
        }
        if (!control.signal.aborted) {
            await chrome.runtime.sendMessage({
                type: 'OPED_COMPLETE', jobId: job.jobId, result, recordStatus,
                metadata: job.metadata,
                episodeIds: job.episodes.map(item => item.id),
            });
        }
    } catch (error) {
        log(job.jobId, '本地分析流程发生错误', { message: control.signal.aborted ? '检测已取消或超时。' : error.message });
        await chrome.runtime.sendMessage({ type: 'OPED_FAILED', jobId: job.jobId, message: control.signal.aborted ? '检测已取消。' : error.message }).catch(() => {});
    } finally {
        clearTimeout(timer);
        clearInterval(heartbeat);
        episodes.length = 0;
        running = null;
        currentJobId = '';
        await chrome.runtime.sendMessage({ type: 'OPED_IDLE', jobId: job.jobId }).catch(() => {});
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
