(() => {
  if (window.__syncWatchLoaded) return; window.__syncWatchLoaded = true;
  const isTop = window === window.top;
  let video = null, lastTimeSent = 0, lastFrameReport = '', lastFrameHadVideo = false;
  const expectedMediaEvents = new WeakMap();
  const chooseVideo = () => { const list = [...document.querySelectorAll('video')]; return list.filter(v => v.readyState > 0).sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0] || list[0] || null; };
  function videoState(v, action = 'snapshot') { return { action, time: Number(v.currentTime) || 0, paused: v.paused, rate: v.playbackRate, at: Date.now(), url: location.href }; }
  function expectMediaEvent(v, key, value) { let expected = expectedMediaEvents.get(v); if (!expected) { expected = {}; expectedMediaEvents.set(v, expected); } expected[key] = { value, expires: Date.now() + 1800 }; }
  function isExpectedMediaEvent(v, action) { const expected = expectedMediaEvents.get(v); if (!expected) return false; const now = Date.now(); for (const key of Object.keys(expected)) if (expected[key].expires < now) delete expected[key]; const key = action === 'play' || action === 'pause' ? 'paused' : action === 'ratechange' ? 'rate' : action === 'seeking' || action === 'seeked' ? 'time' : ''; const entry = key && expected[key]; if (!entry) return false; const matches = key === 'paused' ? v.paused === entry.value : key === 'rate' ? Math.abs(v.playbackRate - entry.value) < 0.03 : Math.abs(v.currentTime - entry.value) < 1.25; if (!matches) { delete expected[key]; return false; } if (action !== 'seeking') delete expected[key]; return true; }
  function sendVideo(v, action, snapshot = false) { if (isExpectedMediaEvent(v, action)) return; const now = Date.now(), seeking = action === 'seeking'; if (seeking && now - lastTimeSent < 120) return; if (action === 'time' && now - lastTimeSent < 700) return; lastTimeSent = now; chrome.runtime.sendMessage({ type: 'VIDEO_OUT', videoState: videoState(v, seeking ? 'seek' : action), snapshot }).catch(() => { }); }
  function bind(v) { if (!v || v === video) return; video = v; for (const event of ['play', 'pause', 'seeked', 'ratechange']) v.addEventListener(event, () => sendVideo(v, event), { passive: true }); v.addEventListener('seeking', () => sendVideo(v, 'seeking'), { passive: true }); v.addEventListener('timeupdate', () => sendVideo(v, v.seeking ? 'seeking' : 'time'), { passive: true }); }
  async function applyVideo(s) { const v = chooseVideo(); if (!s || !v) return; bind(v); const target = (s.time || 0) + (s.paused ? 0 : Math.min(Math.max(0, (Date.now() - s.at) / 1000), 1.5)); if (Math.abs(target - v.currentTime) > 0.8) { const seekTo = Math.max(0, target); expectMediaEvent(v, 'time', seekTo); v.currentTime = seekTo; } if (s.rate && Math.abs(v.playbackRate - s.rate) > 0.03) { expectMediaEvent(v, 'rate', s.rate); v.playbackRate = s.rate; } if (s.paused) { if (!v.paused) { expectMediaEvent(v, 'paused', true); v.pause(); } } else if (v.paused) { expectMediaEvent(v, 'paused', false); await v.play().catch(() => { }); } }
  function showPrompt(kind, data) {
    if (!isTop) return; document.getElementById('__sync_watch_prompt')?.remove(); const host = kind === 'host', root = document.createElement('div'); root.id = '__sync_watch_prompt'; root.style.cssText = 'position:fixed;z-index:2147483647;top:18px;right:18px;width:min(390px,calc(100vw - 36px));padding:15px;background:#151827;color:#f4f5fb;border:1px solid #6f62db;border-radius:12px;box-shadow:0 12px 38px #0008;font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
    const title = document.createElement('strong'); title.textContent = host ? '分享新视频？' : '主机分享了新视频'; title.style.cssText = 'display:block;font-size:15px;margin-bottom:5px';
    const desc = document.createElement('div'); desc.textContent = data.title || data.url || '新视频'; desc.style.cssText = 'color:#b8bfd1;overflow-wrap:anywhere;margin-bottom:12px';
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const button = (label, primary, handler) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = `border:0;border-radius:8px;padding:8px 12px;background:${primary ? '#7666f4' : '#2a3040'};color:#fff;font-weight:600;cursor:pointer`; b.onclick = handler; actions.append(b); };
    if (host) { button('暂不分享', false, () => { chrome.runtime.sendMessage({ type: 'DECLINE_SHARE' }); root.remove(); }); button('分享给房间', true, () => { chrome.runtime.sendMessage({ type: 'SHARE_PAGE' }); root.remove(); }); }
    else { button('不跟随', false, () => { chrome.runtime.sendMessage({ type: 'FOLLOW_DECISION', follow: false }); root.remove(); }); button('跟随跳转', true, () => { chrome.runtime.sendMessage({ type: 'FOLLOW_DECISION', follow: true }); root.remove(); }); }
    root.append(title, desc, actions); document.documentElement.append(root);
  }
  chrome.runtime.onMessage.addListener(m => {
    if (m.type === 'APPLY_REMOTE_VIDEO') applyVideo(m.videoState);
    else if (m.type === 'SHOW_HOST_PROMPT') showPrompt('host', m);
    else if (m.type === 'HIDE_ROOM_PROMPT') document.getElementById('__sync_watch_prompt')?.remove();
    else if (m.type === 'GET_VIDEO_SNAPSHOT') { const v = chooseVideo(); if (v) sendVideo(v, 'snapshot', true); }
  });
  function reportVideoFrame() { const v = chooseVideo(); if (v !== video) bind(v); let score = 0; if (v) { const rect = v.getBoundingClientRect(), style = getComputedStyle(v), visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; if (visible) score = Math.round(rect.width * rect.height); } const hasVideo = !!v && v.readyState > 0, key = `${location.href}:${v ? `${score}:${v.readyState}:${v.videoWidth}x${v.videoHeight}` : 'none'}`; if (key !== lastFrameReport) { lastFrameReport = key; if (hasVideo || lastFrameHadVideo) chrome.runtime.sendMessage({ type: 'VIDEO_FRAME', hasVideo, score, pageUrl: location.href, title: document.title }).catch(() => { }); lastFrameHadVideo = hasVideo; } }
  bind(chooseVideo()); reportVideoFrame(); new MutationObserver(() => { bind(chooseVideo()); reportVideoFrame(); }).observe(document.documentElement, { childList: true, subtree: true });
  for (const event of ['popstate', 'hashchange']) window.addEventListener(event, reportVideoFrame);
  setInterval(() => { if (!video || !video.isConnected) bind(chooseVideo()); reportVideoFrame(); }, 2500);
})();
