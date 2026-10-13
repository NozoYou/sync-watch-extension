(() => {
    function nonNegativeNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, number) : 0;
    }

    function getProgress(playback, options = {}) {
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const duration = nonNegativeNumber(playback?.duration);
        const baseTime = nonNegativeNumber(playback?.time);
        const receivedAt = Number(playback?.receivedAt) || Number(playback?.at) || now;
        const rate = nonNegativeNumber(playback?.rate) || 1;
        const awaitingSync = playback?.awaitingSync === true ||
            options.connected === false;
        const canAdvance = !awaitingSync && playback?.paused !== true &&
            playback?.buffering !== true && playback?.ended !== true;
        const elapsed = canAdvance
            ? Math.max(0, (now - receivedAt) / 1000) * rate
            : 0;
        const estimatedTime = baseTime + elapsed;

        // A finite video cannot progress beyond its end, including cached clocks.
        const time = duration > 0
            ? Math.min(duration, estimatedTime)
            : estimatedTime;
        return {
            time,
            duration,
            awaitingSync,
            ended: playback?.ended === true || (duration > 0 && time >= duration),
        };
    }

    globalThis.SyncWatchPlaybackClock = { getProgress };
})();
