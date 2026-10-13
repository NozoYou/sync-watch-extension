(() => {
    const controller = (window.SyncWatchController ||= {});
    const extensionUrl = (path) => chrome.runtime.getURL(path);

    function create(options) {
        const documentRef = options.document || document;
        const windowRef = options.window || window;
        const actions = options.actions;
        const globalEvents = new AbortController();
        const systemColorScheme = windowRef.matchMedia?.(
            '(prefers-color-scheme: dark)',
        );
        let videoEvents = null;
        let videoLayoutObserver = null;
        let video = null;
        let state = {};
        let active = false;
        let stylesReady = false;
        let settingsReady = false;
        let activePanel = '';
        let disk = null;
        let toastTimer = null;
        let roomActionSequence = 0;
        let styleName = '';
        let host = null;
        let shadow = null;
        let panel = null;
        let toast = null;
        let ringCircle = null;
        let rotation = null;
        let dragStart = null;
        let lastPanelSignature = '';
        let size = 168;
        let dockSide = '';
        let collapsed = false;
        let dockReturnSide = '';
        let autoDockOriginSide = '';
        let autoDockTimer = null;
        let pointerInsideController = false;
        let suppressClickUntil = 0;
        let dockToggle = null;
        let dockShape = null;
        let dockPath = null;
        let contextMenu = null;
        let roomCodeButton = null;

        systemColorScheme?.addEventListener(
            'change',
            () => {
                const themeMode = state.controllerSettings?.themeMode || 'system';
                if (themeMode === 'system') {
                    host?.classList.toggle('is-dark-mode', systemColorScheme.matches);
                }
            },
            { signal: globalEvents.signal },
        );

        function syncHostVisibility() {
            if (!host) return;
            const visible = active && stylesReady && settingsReady;
            host.hidden = !visible;
            // Inline hiding also works before the shadow stylesheets have loaded.
            if (visible) host.style.removeProperty('display');
            else host.style.setProperty('display', 'none', 'important');
        }

        function ensureHost() {
            if (host) return;

            host = documentRef.createElement('div');
            host.id = '__sync_watch_controller';
            host.className = 'swc-host';
            host.hidden = true;
            host.style.setProperty('display', 'none', 'important');
            shadow = host.attachShadow({ mode: 'closed' });

            const stylesheetLoads = [];
            for (const path of [
                'controller/styles/shared.css',
                'controller/styles/style-1/style.css',
                'controller/animations/rotation.css',
            ]) {
                const link = documentRef.createElement('link');
                link.rel = 'stylesheet';
                link.href = extensionUrl(path);
                stylesheetLoads.push(new Promise((resolve) => {
                    const listenerOptions = {
                        once: true,
                        signal: globalEvents.signal,
                    };
                    link.addEventListener('load', () => resolve(true), listenerOptions);
                    link.addEventListener('error', () => resolve(false), listenerOptions);
                }));
                shadow.append(link);
            }

            const layer = documentRef.createElement('div');
            layer.className = 'swc-layer';

            dockToggle = documentRef.createElement('button');
            dockToggle.type = 'button';
            dockToggle.className = 'swc-dock-toggle';
            dockToggle.title = '展开圆盘';
            dockToggle.setAttribute('aria-label', '展开圆盘');

            dockShape = documentRef.createElementNS(
                'http://www.w3.org/2000/svg',
                'svg',
            );
            dockShape.setAttribute('viewBox', '0 0 36 72');
            dockShape.setAttribute('aria-hidden', 'true');
            dockShape.classList.add('swc-dock-shape');
            dockPath = documentRef.createElementNS(
                'http://www.w3.org/2000/svg',
                'path',
            );
            dockPath.setAttribute('d', 'M 0 0 A 36 36 0 0 1 0 72 Z');
            dockShape.append(dockPath);

            const dockIcon = documentRef.createElement('span');
            dockIcon.className = 'swc-dock-icon';
            dockIcon.setAttribute('aria-hidden', 'true');
            dockToggle.append(dockShape, dockIcon);
            dockToggle.addEventListener('click', (event) => {
                event.stopPropagation();
                if (Date.now() <= suppressClickUntil) return;
                undock();
            });
            dockToggle.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
                beginDrag(event);
            });

            contextMenu = documentRef.createElement('div');
            contextMenu.className = 'swc-context-menu';
            contextMenu.hidden = true;
            contextMenu.setAttribute('role', 'menu');
            const closeButton = documentRef.createElement('button');
            closeButton.type = 'button';
            closeButton.textContent = '关闭圆球';
            closeButton.title = '可在扩展设置中重新开启';
            closeButton.addEventListener('click', () => {
                contextMenu.hidden = true;
                chrome.runtime.sendMessage({
                    type: 'SET_CONTROLLER_SETTINGS',
                    settings: { enabled: false },
                }).catch(() => {});
            });
            contextMenu.append(closeButton);
            shadow.addEventListener(
                'contextmenu',
                openControllerContextMenu,
                { capture: true, signal: globalEvents.signal },
            );
            host.addEventListener(
                'pointerleave',
                handleControllerPointerLeave,
                { signal: globalEvents.signal },
            );
            host.addEventListener(
                'wheel',
                (event) => {
                    if (event.composedPath().includes(panel)) {
                        event.stopPropagation();
                    }
                },
                {
                    capture: true,
                    passive: true,
                    signal: globalEvents.signal,
                },
            );

            const ring = controller.progressRing.create(documentRef);
            ringCircle = ring.progress;
            layer.append(ring.svg);

            rotation = controller.rotation?.create(documentRef) || {
                element: documentRef.createElement('span'),
                setEnabled() {},
                start() {},
                pause() {},
                stop() {},
                destroy() {},
            };
            layer.append(rotation.element);

            panel = documentRef.createElement('div');
            panel.className = 'swc-panel';
            panel.setAttribute('role', 'region');
            panel.setAttribute('aria-live', 'polite');

            roomCodeButton = documentRef.createElement('button');
            roomCodeButton.type = 'button';
            roomCodeButton.className = 'swc-room-code';
            roomCodeButton.hidden = true;
            roomCodeButton.addEventListener('click', copyRoomCode);

            toast = documentRef.createElement('div');
            toast.className = 'swc-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');

            layer.append(panel, roomCodeButton, toast);
            shadow.append(layer);
            shadow.append(dockToggle);
            shadow.append(contextMenu);
            documentRef.documentElement.append(host);

            documentRef.addEventListener(
                'visibilitychange',
                updateVideoState,
                { signal: globalEvents.signal },
            );
            documentRef.addEventListener(
                'pointermove',
                moveDrag,
                { signal: globalEvents.signal },
            );
            documentRef.addEventListener(
                'pointermove',
                trackAutoDockPointer,
                { signal: globalEvents.signal },
            );
            documentRef.addEventListener(
                'pointerup',
                endDrag,
                { signal: globalEvents.signal },
            );
            documentRef.addEventListener(
                'pointercancel',
                endDrag,
                { signal: globalEvents.signal },
            );

            globalEvents.signal.addEventListener(
                'abort',
                () => host?.remove(),
                { once: true },
            );

            documentRef.addEventListener(
                'pointerdown',
                closeOnOutsidePointer,
                { capture: true, signal: globalEvents.signal },
            );
            documentRef.addEventListener(
                'keydown',
                closeOnEscape,
                { signal: globalEvents.signal },
            );
            documentRef.addEventListener(
                'fullscreenchange',
                moveIntoFullscreen,
                { signal: globalEvents.signal },
            );
            windowRef.addEventListener(
                'resize',
                () => {
                    clampHostToViewport();
                    syncFullscreenPresentation();
                },
                { signal: globalEvents.signal },
            );

            moveIntoFullscreen();
            restorePosition();
            renderStyle();
            Promise.all(stylesheetLoads).then((loaded) => {
                if (globalEvents.signal.aborted) return;
                stylesReady = loaded.every(Boolean);
                syncHostVisibility();
            });
        }

        function getPanelSignature() {
            return JSON.stringify({
                room: state.room || '',
                serverConfigured: state.serverConfigured === true,
                history: state.navigationHistory || [],
                savedProgress: state.savedProgress || [],
            });
        }

        function restorePosition() {
            const saved = state.controllerSettings?.position;
            const defaultX = Math.max(12, windowRef.innerWidth - size - 12);
            const defaultY = Math.max(
                12,
                windowRef.innerHeight / 2 - size / 2,
            );
            dockSide = ['left', 'right'].includes(state.controllerSettings?.dockSide)
                ? state.controllerSettings.dockSide
                : Number.isFinite(saved?.x) && Number.isFinite(saved?.y)
                  ? ''
                  : 'right';
            collapsed = state.controllerSettings?.collapsed === true || !!dockSide;
            autoDockOriginSide = !collapsed ? 'free' : '';
            host.style.left = `${Number.isFinite(saved?.x) ? saved.x : defaultX}px`;
            host.style.top = `${Number.isFinite(saved?.y) ? saved.y : defaultY}px`;
            applySize();
            applyDockState();
            clampHostToViewport();
        }

        function applySize() {
            if (!host) return;
            size = Math.max(
                120,
                Math.min(240, Number(state.controllerSettings?.size) || 168),
            );
            host.style.width = `${size}px`;
            host.style.height = `${size}px`;
            host.style.setProperty('--swc-size', `${size}px`);
            host.style.setProperty('--swc-scale', String(size / 168));
        }

        function applyDockState() {
            host?.classList.toggle('is-docked', !!dockSide);
            host?.classList.toggle('is-collapsed', collapsed || !!dockSide);
            host?.classList.toggle('dock-left', dockSide === 'left');
            host?.classList.toggle('dock-right', dockSide === 'right');
            const floatingBubble = collapsed && !dockSide;
            const bubbleSize = documentRef.fullscreenElement ? 37 : 51;
            const bubbleCenter = bubbleSize / 2;
            const bubbleRadius = bubbleCenter - 1;
            dockShape?.setAttribute(
                'viewBox',
                floatingBubble ? `0 0 ${bubbleSize} ${bubbleSize}` : '0 0 36 72',
            );
            dockPath?.setAttribute(
                'd',
                floatingBubble
                    ? `M ${bubbleCenter} 1 A ${bubbleRadius} ${bubbleRadius} 0 1 1 ${bubbleCenter} ${bubbleSize - 1} A ${bubbleRadius} ${bubbleRadius} 0 1 1 ${bubbleCenter} 1 Z`
                    : 'M 0 0 A 36 36 0 0 1 0 72 Z',
            );
            if (dockToggle) {
                dockToggle.querySelector('.swc-dock-icon').textContent = dockSide === 'left'
                    ? '›'
                    : dockSide === 'right'
                      ? '‹'
                      : '';
                dockToggle.title = '展开圆盘';
                dockToggle.setAttribute(
                    'aria-label',
                    '展开圆盘',
                );
            }
        }

        function clampHostToViewport() {
            if (!host) return;
            const margin = 12;
            const isFullscreen = Boolean(documentRef.fullscreenElement);
            const safeBottom = isFullscreen ? 100 : margin;
            const compact = collapsed || !!dockSide;
            const compactSize = dockSide
                ? isFullscreen ? 52 : 72
                : isFullscreen ? 37 : 51;
            const visualSize = compact ? compactSize : size;
            const offset = compact ? (size - visualSize) / 2 : 0;
            const roomCodeHeight = state.room && !compact ? 40 : 0;
            const maxY = Math.max(
                margin - offset,
                windowRef.innerHeight -
                    visualSize -
                    safeBottom -
                    offset -
                    roomCodeHeight,
            );
            const maxX = Math.max(
                margin - offset,
                windowRef.innerWidth - visualSize - margin - offset,
            );
            const isDraggingDock = dragStart?.moved === true;
            const x = dockSide === 'left' && !isDraggingDock
                ? 0
                : dockSide === 'right' && !isDraggingDock
                  ? Math.max(0, windowRef.innerWidth - size)
                  : Math.max(margin - offset, Math.min(maxX, host.offsetLeft));
            const y = Math.max(margin - offset, Math.min(maxY, host.offsetTop));
            host.style.left = `${x}px`;
            host.style.top = `${y}px`;
            if (activePanel) positionPanel();
        }

        function moveIntoFullscreen() {
            if (!host) return;
            const fullscreenElement = documentRef.fullscreenElement;
            const target =
                fullscreenElement && fullscreenElement.tagName !== 'VIDEO'
                    ? fullscreenElement
                    : documentRef.documentElement;
            if (host.parentElement !== target) target.append(host);
            host.style.position = 'fixed';
            host.style.zIndex = '2147483647';
            syncFullscreenPresentation();
            clampHostToViewport();

            clearTimeout(autoDockTimer);
            autoDockTimer = null;
            if (autoDockOriginSide && !pointerInsideController) {
                scheduleAutoDock();
            }
        }

        function syncFullscreenPresentation() {
            if (!host) return;
            const fullscreenElement = documentRef.fullscreenElement;
            const viewportWidth = windowRef.innerWidth;
            const viewportHeight = windowRef.innerHeight;
            let expandedPlayer = false;

            if (!fullscreenElement && video?.isConnected) {
                let element = video;
                let depth = 0;
                while (
                    element &&
                    element !== documentRef.documentElement &&
                    depth < 8
                ) {
                    const rect = element.getBoundingClientRect();
                    if (
                        rect.width >= viewportWidth * 0.94 &&
                        rect.height >= viewportHeight * 0.82
                    ) {
                        expandedPlayer = true;
                        break;
                    }
                    element = element.parentElement;
                    depth += 1;
                }
            }

            host.classList.toggle(
                'is-fullscreen',
                Boolean(fullscreenElement) || expandedPlayer,
            );
        }

        function renderStyle() {
            if (!host || !shadow) return;
            const availableFactory = controller.classicStyle;
            const availableStyle = 'style-1';
            if (availableStyle === styleName && disk) {
                disk.update?.(state);
                return;
            }

            disk?.element.remove();
            disk = null;
            styleName = availableStyle;
            if (!availableFactory) return;
            disk = availableFactory.create(documentRef, handleAction);
            disk.update?.(state);
            shadow.querySelector('.swc-layer').prepend(disk.element);
            disk.element.addEventListener(
                'pointerdown',
                beginDrag,
                { signal: globalEvents.signal },
            );
            disk.element.addEventListener(
                'click',
                suppressDraggedClick,
                { capture: true, signal: globalEvents.signal },
            );

            updateVideoState();
            renderPanel();
        }

        function beginDrag(event) {
            if (!host || event.button !== 0) return;
            const hostRect = host.getBoundingClientRect();
            const grabX = hostRect.width
                ? ((event.clientX - hostRect.left) / hostRect.width) * size
                : size / 2;
            const grabY = hostRect.height
                ? ((event.clientY - hostRect.top) / hostRect.height) * size
                : size / 2;
            dragStart = {
                pointerId: event.pointerId,
                pointerX: event.clientX,
                pointerY: event.clientY,
                hostX: event.clientX - grabX,
                hostY: event.clientY - grabY,
                moved: false,
                wasCompact: collapsed || !!dockSide,
            };
        }

        function moveDrag(event) {
            if (!dragStart || event.pointerId !== dragStart.pointerId) return;
            const deltaX = event.clientX - dragStart.pointerX;
            const deltaY = event.clientY - dragStart.pointerY;
            if (!dragStart.moved && Math.hypot(deltaX, deltaY) < 4) return;
            dragStart.moved = true;
            host.classList.add('is-dragging');
            host.style.left = `${dragStart.hostX + deltaX}px`;
            host.style.top = `${dragStart.hostY + deltaY}px`;
            clampHostToViewport();
            event.preventDefault();
        }

        function endDrag(event) {
            if (!dragStart || event.pointerId !== dragStart.pointerId) return;
            const didMove = dragStart.moved;
            const wasCompact = dragStart.wasCompact;
            dragStart = null;
            host.classList.remove('is-dragging');
            if (didMove) {
                dockAtNearestEdge(event);
                collapsed = wasCompact || !!dockSide;
                autoDockOriginSide = collapsed ? '' : 'free';
                applyDockState();
                clampHostToViewport();
                suppressClickUntil = Date.now() + 250;
                persistPosition();
            }
        }

        function suppressDraggedClick(event) {
            if (Date.now() > suppressClickUntil) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            suppressClickUntil = 0;
        }

        function dockAtNearestEdge(event) {
            const edgeThreshold = 28;
            const isFullscreen = Boolean(documentRef.fullscreenElement);
            const compactSize = isFullscreen ? 37 : 51;
            const previousDockSide = dockSide;
            const isDockHandle = Boolean(previousDockSide);
            const visualWidth = isDockHandle
                ? documentRef.fullscreenElement ? 26 : 36
                : collapsed ? compactSize : size;
            const offset = isDockHandle
                ? previousDockSide === 'right' ? size - visualWidth : 0
                : (size - visualWidth) / 2;
            const visualLeft = host.offsetLeft + offset;
            const visualRight = visualLeft + visualWidth;
            const nearBottomControls = Boolean(documentRef.fullscreenElement) &&
                event.clientY >= windowRef.innerHeight - 140;
            const nearLeft = visualLeft <= edgeThreshold;
            const nearRight = windowRef.innerWidth - visualRight <= edgeThreshold;

            dockSide = nearBottomControls
                ? ''
                : nearLeft
                  ? 'left'
                  : nearRight
                    ? 'right'
                    : '';

            if (dockSide === 'left') host.style.left = '0px';
            if (dockSide === 'right') {
                host.style.left = `${Math.max(0, windowRef.innerWidth - size)}px`;
            }
            if (!dockSide) {
                dockReturnSide = '';
                if (previousDockSide) {
                    host.style.left = `${event.clientX - size / 2}px`;
                    host.style.top = `${event.clientY - size / 2}px`;
                }
            } else {
                dockReturnSide = '';
            }
            if (dockSide) closePanel();
            applyDockState();
        }

        function undock() {
            if (dockSide) {
                const previousSide = dockSide;
                dockReturnSide = previousSide;
                autoDockOriginSide = previousSide;
                dockSide = '';
                host.style.left = previousSide === 'left'
                    ? '12px'
                    : `${Math.max(12, windowRef.innerWidth - size - 12)}px`;
            } else {
                autoDockOriginSide = 'free';
            }
            collapsed = false;
            applyDockState();
            clampHostToViewport();
            persistPosition();
        }

        function persistPosition() {
            const settings = {
                ...(state.controllerSettings || {}),
                position: { x: host.offsetLeft, y: host.offsetTop },
                size,
                dockSide: dockSide || null,
                collapsed,
            };
            state.controllerSettings = settings;
            if (chrome.storage?.local) {
                chrome.storage.local.set({ controllerSettings: settings });
            }
            chrome.runtime.sendMessage({
                type: 'SET_CONTROLLER_SETTINGS',
                settings,
            }).catch(() => {});
        }

        function closeOnOutsidePointer(event) {
            if (!host) return;
            const path = event.composedPath?.() || [];
            if (path.includes(host) || path.includes(shadow)) return;
            if (contextMenu) contextMenu.hidden = true;
            if (activePanel) closePanel();
        }

        function closeOnEscape(event) {
            if (event.key !== 'Escape') return;
            if (contextMenu) contextMenu.hidden = true;
            closePanel();
        }

        function openControllerContextMenu(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!contextMenu || !host) return;

            const hostRect = host.getBoundingClientRect();
            const menuWidth = 148;
            const menuHeight = 42;
            const left = Math.max(
                8 - hostRect.left,
                Math.min(
                    windowRef.innerWidth - menuWidth - hostRect.left,
                    event.clientX - hostRect.left,
                ),
            );
            const top = Math.max(
                8 - hostRect.top,
                Math.min(
                    windowRef.innerHeight - menuHeight - hostRect.top,
                    event.clientY - hostRect.top,
                ),
            );
            contextMenu.style.left = `${left}px`;
            contextMenu.style.top = `${top}px`;
            contextMenu.hidden = false;
        }

        function positionPanel() {
            if (!host || !panel || !activePanel) return;
            panel.style.left = '0px';
            panel.style.top = '0px';

            requestAnimationFrame(() => {
                if (!activePanel || !host || !panel) return;
                const hostRect = host.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                const width = panelRect.width || 290;
                const height = panelRect.height || 240;
                const margin = 12;

                let pageX = hostRect.right + margin;
                if (pageX + width > windowRef.innerWidth - margin) {
                    pageX = hostRect.left - width - margin;
                }
                pageX = Math.max(
                    margin,
                    Math.min(windowRef.innerWidth - width - margin, pageX),
                );

                let pageY = hostRect.top + (hostRect.height - height) / 2;
                pageY = Math.max(
                    margin,
                    Math.min(windowRef.innerHeight - height - margin, pageY),
                );

                panel.style.left = `${pageX - hostRect.left}px`;
                panel.style.top = `${pageY - hostRect.top}px`;
            });
        }

        function openPanel(name) {
            clearTimeout(autoDockTimer);
            autoDockTimer = null;
            activePanel = name;
            panel.classList.add('is-open');
            renderPanel();
            positionPanel();
            for (const button of disk.element.querySelectorAll('[data-action]')) {
                button.classList.toggle('is-active', button.dataset.action === name);
            }

            if (name === 'shared-history' || name === 'local-history') {
                refreshPanelState(name);
            }
        }

        function closePanel(returnToDock = false) {
            activePanel = '';
            panel?.classList.remove('is-open');
            disk?.element
                .querySelectorAll('[data-action].is-active')
                .forEach((button) => button.classList.remove('is-active'));
            if (returnToDock) {
                restoreDockAfterAction();
                autoDockOriginSide = '';
                collapsed = true;
                applyDockState();
                clampHostToViewport();
                persistPosition();
            }
            clearTimeout(autoDockTimer);
            autoDockTimer = null;
        }

        function trackAutoDockPointer(event) {
            if (!autoDockOriginSide) return;
            const path = event.composedPath?.() || [];
            if (path.includes(host)) {
                pointerInsideController = true;
                clearTimeout(autoDockTimer);
                autoDockTimer = null;
                return;
            }
            pointerInsideController = false;
            scheduleAutoDock();
        }

        function scheduleAutoDock() {
            if (!autoDockOriginSide || dragStart || autoDockTimer) return;
            const delay = documentRef.fullscreenElement ? 1_000 : 3_000;
            autoDockTimer = setTimeout(() => {
                autoDockTimer = null;
                if (!autoDockOriginSide || dragStart) return;
                closePanel(true);
            }, delay);
        }

        function handleControllerPointerLeave() {
            pointerInsideController = false;
            scheduleAutoDock();
        }

        function refreshPanelState(panelName) {
            Promise.resolve(actions.refreshState?.())
                .then((latestState) => {
                    if (!latestState || activePanel !== panelName) return;
                    update(latestState);
                })
                .catch(() => {});
        }

        async function runRoomAction(action, value) {
            const sequence = ++roomActionSequence;
            const previousStatus = state.status;
            const isLeaving = action === 'leave';
            const pendingMessage = {
                create: '正在创建房间…',
                join: '正在加入房间…',
                leave: '正在离开房间…',
            }[action];
            showMessage(pendingMessage);

            const response = await actions[
                action === 'create'
                    ? 'createRoom'
                    : action === 'join'
                      ? 'joinRoom'
                      : 'leaveRoom'
            ](value);

            if (response?.success !== true) {
                showMessage(response?.message || '操作未能完成。');
                return;
            }

            const deadline = Date.now() + 20_000;
            const pendingStatuses = new Set([
                '正在创建房间…',
                '正在加入房间…',
                '正在连接房间…',
                '服务器断开，正在重连…',
            ]);

            while (sequence === roomActionSequence && Date.now() < deadline) {
                const latestState = await actions.refreshState?.();
                if (latestState) {
                    update(latestState);

                    if (isLeaving && !latestState.room) {
                        showMessage('已离开房间。');
                        return;
                    }

                    if (!isLeaving && latestState.connected) {
                        showMessage(
                            action === 'create'
                                ? '房间创建成功。'
                                : '加入房间成功。',
                        );
                        return;
                    }

                    if (
                        latestState.status &&
                        latestState.status !== previousStatus &&
                        !pendingStatuses.has(latestState.status)
                    ) {
                        showMessage(latestState.status);
                        return;
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 300));
            }

            if (sequence === roomActionSequence) {
                showMessage('等待房间响应超时，请检查服务器连接。');
            }
        }

        function restoreDockAfterAction() {
            if (!host) return;
            if (activePanel) return;
            if (!dockReturnSide) {
                if (documentRef.fullscreenElement && !dockSide) {
                    const centerX = host.offsetLeft + size / 2;
                    dockSide = centerX < windowRef.innerWidth / 2
                        ? 'left'
                        : 'right';
                    host.style.left = dockSide === 'left'
                        ? '0px'
                        : `${Math.max(0, windowRef.innerWidth - size)}px`;
                    applyDockState();
                    clampHostToViewport();
                }
                return;
            }

            dockSide = dockReturnSide;
            dockReturnSide = '';
            host.style.left = dockSide === 'left'
                ? '0px'
                : `${Math.max(0, windowRef.innerWidth - size)}px`;
            applyDockState();
            clampHostToViewport();
        }

        function renderPanel() {
            if (!panel || !activePanel) return;
            panel.replaceChildren();

            const doc = panel.ownerDocument;
            let content = null;
            if (activePanel === 'create-room') {
                if (state.room) {
                    closePanel();
                    return;
                } else if (!(state.serverConfigured || state.server)) {
                    content = messagePanel(
                        doc,
                        '请先在扩展功能菜单中配置服务器地址。',
                    );
                } else {
                    content = controller.createRoomPanel.create(doc, (limit) => {
                        runRoomAction('create', limit);
                    });
                }
            } else if (activePanel === 'join-room') {
                if (state.room) {
                    closePanel();
                    return;
                } else if (!(state.serverConfigured || state.server)) {
                    content = messagePanel(
                        doc,
                        '请先在扩展功能菜单中配置服务器地址。',
                    );
                } else {
                    content = controller.joinRoomPanel.create(doc, (room) => {
                        runRoomAction('join', room);
                    });
                }
            } else if (activePanel === 'shared-history') {
                content = state.room
                    ? controller.sharedHistoryPanel.create(
                          doc,
                          state.navigationHistory || [],
                          (url) => {
                              actions.openSharedHistory(url);
                          },
                      )
                    : messagePanel(doc, '加入房间后可查看房间分享历史。');
            } else if (activePanel === 'local-history') {
                content = controller.localHistoryPanel.create(
                    doc,
                    state.savedProgress || [],
                    (id) => {
                        actions.openSavedProgress(id);
                    },
                    (id) => {
                        actions.deleteSavedProgress(id);
                        refreshPanelState('local-history');
                    },
                );
            }

            if (content) panel.append(content);
            lastPanelSignature = getPanelSignature();
            positionPanel();
        }

        async function copyRoomCode() {
            const roomCode = String(state.room || '').trim();
            if (!roomCode) return;

            let copied = false;
            try {
                await windowRef.navigator.clipboard.writeText(roomCode);
                copied = true;
            } catch {
                try {
                    const temporaryInput = documentRef.createElement('textarea');
                    temporaryInput.value = roomCode;
                    temporaryInput.style.position = 'fixed';
                    temporaryInput.style.opacity = '0';
                    documentRef.body.append(temporaryInput);
                    temporaryInput.select();
                    copied = documentRef.execCommand('copy');
                    temporaryInput.remove();
                } catch {
                    copied = false;
                }
            }

            showMessage(copied ? '房间码已复制。' : '复制失败，请重试。');
        }

        function messagePanel(doc, text) {
            const section = doc.createElement('section');
            section.className = 'swc-history-panel';
            const message = doc.createElement('p');
            message.className = 'swc-empty';
            message.textContent = text;
            section.append(message);
            return section;
        }

        function handleAction(name) {
            if (name === 'leave-room') {
                runRoomAction('leave');
                return;
            }
            if (name === 'create-room' || name === 'join-room') {
                if (activePanel === name) closePanel();
                else openPanel(name);
                return;
            }
            if (name === 'shared-history' || name === 'local-history') {
                if (activePanel === name) closePanel();
                else openPanel(name);
                return;
            }
            if (name === 'save-progress') {
                actions.saveProgress();
                return;
            }
            if (name === 'rebind') {
                actions.rebind();
                return;
            }
            if (name === 'skip-opening-ending') {
                actions.skipOpeningEnding(
                    state.controllerSettings?.skipSeconds ?? 85,
                    state,
                );
            }
        }

        function showMessage(message) {
            if (!toast) return;
            toast.textContent = String(message || '');
            toast.classList.add('is-visible');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(
                () => toast?.classList.remove('is-visible'),
                2200,
            );
        }

        function updateVideoState() {
            updateCompactRotation();
            if (!ringCircle || !rotation) return;
            controller.progressRing.update(ringCircle, video);
            if (!video || video.ended) rotation.stop();
            else if (video.paused || documentRef.hidden || video.readyState < 3) {
                rotation.pause();
            } else {
                rotation.start();
            }
        }

        function updateCompactRotation() {
            // Room playback drives the compact record, even on an unbound page.
            const playback = state.currentPlayback;
            const playing = !!state.room && state.connected === true &&
                !!playback && playback.paused === false &&
                !playback.buffering && !playback.ended && !playback.awaitingSync;
            host?.classList.toggle('compact-playing', playing && !documentRef.hidden);
        }

        function setVideo(nextVideo) {
            if (video === nextVideo) {
                updateVideoState();
                return;
            }
            videoEvents?.abort();
            videoEvents = null;
            videoLayoutObserver?.disconnect();
            videoLayoutObserver = null;
            video = nextVideo || null;

            if (video) {
                videoEvents = new AbortController();
                const update = () => updateVideoState();
                for (const eventName of [
                    'timeupdate',
                    'durationchange',
                    'loadedmetadata',
                    'seeking',
                    'seeked',
                    'play',
                    'pause',
                    'waiting',
                    'playing',
                    'ended',
                ]) {
                    video.addEventListener(eventName, update, {
                        signal: videoEvents.signal,
                    });
                }
                if (windowRef.ResizeObserver) {
                    videoLayoutObserver = new windowRef.ResizeObserver(
                        syncFullscreenPresentation,
                    );
                    let element = video;
                    let depth = 0;
                    while (
                        element &&
                        element !== documentRef.documentElement &&
                        depth < 8
                    ) {
                        videoLayoutObserver.observe(element);
                        element = element.parentElement;
                        depth += 1;
                    }
                }
            }
            syncFullscreenPresentation();
            updateVideoState();
        }

        function update(nextState) {
            // Only background-provided settings may reveal the initialized UI.
            const firstSettingsUpdate = !settingsReady && !!nextState?.controllerSettings;
            if (nextState?.controllerSettings) settingsReady = true;
            const previousPositionSignature = JSON.stringify(
                state.controllerSettings?.position ?? null,
            );
            state = { ...state, ...(nextState || {}) };
            if (!state.controllerSettings) {
                state.controllerSettings = {
                    style: 'style-1',
                    enabled: true,
                    themeMode: 'system',
                    rotationEnabled: true,
                    position: null,
                    size: 168,
                    dockSide: 'right',
                    collapsed: true,
                };
            }
            ensureHost();
            const previousSize = size;
            const previousDockSide = dockSide;
            applySize();
            dockSide = ['left', 'right'].includes(state.controllerSettings.dockSide)
                ? state.controllerSettings.dockSide
                : '';
            collapsed = state.controllerSettings.collapsed === true || !!dockSide;
            applyDockState();
            renderStyle();
            const roomCode = String(state.room || '').trim();
            roomCodeButton.hidden = !roomCode;
            roomCodeButton.textContent = roomCode
                ? `房间码：${roomCode} · 点击复制`
                : '';
            roomCodeButton.title = roomCode ? '点击复制房间码' : '';
            host.classList.toggle('has-room', !!roomCode);
            host.classList.toggle(
                'is-dark-mode',
                state.controllerSettings.themeMode === 'dark' ||
                    ((state.controllerSettings.themeMode || 'system') === 'system' &&
                        !!systemColorScheme?.matches),
            );
            rotation?.setEnabled(
                state.controllerSettings.rotationEnabled !== false,
            );
            if (
                firstSettingsUpdate ||
                size !== previousSize ||
                dockSide !== previousDockSide ||
                JSON.stringify(state.controllerSettings.position ?? null) !==
                previousPositionSignature
            ) {
                restorePosition();
            }
            if (
                state.controllerActive === true ||
                (nextState && 'controllerActive' in nextState)
            ) {
                active =
                    state.controllerActive === true &&
                    state.controllerSettings.enabled !== false;
            }
            syncHostVisibility();
            if (activePanel && getPanelSignature() !== lastPanelSignature) {
                renderPanel();
            }
            updateCompactRotation();
        }

        function setActive(value) {
            active =
                value === true &&
                state.controllerSettings?.enabled !== false;
            state.controllerActive = active;
            if (active) ensureHost();
            syncHostVisibility();
        }

        function destroy() {
            videoEvents?.abort();
            videoEvents = null;
            videoLayoutObserver?.disconnect();
            videoLayoutObserver = null;
            clearTimeout(toastTimer);
            clearTimeout(autoDockTimer);
            rotation?.destroy();
            globalEvents.abort();
            host?.remove();
            host = null;
            shadow = null;
            disk = null;
            panel = null;
            ringCircle = null;
            rotation = null;
            toast = null;
        }

        return {
            setVideo,
            update,
            setActive,
            showMessage,
            destroy,
        };
    }

    controller.manager = { create };
})();
