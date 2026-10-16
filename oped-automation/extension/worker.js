importScripts('audio-core.js');

self.onmessage = ({ data }) => {
    try {
        const result = data.type === 'extract'
            ? SyncWatchOpedAudio.extract(new Float32Array(data.samples))
            : SyncWatchOpedAudio.detect(data.episodes);
        self.postMessage({ result });
    } catch {
        self.postMessage({ error: '音频特征处理失败。' });
    }
};
