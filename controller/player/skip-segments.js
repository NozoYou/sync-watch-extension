(() => {
    const controller = (window.SyncWatchController ||= {});

    // OP/ED segment discovery is intentionally not implemented yet.
    function skipCurrent() {
        return {
            success: false,
            message: '暂无可跳过片段',
        };
    }

    controller.skipSegments = { skipCurrent };
})();
