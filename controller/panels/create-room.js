(() => {
    const controller = (window.SyncWatchController ||= {});

    function create(documentRef, onSubmit) {
        const form = documentRef.createElement('form');
        form.className = 'swc-form';

        const heading = documentRef.createElement('h2');
        heading.textContent = '创建房间';

        const label = documentRef.createElement('label');
        label.textContent = '房间人数（4 至 16 人）';

        const count = documentRef.createElement('input');
        count.type = 'number';
        count.min = '4';
        count.max = '16';
        count.step = '1';
        count.value = '4';
        count.required = true;
        label.append(count);

        const submit = documentRef.createElement('button');
        submit.type = 'submit';
        submit.className = 'swc-primary';
        submit.textContent = '创建房间';

        form.append(heading, label, submit);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const requested = Number(count.value);
            const roomLimit = Number.isInteger(requested)
                ? Math.max(4, Math.min(16, requested))
                : 4;
            count.value = String(roomLimit);
            onSubmit(roomLimit);
        });

        return form;
    }

    controller.createRoomPanel = { create };
})();
