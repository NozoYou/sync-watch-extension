(() => {
    const controller = (window.SyncWatchController ||= {});

    function create(documentRef, history, onOpen) {
        const panel = documentRef.createElement('section');
        panel.className = 'swc-history-panel';

        const heading = documentRef.createElement('h2');
        heading.textContent = '房间分享历史';
        panel.append(heading);

        if (!history.length) {
            const empty = documentRef.createElement('p');
            empty.className = 'swc-empty';
            empty.textContent = '房主还没有分享视频。';
            panel.append(empty);
            return panel;
        }

        const list = documentRef.createElement('ol');
        list.className = 'swc-history-list';

        for (const item of history.slice(0, 15)) {
            const row = documentRef.createElement('li');
            const details = documentRef.createElement('details');
            const title = documentRef.createElement('summary');
            title.textContent = item.title || '未命名视频';

            const url = documentRef.createElement('p');
            url.className = 'swc-url';
            url.textContent = item.url || '';

            const open = documentRef.createElement('button');
            open.type = 'button';
            open.className = 'swc-secondary';
            open.textContent = '在新标签页打开';
            open.addEventListener('click', () => onOpen(item.url));

            details.append(title, url, open);
            row.append(details);
            list.append(row);
        }

        panel.append(list);
        return panel;
    }

    controller.sharedHistoryPanel = { create };
})();
