let socket = null;
let state = { server: '', turnUrls: '', turnUsername: '', turnCredential: '', room: '', role: '', status: '打开视频页面后创建房间，或输入房间码加入。', connected: false, memberCount: 0, roomLimit: 4, dataConnections: 0, tabId: null, videoFrameId: 0, videoReady: false, clientId: '', hostClientId: '', members: [], currentVideoUrl: '', pendingNavigation: null, sharedNavigation: null, followResponses: [], followingHost: true, hostCandidate: null };
let pingTimer = null, reconnectTimer = null;
const videoFrames = new Map();
const navigationNotificationPrefix = 'sync-watch-navigation-';
function notifyNavigation(nav) {
    if (!nav?.id || !chrome.notifications) return;
    const id = navigationNotificationPrefix + nav.id;
    chrome.action.setBadgeBackgroundColor({ color: '#7666f4' }).catch(() => { });
    chrome.action.setBadgeText({ text: '!' }).catch(() => { });
    chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('notification-icon.png'), title: '房主分享了新视频', message: String(nav.title || '新视频').slice(0, 160), priority: 0 }).catch(() => { });
}
function clearNavigationNotification(navId) {
    if (navId && chrome.notifications) chrome.notifications.clear(navigationNotificationPrefix + navId).catch(() => { });
    chrome.action.setBadgeText({ text: '' }).catch(() => { });
}
chrome.notifications.onClicked.addListener(id => {
    if (!id.startsWith(navigationNotificationPrefix)) return;
    chrome.notifications.clear(id).catch(() => { });
    if (chrome.action.openPopup) chrome.action.openPopup().catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }));
    else chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});
