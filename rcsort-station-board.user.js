// ==UserScript==
// @name         RC Sort Station Board (IMO1)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Floating RC Sort station-map overlay for the belkamus-quantum IMO1 SPA. Shared mode mirrors the localhost:8765 app (roster, FCLM rates, photos, assignments); Solo mode is fully isolated. Original app code is untouched.
// @author       Tyler
// @updateURL    https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/rcsort-station-board.user.js
// @downloadURL  https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/rcsort-station-board.user.js
// @match        *://belkamus-quantum.sdo.amazon.dev/main/IMO1/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────
  // CONFIG
  // ────────────────────────────────────────────────────────────────
  const BACKEND   = 'http://localhost:8765';   // the untouched RCSort app
  const STANDARD  = 250;                        // UPH standard
  const POLL_MS   = 3000;                        // shared-mode assignment poll
  const STATIONS  = Array.from({ length: 20 }, (_, i) => 'C-' + String(i + 1).padStart(2, '0'));

  // Persisted UI prefs
  let mode   = GM_getValue('rcsort_mode', 'shared');   // 'shared' | 'solo'
  let openUI = GM_getValue('rcsort_open', false);
  let wh     = GM_getValue('rcsort_wh', 'IMO1');

  // Runtime state
  let allAssociates = [];
  let assignments   = mode === 'solo' ? GM_getValue('rcsort_solo_assign', {}) : {};
  let pollTimer     = null;

  // ────────────────────────────────────────────────────────────────
  // TRANSPORT — GM_xmlhttpRequest wrapper (bypasses CORS to localhost)
  // ────────────────────────────────────────────────────────────────
  function api(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: BACKEND + path,
        timeout: 15000,
        onload: r => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error('Bad JSON from backend')); }
        },
        onerror:   () => reject(new Error('Backend unreachable')),
        ontimeout: () => reject(new Error('Backend timeout')),
      });
    });
  }

  // Badge photo as a blob URL (GM fetch → objectURL, since <img src> can't cross origin here)
  const photoCache = {};
  function loadPhoto(empId, imgEl) {
    if (!empId) return;
    if (photoCache[empId]) { imgEl.src = photoCache[empId]; imgEl.style.display = 'block'; return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: BACKEND + '/api/photo?id=' + encodeURIComponent(empId),
      responseType: 'blob',
      onload: r => {
        if (r.status !== 200 || !r.response || r.response.size < 100) return;
        const url = URL.createObjectURL(r.response);
        photoCache[empId] = url;
        imgEl.src = url;
        imgEl.style.display = 'block';
      },
    });
  }

  // ────────────────────────────────────────────────────────────────
  // STYLES  (scoped under #rcsort-root to avoid fighting the SPA)
  // ────────────────────────────────────────────────────────────────
  const CSS = `
  #rcsort-fab {
    position:fixed; bottom:20px; right:20px; z-index:2147483000;
    background:#131921; color:#fff; border:2px solid #FF9900; border-radius:50px;
    padding:10px 18px; font:700 13px "Amazon Ember",Arial,sans-serif; cursor:pointer;
    box-shadow:0 4px 16px rgba(0,0,0,.35); display:flex; align-items:center; gap:8px;
  }
  #rcsort-fab span { color:#FF9900; }
  #rcsort-root, #rcsort-root * { box-sizing:border-box; }
  #rcsort-root {
    position:fixed; top:60px; right:20px; z-index:2147483001; width:820px; max-width:calc(100vw - 40px);
    height:78vh; background:#f0f2f5; border-radius:12px; overflow:hidden; display:none;
    flex-direction:column; box-shadow:0 12px 48px rgba(0,0,0,.4);
    font-family:"Amazon Ember",Arial,sans-serif; color:#111;
  }
  #rcsort-root.open { display:flex; }
  .rc-hdr { background:#131921; color:#fff; height:48px; flex-shrink:0; display:flex;
    align-items:center; gap:10px; padding:0 14px; cursor:move; user-select:none; }
  .rc-hdr .bar { width:3px; height:24px; background:#FF9900; border-radius:2px; }
  .rc-hdr h1 { font-size:1rem; font-weight:700; } .rc-hdr h1 em{color:#FF9900;font-style:normal;}
  .rc-badge { background:#FF9900; color:#131921; font:800 .62rem/1 sans-serif; padding:3px 7px; border-radius:3px; letter-spacing:1px; }
  .rc-spacer { flex:1; }
  .rc-btn { padding:5px 11px; border:none; border-radius:4px; font:600 .74rem sans-serif; cursor:pointer; }
  .rc-btn.pri { background:#FF9900; color:#131921; }
  .rc-btn.out { background:transparent; border:1px solid #555; color:#ccc; }
  .rc-mode { display:flex; border:1px solid #555; border-radius:5px; overflow:hidden; }
  .rc-mode button { background:transparent; color:#aaa; border:none; padding:4px 10px; font:700 .68rem sans-serif; cursor:pointer; }
  .rc-mode button.on { background:#FF9900; color:#131921; }
  .rc-close { background:none; border:none; color:#ccc; font-size:1.1rem; cursor:pointer; padding:2px 6px; }
  .rc-sum { display:flex; gap:8px; padding:10px 14px 0; flex-wrap:wrap; }
  .rc-stat { background:#fff; border:1px solid #ddd; border-radius:6px; padding:7px 12px; flex:1; min-width:88px; }
  .rc-stat .l { font:600 .6rem sans-serif; color:#666; text-transform:uppercase; letter-spacing:.5px; }
  .rc-stat .v { font:700 1.25rem sans-serif; margin-top:1px; }
  .rc-stat.g .v{color:#1e8a3a;} .rc-stat.y .v{color:#d68910;} .rc-stat.r .v{color:#c0392b;}
  .rc-body { display:flex; flex:1; overflow:hidden; }
  .rc-panel { width:190px; min-width:190px; background:#fff; border-right:1px solid #ddd; display:flex; flex-direction:column; }
  .rc-psrch { padding:8px; border-bottom:1px solid #eee; }
  .rc-psrch input { width:100%; padding:5px 9px; border:1px solid #ddd; border-radius:4px; font-size:.78rem; outline:none; }
  .rc-list { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
  .rc-list:empty::after { content:"No associates. Hit Refresh."; color:#bbb; font-size:.75rem; text-align:center; display:block; padding:24px 8px; }
  .rc-card { background:#f8f9fa; border:1px solid #ddd; border-radius:6px; padding:6px 9px; cursor:grab; display:flex; gap:8px; align-items:center; }
  .rc-card.assigned { opacity:.45; border-style:dashed; cursor:default; }
  .rc-card.dragging { opacity:.35; }
  .rc-av { width:34px; height:34px; border-radius:50%; flex-shrink:0; background:#146EB4; color:#fff; display:flex; align-items:center; justify-content:center; font:800 .7rem sans-serif; overflow:hidden; border:2px solid #dde4f0; }
  .rc-av img { width:100%; height:100%; object-fit:cover; display:none; }
  .rc-cinfo { flex:1; min-width:0; }
  .rc-cn { font:700 .76rem sans-serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .rc-cm { font:.64rem sans-serif; color:#666; display:flex; justify-content:space-between; margin-top:2px; }
  .rc-cr { font:700 .68rem sans-serif; color:#146EB4; }
  .rc-grid-wrap { flex:1; overflow-y:auto; padding:12px 14px 16px; }
  .rc-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; }
  .rc-tile { aspect-ratio:1/1; background:#fff; border:2px solid #ddd; border-radius:8px; display:flex; flex-direction:column; align-items:center; justify-content:center; position:relative; }
  .rc-tile.drag-over { border-color:#FF9900; background:#fff8ee; }
  .rc-tile.occupied { border-color:#aec8e8; background:#f0f6ff; }
  .rc-tile.above { border-color:#1e8a3a; background:#f0faf3; }
  .rc-tile.at    { border-color:#d68910; background:#fffbf0; }
  .rc-tile.below { border-color:#c0392b; background:#fff5f5; }
  .rc-tid { font:800 1rem sans-serif; }
  .rc-tav { width:30px; height:30px; border-radius:50%; overflow:hidden; border:2px solid rgba(255,255,255,.7); margin:3px 0; background:#146EB4; color:#fff; display:flex; align-items:center; justify-content:center; font:800 .55rem sans-serif; }
  .rc-tav img { width:100%; height:100%; object-fit:cover; display:none; }
  .rc-tn { font:600 .62rem sans-serif; color:#666; text-transform:uppercase; max-width:90%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rc-trate { font:700 .78rem sans-serif; margin-top:3px; color:#bbb; }
  .rc-tile.above .rc-trate{color:#1e8a3a;} .rc-tile.at .rc-trate{color:#d68910;} .rc-tile.below .rc-trate{color:#c0392b;}
  .rc-trm { position:absolute; top:3px; left:5px; font:700 .62rem sans-serif; color:#bbb; cursor:pointer; display:none; }
  .rc-tile:hover .rc-trm { display:block; } .rc-trm:hover { color:#c0392b; }
  .rc-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(60px); background:#131921; color:#fff; padding:9px 18px; border-radius:6px; font:600 .8rem sans-serif; z-index:2147483002; opacity:0; transition:.25s; }
  .rc-toast.show { transform:translateX(-50%) translateY(0); opacity:1; }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ────────────────────────────────────────────────────────────────
  // DOM SCAFFOLD
  // ────────────────────────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = 'rcsort-fab';
  fab.innerHTML = 'RC <span>Sort</span> Board';
  document.body.appendChild(fab);

  const root = document.createElement('div');
  root.id = 'rcsort-root';
  root.innerHTML = `
    <div class="rc-hdr" id="rcHdr">
      <div class="bar"></div>
      <h1>RC <em>Sort</em></h1>
      <span class="rc-badge" id="rcWh">${wh}</span>
      <div class="rc-mode" id="rcMode">
        <button data-m="shared">Shared</button>
        <button data-m="solo">Solo</button>
      </div>
      <span id="rcConn" style="font:.62rem sans-serif;color:#888;">●</span>
      <div class="rc-spacer"></div>
      <button class="rc-btn out" id="rcClear">Clear</button>
      <button class="rc-btn pri" id="rcRefresh">↺ Refresh</button>
      <button class="rc-close" id="rcCloseBtn">✕</button>
    </div>
    <div class="rc-sum">
      <div class="rc-stat"><div class="l">On Sort</div><div class="v" id="rcTotal">—</div></div>
      <div class="rc-stat g"><div class="l">Above</div><div class="v" id="rcAbove">—</div></div>
      <div class="rc-stat y"><div class="l">At Std</div><div class="v" id="rcAt">—</div></div>
      <div class="rc-stat r"><div class="l">Below</div><div class="v" id="rcBelow">—</div></div>
      <div class="rc-stat"><div class="l">Avg UPH</div><div class="v" id="rcAvg">—</div></div>
      <div class="rc-stat"><div class="l">Std</div><div class="v">${STANDARD}</div></div>
    </div>
    <div class="rc-body">
      <div class="rc-panel">
        <div class="rc-psrch"><input id="rcSearch" placeholder="Search name…"/></div>
        <div class="rc-list" id="rcList"></div>
      </div>
      <div class="rc-grid-wrap"><div class="rc-grid" id="rcGrid"></div></div>
    </div>
  `;
  document.body.appendChild(root);

  const $ = id => root.querySelector('#' + id);

  // ────────────────────────────────────────────────────────────────
  // HELPERS
  // ────────────────────────────────────────────────────────────────
  function initials(name) {
    const p = (name || '').split(',');
    return (((p[1]||'').trim()[0]||'') + ((p[0]||'').trim()[0]||'')).toUpperCase() || '?';
  }
  function makeAvatar(name, empId, cls) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = initials(name);
    if (empId && mode === 'shared') {
      const img = document.createElement('img');
      d.appendChild(img);
      loadPhoto(empId, img);
    }
    return d;
  }
  let toastTimer;
  function toast(msg, err) {
    let t = document.getElementById('rcsort-toast');
    if (!t) { t = document.createElement('div'); t.id = 'rcsort-toast'; t.className = 'rc-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.background = err ? '#c0392b' : '#131921';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function persistSolo() { if (mode === 'solo') GM_setValue('rcsort_solo_assign', assignments); }

  // ────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────
  function renderAll() { renderAssociates(); renderStations(); updateSummary(); }

  function renderAssociates() {
    const list = $('rcList');
    const q = $('rcSearch').value.toLowerCase();
    const assigned = new Set(Object.values(assignments));
    list.innerHTML = '';
    allAssociates.filter(a => !q || a.name.toLowerCase().includes(q)).forEach(a => {
      const isA = assigned.has(a.id);
      const card = document.createElement('div');
      card.className = 'rc-card' + (isA ? ' assigned' : '');
      card.draggable = !isA;
      const rateStr = a.rate ? a.rate + ' UPH' : a.total ? a.total.toFixed(1) + ' hrs' : '—';
      card.appendChild(makeAvatar(a.name, a.id, 'rc-av'));
      const info = document.createElement('div');
      info.className = 'rc-cinfo';
      info.innerHTML = `<div class="rc-cn" title="${a.name}">${a.name}</div>
        <div class="rc-cm"><span>${isA ? '📍 Assigned' : 'Drag →'}</span><span class="rc-cr">${rateStr}</span></div>`;
      card.appendChild(info);
      if (!isA) {
        card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', a.id); card.classList.add('dragging'); });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
      }
      list.appendChild(card);
    });
  }

  function renderStations() {
    const grid = $('rcGrid');
    grid.innerHTML = '';
    STATIONS.forEach(stn => {
      const aId = assignments[stn] || null;
      const assoc = aId ? allAssociates.find(a => a.id === aId) : null;
      const rate = assoc && assoc.rate ? assoc.rate : null;
      const pct = rate ? Math.round(rate / STANDARD * 100) : null;
      let tier = '';
      if (pct !== null) tier = pct >= 105 ? 'above' : pct >= 90 ? 'at' : 'below';
      else if (assoc) tier = 'occupied';
      const tile = document.createElement('div');
      tile.className = ['rc-tile', tier].filter(Boolean).join(' ');
      tile.innerHTML = (assoc ? `<span class="rc-trm">✕</span>` : '') + `<div class="rc-tid">${stn}</div>`;
      if (assoc) tile.appendChild(makeAvatar(assoc.name, assoc.id, 'rc-tav'));
      const nm = document.createElement('div'); nm.className = 'rc-tn';
      nm.textContent = assoc ? assoc.name.split(',')[0].trim() : 'Empty';
      const rt = document.createElement('div'); rt.className = 'rc-trate';
      rt.textContent = rate ? rate + ' UPH' : assoc ? '— UPH' : '—';
      tile.appendChild(nm); tile.appendChild(rt);
      if (assoc) tile.querySelector('.rc-trm').addEventListener('click', () => removeAssignment(stn));
      tile.addEventListener('dragover', e => { e.preventDefault(); tile.classList.add('drag-over'); });
      tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
      tile.addEventListener('drop', e => {
        e.preventDefault(); tile.classList.remove('drag-over');
        assignToStation(e.dataTransfer.getData('text/plain'), stn);
      });
      grid.appendChild(tile);
    });
  }

  function updateSummary() {
    const n = allAssociates.length;
    const rates = allAssociates.map(a => a.rate).filter(Boolean);
    const above = rates.filter(r => r >= STANDARD * 1.05).length;
    const at    = rates.filter(r => r >= STANDARD * 0.9 && r < STANDARD * 1.05).length;
    const below = rates.filter(r => r < STANDARD * 0.9).length;
    const avg   = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
    $('rcTotal').textContent = n || '—';
    $('rcAbove').textContent = above || '—';
    $('rcAt').textContent    = at || '—';
    $('rcBelow').textContent = below || '—';
    $('rcAvg').textContent   = avg || '—';
  }

  // ────────────────────────────────────────────────────────────────
  // ASSIGN / REMOVE  (shared → backend, solo → GM storage)
  // ────────────────────────────────────────────────────────────────
  function assignToStation(aId, stn) {
    if (!aId) return;
    Object.keys(assignments).forEach(k => { if (assignments[k] === aId) delete assignments[k]; });
    assignments[stn] = aId;
    renderStations(); renderAssociates();
    const a = allAssociates.find(x => x.id === aId);
    toast(`${a ? a.name.split(',')[0] : aId} → ${stn}`);
    if (mode === 'shared') api(`/api/assign?station=${encodeURIComponent(stn)}&associate=${encodeURIComponent(aId)}`).catch(() => {});
    else persistSolo();
  }
  function removeAssignment(stn) {
    delete assignments[stn];
    renderStations(); renderAssociates();
    if (mode === 'shared') api(`/api/assign?station=${encodeURIComponent(stn)}&clear=1`).catch(() => {});
    else persistSolo();
  }
  function clearAll() {
    if (!confirm('Clear all station assignments?')) return;
    assignments = {};
    renderAll();
    toast('Assignments cleared');
    if (mode === 'shared') api('/api/assignments/clear').catch(() => {});
    else persistSolo();
  }

  // ────────────────────────────────────────────────────────────────
  // DATA LOAD
  // ────────────────────────────────────────────────────────────────
  async function refresh() {
    const btn = $('rcRefresh');
    btn.textContent = '↺ …';
    if (mode === 'solo') {
      // Solo mode: pull roster from backend if reachable, else keep manual list
      try {
        const data = await api('/api/roster');
        if (data.ok && allAssociates.length === 0) {
          allAssociates = data.associates.map(a => ({ id: a.id || a.login || a.name, name: a.name, rate: null, total: null }));
        }
        toast('Roster loaded (Solo — no live rates)');
      } catch { toast('Backend offline — Solo uses saved list', true); }
      renderAll(); btn.textContent = '↺ Refresh'; return;
    }
    // Shared mode: real FCLM pull
    try {
      const now = new Date();
      const date = now.getFullYear() + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + String(now.getDate()).padStart(2, '0');
      const data = await api(`/api/associates?date=${encodeURIComponent(date)}&startHour=7&startMin=0&endHour=18&endMin=0&warehouseId=${wh}`);
      if (data.authRequired) { toast('Midway expired — log in, then Refresh', true); btn.textContent = '↺ Refresh'; return; }
      if (!data.ok) throw new Error(data.error || 'error');
      allAssociates = data.associates;
      renderAll();
      toast(`Loaded ${data.count} associates`);
    } catch (e) {
      toast('Backend offline — start RCSort.bat', true);
    }
    btn.textContent = '↺ Refresh';
  }

  // Shared-mode polling for coworker assignment changes (replaces SSE)
  function startPoll() {
    stopPoll();
    if (mode !== 'shared') return;
    pollTimer = setInterval(async () => {
      try {
        const data = await api('/api/assignments');
        const incoming = (data && (data.assignments || data)) || {};
        if (incoming && typeof incoming === 'object' && JSON.stringify(incoming) !== JSON.stringify(assignments)) {
          assignments = incoming; renderAll();
        }
        $('rcConn').style.color = '#1e8a3a';
      } catch { $('rcConn').style.color = '#c0392b'; }
    }, POLL_MS);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // ────────────────────────────────────────────────────────────────
  // MODE SWITCH
  // ────────────────────────────────────────────────────────────────
  function setMode(m) {
    if (m === mode) return;
    mode = m; GM_setValue('rcsort_mode', m);
    root.querySelectorAll('#rcMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    assignments = m === 'solo' ? (GM_getValue('rcsort_solo_assign', {}) || {}) : {};
    allAssociates = [];
    renderAll();
    stopPoll();
    if (m === 'shared') startPoll();
    toast(m === 'shared' ? 'Shared mode — synced with app' : 'Solo mode — isolated');
    refresh();
  }

  // ────────────────────────────────────────────────────────────────
  // WIRING
  // ────────────────────────────────────────────────────────────────
  function openBoard() { root.classList.add('open'); GM_setValue('rcsort_open', true); if (mode === 'shared') startPoll(); }
  function closeBoard() { root.classList.remove('open'); GM_setValue('rcsort_open', false); stopPoll(); }

  fab.addEventListener('click', openBoard);
  $('rcCloseBtn').addEventListener('click', closeBoard);
  $('rcClear').addEventListener('click', clearAll);
  $('rcRefresh').addEventListener('click', refresh);
  $('rcSearch').addEventListener('input', renderAssociates);
  root.querySelectorAll('#rcMode button').forEach(b => {
    b.classList.toggle('on', b.dataset.m === mode);
    b.addEventListener('click', () => setMode(b.dataset.m));
  });

  // Draggable header
  (function drag() {
    const hdr = $('rcHdr'); let sx, sy, ox, oy, on = false;
    hdr.addEventListener('mousedown', e => {
      if (e.target.closest('button') || e.target.closest('.rc-mode')) return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
      root.style.right = 'auto'; document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', e => {
      if (!on) return;
      root.style.left = (ox + e.clientX - sx) + 'px';
      root.style.top  = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { on = false; document.body.style.userSelect = ''; });
  })();

  // ────────────────────────────────────────────────────────────────
  // INIT
  // ────────────────────────────────────────────────────────────────
  renderAll();
  if (openUI) openBoard();
  refresh();

})();
