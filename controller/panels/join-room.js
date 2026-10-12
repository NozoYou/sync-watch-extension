(() => {
    const controller = (window.SyncWatchController ||= {});

    function create(documentRef, onSubmit) {
        const form = documentRef.createElement('form');
        form.className = 'swc-form';

        const heading = documentRef.createElement('h2');
        heading.textContent = '加入房间';

        const label = documentRef.createElement('label');
        label.textContent = '房间码';

        const roomCode = documentRef.createElement('input');
        roomCode.type = 'text';
        roomCode.maxLength = 8;
        roomCode.autocomplete = 'off';
        roomCode.spellcheck = false;
        roomCode.placeholder = '输入房间码';
        roomCode.required = true;
        roomCode.addEventListener('input', () => {
            roomCode.value = roomCode.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '');
        });
        label.append(roomCode);

        const submit = documentRef.createElement('button');
        submit.type = 'submit';
        submit.className = 'swc-primary';
        submit.textContent = '加入房间';

        form.append(heading, label, submit);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            onSubmit(roomCode.value.trim());
        });

        return form;
    }

    controller.joinRoomPanel = { create };
})();
