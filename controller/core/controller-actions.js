(() => {
    const controller = (window.SyncWatchController ||= {});

    function create(sendMessage, getVideo, showMessage) {
        async function send(payload) {
            try {
                return await sendMessage(payload);
            } catch {
                showMessage('扩展连接暂时不可用。');
                return null;
            }
        }

        return {
            async refreshState() {
                const response = await send({ type: 'GET_CONTROLLER_STATE' });
                return response?.state || null;
            },
            createRoom(roomLimit) {
                return send({ type: 'CREATE_ROOM', roomLimit });
            },
            joinRoom(room) {
                return send({ type: 'JOIN_ROOM', room });
            },
            leaveRoom() {
                return send({ type: 'LEAVE' });
            },
            async saveProgress() {
                const video = getVideo();
                if (!video) {
                    showMessage('未检测到可保存的视频。');
                    return false;
                }

                const response = await send({
                    type: 'SAVE_PAGE_PROGRESS',
                    progress: {
                        title: (document.title || location.hostname).replace(
                            /^\[一起看\]\s*/,
                            '',
                        ),
                        time: Number(video.currentTime) || 0,
                        duration: Number.isFinite(video.duration)
                            ? video.duration
                            : 0,
                    },
                });
                if (response?.success) showMessage('已保存到本地。');
                else if (response) showMessage(response.message || '保存失败。');
                return response?.success === true;
            },
            async rebind() {
                const response = await send({ type: 'REBIND_CURRENT_PLAYER' });
                if (response?.success && response.pending) {
                    showMessage('正在绑定当前标签页…');
                } else if (response?.success) showMessage('绑定成功。');
                else if (response) showMessage(response.message || '未找到播放器。');
                return response?.success === true;
            },
            skipOpeningEnding(seconds, state = {}) {
                if (state.room && state.role !== 'host' && !state.canSeek) {
                    showMessage('房主尚未授予你调整进度的权限。');
                    return false;
                }

                const video = getVideo();
                const result =
                    controller.skipSegments?.skipCurrent(video, seconds) || {
                        success: false,
                        message: '当前无法跳过。',
                    };

                if (result.success && state.room && state.connected) {
                    send({
                        type: 'VIDEO_OUT',
                        videoState: {
                            action: 'seek',
                            time: result.targetTime,
                            paused: video.paused,
                            rate: video.playbackRate,
                            duration: video.duration,
                            at: Date.now(),
                            url: location.href,
                            title: document.title,
                            manualControl: true,
                        },
                    });
                }
                showMessage(result.message);
                return result.success;
            },
            openSharedHistory(url) {
                return send({ type: 'OPEN_CONTROLLER_URL', url });
            },
            openSavedProgress(id) {
                return send({ type: 'OPEN_SAVED_PROGRESS', id });
            },
            deleteSavedProgress(id) {
                return send({ type: 'DELETE_SAVED_PROGRESS', id });
            },
        };
    }

    controller.createActions = create;
})();
