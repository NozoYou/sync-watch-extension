(() => {
    const controller = (window.SyncWatchController ||= {});
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const centerPoint = 84;
    const innerRadius = 35;
    const outerRadius = 81;
    const labelRadius = 58;

    // Each angle is measured clockwise from the right side of the circle.
    // The side sectors span 90 degrees; the four corner sectors span 45.
    const sectors = [
        {
            action: 'create-room',
            icon: '＋',
            label: '创建',
            fullLabel: '创建房间',
            start: 225,
            end: 270,
        },
        {
            action: 'join-room',
            icon: '↗',
            label: '加入',
            fullLabel: '加入房间',
            start: 270,
            end: 315,
        },
        {
            action: 'skip-opening-ending',
            icon: '»',
            label: '跳过',
            fullLabel: '跳过 OP/ED',
            start: 315,
            end: 405,
        },
        {
            action: 'local-history',
            icon: '▤',
            label: '本地史',
            fullLabel: '本地保存历史',
            start: 45,
            end: 90,
        },
        {
            action: 'shared-history',
            icon: '◷',
            label: '房间史',
            fullLabel: '房间分享历史',
            start: 90,
            end: 135,
        },
        {
            action: 'save-progress',
            icon: '▣',
            label: '保存进度',
            fullLabel: '保存当前进度',
            start: 135,
            end: 225,
        },
    ];

    function pointAt(radius, angle) {
        const radians = (angle * Math.PI) / 180;
        return {
            x: centerPoint + radius * Math.cos(radians),
            y: centerPoint + radius * Math.sin(radians),
        };
    }

    function createSectorPath(startAngle, endAngle) {
        const outerStart = pointAt(outerRadius, startAngle);
        const outerEnd = pointAt(outerRadius, endAngle);
        const innerEnd = pointAt(innerRadius, endAngle);
        const innerStart = pointAt(innerRadius, startAngle);
        const largeArc = endAngle - startAngle > 180 ? 1 : 0;

        return [
            `M ${outerStart.x} ${outerStart.y}`,
            `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
            `L ${innerEnd.x} ${innerEnd.y}`,
            `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
            'Z',
        ].join(' ');
    }

    function createSvgElement(documentRef, name, className) {
        const element = documentRef.createElementNS(svgNamespace, name);
        if (className) element.setAttribute('class', className);
        return element;
    }

    function createSectorLabel(documentRef, sector) {
        const angle = (sector.start + sector.end) / 2;
        const position = pointAt(labelRadius, angle);
        const group = createSvgElement(documentRef, 'g', 'swc-sector-content');

        const icon = createSvgElement(documentRef, 'text', 'swc-sector-icon');
        icon.setAttribute('x', position.x);
        icon.setAttribute('y', position.y - 3);
        icon.textContent = sector.icon;

        const label = createSvgElement(documentRef, 'text', 'swc-sector-label');
        label.setAttribute('x', position.x);
        label.setAttribute('y', position.y + 10);
        label.textContent = sector.label;

        group.append(icon, label);
        return group;
    }

    function create(documentRef, onAction) {
        const disk = documentRef.createElement('div');
        disk.className = 'swc-disk swc-classic-disk';

        const sectorLayer = createSvgElement(documentRef, 'svg', 'swc-classic-sectors');
        sectorLayer.setAttribute('viewBox', '0 0 168 168');
        sectorLayer.setAttribute('role', 'group');
        sectorLayer.setAttribute('aria-label', '一起看功能扇区');

        function createActionNodes(sector) {
            const path = createSvgElement(documentRef, 'path', 'swc-sector');
            path.setAttribute('d', createSectorPath(sector.start, sector.end));
            path.setAttribute('role', 'button');
            path.setAttribute('tabindex', '0');
            path.setAttribute('aria-label', sector.fullLabel);
            path.setAttribute('title', sector.fullLabel);
            path.dataset.action = sector.action;
            path.addEventListener('click', () => onAction(sector.action));
            path.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onAction(sector.action);
            });

            return [path, createSectorLabel(documentRef, sector)];
        }

        const roomEntryNodes = new Map();
        for (const sector of sectors) {
            const nodes = createActionNodes(sector);
            sectorLayer.append(...nodes);
            if (sector.action === 'create-room' || sector.action === 'join-room') {
                roomEntryNodes.set(sector.action, nodes);
            }
        }

        const leaveRoomNodes = createActionNodes({
            action: 'leave-room',
            icon: '↩',
            label: '离开',
            fullLabel: '离开房间',
            start: 225,
            end: 315,
        });
        sectorLayer.append(...leaveRoomNodes);

        function update(state = {}) {
            const inRoom = Boolean(state.room);
            for (const nodes of roomEntryNodes.values()) {
                for (const node of nodes) node.style.display = inRoom ? 'none' : '';
            }
            for (const node of leaveRoomNodes) {
                node.style.display = inRoom ? '' : 'none';
            }
        }

        const center = documentRef.createElement('button');
        center.type = 'button';
        center.className = 'swc-center-action';
        center.dataset.action = 'rebind';
        center.title = '重新绑定当前播放器';
        center.setAttribute('aria-label', '重新绑定当前播放器');

        const centerIcon = documentRef.createElement('span');
        centerIcon.setAttribute('aria-hidden', 'true');
        centerIcon.textContent = '⟳';

        const centerLabel = documentRef.createElement('small');
        centerLabel.textContent = '绑定';
        center.append(centerIcon, centerLabel);
        center.addEventListener('click', () => onAction('rebind'));

        disk.append(sectorLayer, center);
        update();
        return { element: disk, update };
    }

    controller.classicStyle = { create };
})();
