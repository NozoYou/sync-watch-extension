(() => {
    const controller = (window.SyncWatchController ||= {});

    // Skip a configurable amount of time without assuming OP/ED timestamps.
    function skipCurrent(video, requestedSeconds = 85) {
        if (!video) {
            return { success: false, message: '未检测到视频播放器。' };
        }

        if (!Number.isFinite(video.duration) || video.duration <= 0) {
            return { success: false, message: '当前视频暂不支持跳过。' };
        }

        const seconds = Number.isFinite(Number(requestedSeconds))
            ? Math.max(1, Math.min(3600, Math.round(Number(requestedSeconds))))
            : 85;
        const startTime = Number(video.currentTime) || 0;
        const targetTime = Math.min(video.duration, startTime + seconds);

        if (targetTime <= startTime) {
            return { success: false, message: '已经到达视频结尾。' };
        }

        video.currentTime = targetTime;
        const skippedSeconds = Math.round(targetTime - startTime);
        const message = targetTime >= video.duration
            ? '已跳至视频结尾。'
            : `已快进 ${formatDuration(skippedSeconds)}。`;

        return { success: true, message, targetTime };
    }

    function formatDuration(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (!minutes) return `${remainingSeconds} 秒`;
        if (!remainingSeconds) return `${minutes} 分钟`;
        return `${minutes} 分 ${remainingSeconds} 秒`;
    }

    controller.skipSegments = { skipCurrent };
})();
