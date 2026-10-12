(() => {
    const controller = (window.SyncWatchController ||= {});
    const ringRadius = 79;
    const circumference = 2 * Math.PI * ringRadius;

    function create(documentRef) {
        const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 168 168');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('swc-progress-ring');

        const track = documentRef.createElementNS(
            'http://www.w3.org/2000/svg',
            'circle',
        );
        track.setAttribute('cx', '84');
        track.setAttribute('cy', '84');
        track.setAttribute('r', String(ringRadius));
        track.classList.add('swc-progress-track');

        const progress = track.cloneNode();
        progress.classList.remove('swc-progress-track');
        progress.classList.add('swc-progress-value');
        progress.setAttribute('stroke-dasharray', String(circumference));
        progress.setAttribute('stroke-dashoffset', String(circumference));

        svg.append(track, progress);
        return { svg, progress };
    }

    function update(progressCircle, video) {
        const duration = Number(video?.duration);
        const currentTime = Number(video?.currentTime);
        const isDeterminate =
            Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime);

        if (!isDeterminate) {
            progressCircle.closest('svg')?.classList.add('is-indeterminate');
            progressCircle.setAttribute('stroke-dashoffset', String(circumference));
            return;
        }

        const ratio = Math.max(0, Math.min(1, currentTime / duration));
        progressCircle.closest('svg')?.classList.remove('is-indeterminate');
        progressCircle.setAttribute(
            'stroke-dashoffset',
            String(circumference * (1 - ratio)),
        );
    }

    controller.progressRing = { create, update };
})();
