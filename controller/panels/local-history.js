(() => {
    const controller = (window.SyncWatchController ||= {});

    function formatTime(seconds) {
        const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const minutes = Math.floor(safeSeconds / 60);
        const remainder = String(safeSeconds % 60).padStart(2, '0');
        return `${minutes}:${remainder}`;
    }

    function create(documentRef, history, onContinue, onDelete) {
        const panel = documentRef.createElement('section');
        panel.className = 'swc-history-panel';

        const heading = documentRef.createElement('h2');
        heading.textContent = '本地保存历史';
        panel.append(heading);

        if (!history.length) {
            const empty = documentRef.createElement('p');
            empty.className = 'swc-empty';
            empty.textContent = '还没有保存的视频进度。';
            panel.append(empty);
            return panel;
        }

        const list = documentRef.createElement('ol');
        list.className = 'swc-history-list';

        for (const item of history.slice(0, 15)) {
            const row = documentRef.createElement('li');
            const title = documentRef.createElement('strong');
            title.textContent = item.title || '未命名视频';

            const time = documentRef.createElement('span');
            time.className = 'swc-history-time';
            time.textContent = `进度：${formatTime(item.time)}`;

            const actions = documentRef.createElement('div');
            actions.className = 'swc-history-actions';

            const open = documentRef.createElement('button');
            open.type = 'button';
            open.className = 'swc-secondary';
            open.textContent = '继续观看';
            open.addEventListener('click', () => onContinue(item.id));

            const remove = documentRef.createElement('button');
            remove.type = 'button';
            remove.className = 'swc-danger';
            remove.textContent = '删除';
            remove.addEventListener('click', () => onDelete(item.id));

            actions.append(open, remove);
            row.append(title, time, actions);
            list.append(row);
        }

        panel.append(list);
        return panel;
    }

    controller.localHistoryPanel = { create };
})();