const ready = chrome.storage.local.get(['server', 'turnUrls', 'turnUsername', 'turnCredential', 'room', 'role', 'tabId', 'videoFrameId', 'videoReady', 'clientId', 'hostClientId', 'members', 'currentVideoUrl', 'pendingNavigation', 'sharedNavigation', 'followResponses', 'followingHost']).then(saved => { Object.assign(state, saved); if (state.room) { state.connected = false; setTimeout(() => connectRoom(), 100); } });
function persist() { chrome.storage.local.set({ server: state.server, turnUrls: state.turnUrls, turnUsername: state.turnUsername, turnCredential: state.turnCredential, room: state.room, role: state.role, status: state.status, connected: state.connected, memberCount: state.memberCount, roomLimit: state.roomLimit, dataConnections: state.dataConnections, tabId: state.tabId, videoFrameId: state.videoFrameId, videoReady: state.videoReady, clientId: state.clientId, hostClientId: state.hostClientId, members: state.members, currentVideoUrl: state.currentVideoUrl, pendingNavigation: state.pendingNavigation, sharedNavigation: state.sharedNavigation, followResponses: state.followResponses, followingHost: state.followingHost }); }
function publish() { persist(); chrome.runtime.sendMessage({ type: 'STATE', state }).catch(() => { }); }
function setStatus(status) { state.status = status; publish(); }
function sendTab(message, frameId = 0, tabId = state.tabId) { if (tabId !== null && tabId !== undefined) chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => { }); }
function sendRoomEvent(event, payload) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'room-event', event, payload })); }
function safePageUrl(value) { try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''; } catch { return ''; } }
function bestVideoFrame(tabId) { return [...videoFrames.values()].filter(x => x.tabId === tabId && x.hasVideo).sort((a, b) => b.score - a.score)[0] || null; }
function selectVideoFrame(tabId) { const v = bestVideoFrame(tabId); state.videoFrameId = v?.frameId ?? 0; return v; }
function disconnectSocket() { clearInterval(pingTimer); clearTimeout(reconnectTimer); if (socket) { socket.onclose = null; socket.close(); socket = null; } }
async function connectRoom() {
    await ready; disconnectSocket(); if (!state.server || !state.room) { setStatus('请填写服务器地址和房间码。'); return; } try { socket = new WebSocket(state.server); } catch (e) { setStatus('服务器地址无效：' + e.message); return; }
    socket.onopen = () => { state.clientId = crypto.randomUUID(); socket.send(JSON.stringify({ type: 'join', room: state.room, clientId: state.clientId })); setStatus('正在连接房间…'); pingTimer = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 20000); };
    socket.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data) } catch { return; }
        if (m.type === 'joined') { state.clientId = m.clientId; state.connected = true; state.roomLimit = m.limit || 4; state.members = [...(m.peers || []), m.clientId]; state.memberCount = state.members.length; state.hostClientId = state.role === 'host' ? m.clientId : (m.peers || [])[0] || m.clientId; if (state.role !== 'host') state.followingHost = true; setStatus('房间连接已建立。'); if (state.tabId !== null) sendTab({ type: 'ROOM_CONNECTED', role: state.role }); if (state.role !== 'host' && m.sharedNavigation) { state.sharedNavigation = m.sharedNavigation; if (state.currentVideoUrl === m.sharedNavigation.url) { state.followingHost = true; sendRoomEvent('snapshot-request', { navigationId: m.sharedNavigation.id }); } else { state.pendingNavigation = m.sharedNavigation; state.followingHost = null; notifyNavigation(m.sharedNavigation); } } else if (state.role !== 'host') sendRoomEvent('snapshot-request', { navigationId: '' }); publish(); return; }
        if (m.type === 'peer-joined') { if (!state.members.includes(m.clientId)) state.members.push(m.clientId); state.memberCount = state.members.length; if (state.sharedNavigation) state.followResponses.push({ clientId: m.clientId, status: 'pending' }); publish(); return; }
        if (m.type === 'peer-left') { state.members = state.members.filter(id => id !== m.clientId); state.memberCount = state.members.length; state.followResponses = state.followResponses.filter(x => x.clientId !== m.clientId); publish(); return; }
        if (m.type === 'signal') return;
        if (m.type === 'room-event') handleRoomEvent(m);
        if (m.type === 'error') setStatus(m.message || '服务器错误');
    };
    socket.onclose = () => { state.connected = false; if (state.room) { setStatus('服务器断开，正在重连…'); reconnectTimer = setTimeout(() => connectRoom(), 3000); } }; socket.onerror = () => setStatus('连接服务器失败；请检查地址和网络。'); publish();
}
function handleRoomEvent(m) {
    if (m.event === 'navigate' && m.from === state.hostClientId && state.role !== 'host') {
        if (!safePageUrl(m.payload?.url)) return;
        state.pendingNavigation = m.payload; state.sharedNavigation = m.payload; state.followingHost = null; state.followResponses = state.members.filter(id => id !== state.hostClientId).map(clientId => ({ clientId, status: 'pending' })); publish(); notifyNavigation(m.payload); return;
    }
    if (m.event === 'follow-response' && m.payload?.navigationId === state.sharedNavigation?.id) { const old = state.followResponses.find(x => x.clientId === m.from); if (old) old.status = m.payload.status; else state.followResponses.push({ clientId: m.from, status: m.payload.status }); publish(); return; }
    if (m.event === 'snapshot-request' && state.role === 'host' && (!m.payload?.navigationId || m.payload.navigationId === state.sharedNavigation?.id)) { sendTab({ type: 'GET_VIDEO_SNAPSHOT' }, state.videoFrameId); return; }
    if ((m.event === 'video' || m.event === 'snapshot') && m.from !== state.clientId) { if (state.role !== 'host' && state.followingHost !== true) return; if (state.role === 'host') { const response = state.followResponses.find(x => x.clientId === m.from); if (response && response.status !== 'following') return; } if (state.videoReady && state.tabId !== null) sendTab({ type: 'APPLY_REMOTE_VIDEO', videoState: m.payload }, state.videoFrameId); return; }
}
function hostPageDetected(tabId, candidate) { if (state.role !== 'host' || !state.room || !candidate?.hasVideo) return; const pageUrl = safePageUrl(candidate.pageUrl); if (!pageUrl) return; if (!state.currentVideoUrl) { state.currentVideoUrl = pageUrl; state.tabId = tabId; state.videoFrameId = candidate.frameId; state.videoReady = true; publish(); return; } if (pageUrl === state.currentVideoUrl) { if (state.tabId !== tabId) { state.tabId = tabId; state.videoFrameId = candidate.frameId; state.videoReady = true; publish(); } return; } const key = `${tabId}:${pageUrl}`; if (state.hostCandidate?.key === key) return; state.videoReady = false; state.hostCandidate = { key, tabId, frameId: candidate.frameId, url: pageUrl, title: candidate.title || '新视频' }; publish(); sendTab({ type: 'SHOW_HOST_PROMPT', url: pageUrl, title: candidate.title || '新视频' }, 0, tabId); }
async function inspectActiveTab(tabId) { if (state.role !== 'host' || !state.room) return; const candidate = bestVideoFrame(tabId); if (candidate) hostPageDetected(tabId, candidate); }
chrome.runtime.onMessage.addListener((m, sender) => {
    ready.then(async () => {
        if (m.type === 'VIDEO_FRAME' && sender.tab?.id !== undefined) {
            const tabId = sender.tab.id, frameId = sender.frameId || 0, key = `${tabId}:${frameId}`; const candidate = { tabId, frameId, hasVideo: !!m.hasVideo, score: m.score || 0, pageUrl: sender.tab.url || m.pageUrl || '', title: sender.tab.title || m.title || '新视频' }; videoFrames.set(key, candidate); if (tabId === state.tabId) { const wasReady = state.videoReady, selected = selectVideoFrame(tabId); if (selected && state.role === 'host' && selected.pageUrl === state.currentVideoUrl) state.videoReady = true; else if (selected && state.role !== 'host' && state.followingHost === true && state.pendingNavigation === null) { state.currentVideoUrl = selected.pageUrl; state.videoReady = true; if (!wasReady && state.sharedNavigation) sendRoomEvent('snapshot-request', { navigationId: state.sharedNavigation.id }); } }
            if (sender.tab.active && candidate.hasVideo) hostPageDetected(tabId, candidate); publish(); return;
        }
        if (m.type === 'VIDEO_OUT' && sender.tab?.id === state.tabId && ((sender.frameId || 0) === state.videoFrameId)) {
            if (!state.room || !state.connected || state.role !== 'host' && state.followingHost !== true || state.role === 'host' && !state.videoReady) return;
            // Followers can still send control actions, but periodic clocks and seek-in-progress samples
            // feed back against the host's own timeupdates and can undo a local pause or seek.
            if (state.role !== 'host' && !m.snapshot && ['time', 'seek'].includes(m.videoState?.action)) return;
            sendRoomEvent(m.snapshot ? 'snapshot' : 'video', m.videoState); return;
        }
        if (m.type === 'SHARE_PAGE' && state.role === 'host' && state.hostCandidate && sender.tab?.id === state.hostCandidate.tabId) { const c = state.hostCandidate, selected = bestVideoFrame(c.tabId), url = safePageUrl(c.url); if (!url) return; state.tabId = c.tabId; state.videoFrameId = selected?.frameId ?? c.frameId; state.videoReady = true; state.currentVideoUrl = url; state.sharedNavigation = { id: crypto.randomUUID(), url, title: c.title }; state.hostCandidate = null; state.followResponses = state.members.filter(id => id !== state.clientId).map(clientId => ({ clientId, status: 'pending' })); state.status = '已分享新视频，等待成员选择是否跟随。'; publish(); sendRoomEvent('navigate', state.sharedNavigation); sendTab({ type: 'GET_VIDEO_SNAPSHOT' }, state.videoFrameId); return; }
        if (m.type === 'DECLINE_SHARE' && state.hostCandidate && sender.tab?.id === state.hostCandidate.tabId) { state.tabId = state.hostCandidate.tabId; state.videoFrameId = state.hostCandidate.frameId; state.videoReady = false; state.hostCandidate = null; setStatus('本页未分享给房间。'); return; }
        if (m.type === 'FOLLOW_DECISION' && state.pendingNavigation) { const nav = state.pendingNavigation, status = m.follow ? 'following' : 'not-following'; clearNavigationNotification(nav.id); state.pendingNavigation = null; state.followingHost = !!m.follow; state.status = m.follow ? '正在跟随主机，视频页加载后会自动同步。' : '已选择不跟随主机。'; state.followResponses = state.followResponses.filter(x => x.clientId !== state.clientId); state.followResponses.push({ clientId: state.clientId, status }); if (m.follow) { state.currentVideoUrl = nav.url; state.videoReady = false; let exists = false; if (state.tabId !== null) try { await chrome.tabs.get(state.tabId); exists = true; } catch { } if (exists) chrome.tabs.update(state.tabId, { url: nav.url }); else chrome.tabs.create({ url: nav.url }, tab => { state.tabId = tab.id; publish(); }); } publish(); sendRoomEvent('follow-response', { navigationId: nav.id, status }); return; }
        if (m.type === 'SAVE_CONFIG') { state.server = m.server; state.turnUrls = m.turnUrls || ''; state.turnUsername = m.turnUsername || ''; state.turnCredential = m.turnCredential || ''; publish(); }
        else if (m.type === 'CREATE_ROOM') { state.server = m.server || state.server; state.room = Math.random().toString(36).slice(2, 8).toUpperCase(); state.role = 'host'; state.tabId = m.tabId; const tab = await chrome.tabs.get(m.tabId).catch(() => null); state.currentVideoUrl = tab?.url || ''; const frame = selectVideoFrame(state.tabId); state.videoReady = !!frame; state.clientId = ''; state.hostClientId = ''; state.members = []; state.memberCount = 0; state.dataConnections = 0; state.pendingNavigation = null; state.sharedNavigation = null; state.followResponses = []; state.followingHost = true; state.status = '正在创建房间…'; publish(); connectRoom(); }
        else if (m.type === 'JOIN_ROOM') { state.server = m.server || state.server; state.room = (m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); state.role = 'guest'; state.tabId = m.tabId; const tab = await chrome.tabs.get(m.tabId).catch(() => null); state.currentVideoUrl = tab?.url || ''; const frame = selectVideoFrame(state.tabId); state.videoReady = !!frame; state.clientId = ''; state.memberCount = 0; state.dataConnections = 0; state.pendingNavigation = null; state.sharedNavigation = null; state.followResponses = []; state.followingHost = true; if (!state.room) { setStatus('请输入房间码。'); return; } publish(); connectRoom(); }
        else if (m.type === 'LEAVE') { disconnectSocket(); sendTab({ type: 'ROOM_STOP' }); state.room = ''; state.role = ''; state.clientId = ''; state.connected = false; state.memberCount = 0; state.dataConnections = 0; state.pendingNavigation = null; state.sharedNavigation = null; state.followResponses = []; state.hostCandidate = null; state.status = '已离开房间。'; publish(); }
        else if (m.type === 'VIDEO_OUT' || m.type === 'SHARE_PAGE' || m.type === 'DECLINE_SHARE' || m.type === 'FOLLOW_DECISION') { } // handled above
        else if (m.type === 'GET_ROLE' && sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: 'ROOM_CONNECTED', role: state.role }, { frameId: sender.frameId || 0 }).catch(() => { });
    }); return true;
});
chrome.tabs.onActivated.addListener(({ tabId }) => { inspectActiveTab(tabId); });
chrome.tabs.onRemoved.addListener(tabId => { for (const [key, frame] of videoFrames) if (frame.tabId === tabId) videoFrames.delete(key); if (state.tabId === tabId) { state.tabId = null; state.videoReady = false; state.videoFrameId = 0; publish(); } });
