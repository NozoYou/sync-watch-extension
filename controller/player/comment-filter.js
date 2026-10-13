(() => {
    const namespace = (window.SyncWatchCommentFilter ||= {});
    const componentSelector = [
        'bili-comments',
        'bili-comment-list',
        'bili-comment-thread-renderer',
        'bili-comment-renderer',
        'bili-rich-text',
    ].join(', ');
    const rendererSelector = 'bili-comment-renderer';
    const legacyContentSelector = [
        '.reply-item .reply-content',
        '.reply-item .text',
        '.reply-wrap .text',
    ].join(', ');

    const legacyReplySelector =
        '.sub-reply-item, .sub-reply-list, .sub-reply-container';

    function readContent(element) {
        let text = '';
        const mentionedUsers = new Set();
        let hasMedia = false;

        function visit(node) {
            if (node.nodeType === 3) {
                text += node.textContent;
                return;
            }
            if (node.nodeType !== 1) return;
            if (node.matches('script, style')) return;
            if (node.matches('img, video, audio, canvas')) {
                // Images and emoji carry content even when no text is present.
                hasMedia = true;
            }
            const profile = (node.getAttribute('href') || '').match(
                /^(?:https?:)?\/\/space\.bilibili\.com\/(\d+)(?:[/?#]|$)/i,
            );
            const isMentionLink = node.getAttribute('data-type') === 'mention';
            if (
                node.matches('a') &&
                node.textContent.trim().startsWith('@') &&
                (profile || isMentionLink)
            ) {
                const userId = profile?.[1] || node.getAttribute('data-user-profile-id');
                mentionedUsers.add(userId
                    ? `user:${userId}`
                    : `name:${node.textContent.trim()}`);
                text += ' ';
                return;
            }
            if (node.matches('br')) text += ' ';
            for (const child of node.childNodes) visit(child);
        }

        visit(element);
        // Also support plain mentions in legacy comments without profile links.
        text = text.replace(
            /(^|[\s，,、;；:：])@[^\s@，,、;；:：。.!！?？]+/gu,
            (match, prefix) => {
                mentionedUsers.add(`name:${match.slice(prefix.length)}`);
                return `${prefix} `;
            },
        );
        // Keep the original content available for future semantic classification.
        return {
            text: element.textContent.trim(),
            mentionedUsers: [...mentionedUsers],
            mentionCount: mentionedUsers.size,
            hasMedia,
        };
    }

    function classifyComment(comment) {
        // Filtering policy is independent of DOM parsing and container removal.
        // Future model/API integration belongs here; asynchronous evaluation will
        // also need stale-result checks before removing a comment container.
        return comment.mentionCount > 0;
    }

    function create(documentRef = document, windowRef = window) {
        const host = windowRef.location.hostname;
        const isBilibili = host === 'bilibili.com' || host.endsWith('.bilibili.com');
        const rootObservers = new Map();
        const pendingRoots = new Map();
        let enabled = false;
        let scanTimer = null;
        let discoveryTimer = null;

        function scheduleScan() {
            if (!enabled || scanTimer !== null) return;
            scanTimer = windowRef.setTimeout(() => {
                scanTimer = null;
                scanComments();
            }, 200);
        }

        function observeRoot(root) {
            if (rootObservers.has(root)) return;
            const observer = new windowRef.MutationObserver((records) => {
                if (root === documentRef && !records.some(isCommentMutation)) return;
                scheduleScan();
            });
            observer.observe(root, {
                childList: true,
                subtree: true,
                characterData: true,
            });
            rootObservers.set(root, observer);
        }

        function isCommentMutation(record) {
            const regionSelector = `${componentSelector}, .reply-item, .reply-wrap, .sub-reply-item`;
            const target = record.target.nodeType === 1
                ? record.target
                : record.target.parentElement;
            if (target?.closest(regionSelector)) return true;
            return [...record.addedNodes, ...record.removedNodes].some((node) =>
                node.nodeType === 1 &&
                (node.matches(regionSelector) || node.querySelector(regionSelector)),
            );
        }

        function scheduleRootDiscovery() {
            if (!enabled || discoveryTimer !== null || pendingRoots.size === 0) return;
            // Custom elements can attach a shadow root after entering the document.
            // Probe only those elements, with a bounded retry count.
            discoveryTimer = windowRef.setTimeout(() => {
                discoveryTimer = null;
                for (const [element, attempts] of pendingRoots) {
                    if (!element.isConnected || attempts >= 20) {
                        pendingRoots.delete(element);
                    } else if (element.shadowRoot) {
                        pendingRoots.delete(element);
                        observeRoot(element.shadowRoot);
                        scheduleScan();
                    } else {
                        pendingRoots.set(element, attempts + 1);
                    }
                }
                scheduleRootDiscovery();
            }, 500);
        }

        function updateComment(element, content) {
            if (!element.isConnected) return;
            if (
                element.matches('bili-comment-reply-renderer') ||
                content.closest(legacyReplySelector)
            ) return;
            const comment = readContent(content);
            if (!classifyComment(comment)) return;

            // A top-level renderer lives inside its thread's shadow root.
            // Remove the entire thread, including replies and separators.
            const rootHost = element.getRootNode().host;
            const container = element.matches('bili-comment-renderer') &&
                rootHost?.matches('bili-comment-thread-renderer')
                ? rootHost
                : element;
            container.remove();
        }

        function scanComments() {
            if (!enabled) return;
            for (const [root, observer] of rootObservers) {
                if (root.host && !root.host.isConnected) {
                    observer.disconnect();
                    rootObservers.delete(root);
                }
            }
            // Traverse only known comment components, never every shadow host on a page.
            const roots = [documentRef];
            const visited = new Set();
            for (let index = 0; index < roots.length; index += 1) {
                const root = roots[index];
                if (root.host && !root.host.isConnected) continue;
                if (visited.has(root)) continue;
                visited.add(root);
                observeRoot(root);
                for (const element of root.querySelectorAll(componentSelector)) {
                    if (!element.isConnected) continue;
                    if (element.shadowRoot) {
                        pendingRoots.delete(element);
                        roots.push(element.shadowRoot);
                    } else if (!pendingRoots.has(element)) {
                        pendingRoots.set(element, 0);
                    }
                    if (!element.matches(rendererSelector) || !element.shadowRoot) {
                        continue;
                    }
                    const body = element.shadowRoot.querySelector('#content') ||
                        element.shadowRoot.querySelector('bili-rich-text');
                    const richText = body?.matches('bili-rich-text')
                        ? body
                        : body?.querySelector('bili-rich-text');
                    const content = richText
                        ? richText.shadowRoot?.querySelector('#contents')
                        : body;
                    if (content) updateComment(element, content);
                }
                for (const content of root.querySelectorAll(legacyContentSelector)) {
                    // Legacy selectors may also match text inside nested replies.
                    if (content.closest(legacyReplySelector)) continue;
                    const row = content.closest('.reply-item, .reply-wrap');
                    if (row) updateComment(row, content);
                }
            }
            scheduleRootDiscovery();
        }

        function stop() {
            enabled = false;
            windowRef.clearTimeout(scanTimer);
            windowRef.clearTimeout(discoveryTimer);
            scanTimer = null;
            discoveryTimer = null;
            for (const observer of rootObservers.values()) observer.disconnect();
            rootObservers.clear();
            pendingRoots.clear();
        }

        function setSettings(settings = {}) {
            const nextEnabled = isBilibili && settings.blockAds !== false &&
                settings.blockMeaninglessComments !== false;
            if (nextEnabled === enabled) return;
            if (!nextEnabled) {
                stop();
                return;
            }
            enabled = true;
            observeRoot(documentRef);
            scheduleScan();
        }

        return { setSettings, destroy: stop };
    }

    namespace.create = create;
    namespace.classifyComment = classifyComment;
})();
