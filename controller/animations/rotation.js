(() => {
    const controller = (window.SyncWatchController ||= {});

    function create(documentRef) {
        const element = documentRef.createElement('div');
        element.className = 'swc-rotation-decoration';
        element.setAttribute('aria-hidden', 'true');

        let enabled = true;
        let destroyed = false;

        function setPlaying(isPlaying) {
            if (destroyed || !enabled) return;
            element.classList.toggle('is-rotating', isPlaying);
        }

        return {
            element,
            start: () => setPlaying(true),
            pause: () => setPlaying(false),
            stop: () => setPlaying(false),
            setEnabled(value) {
                enabled = value === true;
                element.hidden = !enabled;
                if (!enabled) setPlaying(false);
            },
            destroy() {
                destroyed = true;
                element.remove();
            },
        };
    }

    controller.rotation = { create };
})();
