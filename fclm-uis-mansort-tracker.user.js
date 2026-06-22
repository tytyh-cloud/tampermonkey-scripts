// ==UserScript==
// @name         FCLM UIS / ManSort Tracker
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Floating overlay — UIS 5LB, UIS 20LB, ManSort rates from FCLM
// @author       Tyler
// @match        *://fclm-portal.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      fclm-portal.amazon.com
// ==/UserScript==

(function () {
  'use strict';

  const WH = 'RFD2';
  const REFRESH_MS = 60000;
  const INTRA_TAIL =
    '&startHourIntraday1=0&startMinuteIntraday1=0' +
    '&startHourIntraday2=0&startMinuteIntraday2=0' +
    '&startHourIntraday3=0&startMinuteIntraday3=0' +
    '&startHourIntraday4=0&startMinuteIntraday4=0';

  // ── Persisted config ─────────────────────────────────────────────────────
  let cfg = {
    startDate:   GM_getValue('ums_startDate',   '2026/06/21'),
    startHour:   GM_getValue('ums_startHour',   19),
    startMin:    GM_getValue('ums_startMin',     0),
    endDate:     GM_getValue('ums_endDate',     '2026/06/22'),
    endHour:     GM_getValue('ums_endHour',      6),
    endMin:      GM_getValue('ums_endMin',       30),
    t5lb:        GM_getValue('ums_t5lb',        ''),
    t20lb:       GM_getValue('ums_t20lb',       ''),
    tManSort:    GM_getValue('ums_tManSort',    ''),
    autoRefresh: GM_getValue('ums_autoRefresh', true),
  };

  let rates = {
    uis5lb:  { rate: null, units: null, hours: null },
    uis20lb: { rate: null, units: null, hours: null },
    manSort: { rate: null, units: null, hours: null },
  };
  let lastUpdated = null;
  let refreshTimer = null;
  let fetching = false;

  const toInput   = s => s.replace(/\//g, '-');
  const fromInput = s => s.replace(/-/g, '/');
  const pad2      = n => String(n).padStart(2, '0');
  const enc       = s => encodeURIComponent(s);

  // ── URL builder ──────────────────────────────────────────────────────────
  function buildURL() {
    return 'https://fclm-portal.amazon.com/reports/functionRollup?' +
      'reportFormat=HTML&warehouseId=' + WH + '&processId=1003009&maxIntradayDays=1&spanType=Intraday' +
      '&startDateIntraday=' + enc(cfg.startDate) + '&startHourIntraday=' + cfg.startHour + '&startMinuteIntraday=' + cfg.startMin +
      '&endDateIntraday='   + enc(cfg.endDate)   + '&endHourIntraday='   + cfg.endHour  + '&endMinuteIntraday='   + cfg.endMin +
      INTRA_TAIL;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────
  function httpGet(url) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method:  'GET',
      url,
      onload:  r => r.status === 200 ? res(r.responseText) : rej(new Error('HTTP ' + r.status)),
      onerror: () => rej(new Error('Network error')),
    }));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  // Return the nth numeric value (0-based) from a table row, skipping non-numeric cells.
  function nthNum(row, n) {
    var cells = row.querySelectorAll('td');
    var count = 0;
    for (var i = 0; i < cells.length; i++) {
      var v = parseFloat(cells[i].textContent.trim().replace(/,/g, ''));
      if (!isNaN(v)) { if (count === n) return v; count++; }
    }
    return null;
  }

  // ── Parser ───────────────────────────────────────────────────────────────
  // Every Total row has this numeric pattern (one active activity group):
  //   [0] Total Paid Hours  [1] Jobs  [2] JPH  [3] EACH UNIT  [4] EACH UPH
  // Empty cells in inactive groups are NaN and are skipped by nthNum.
  // This works for both UIS (ItemInducted active) and RC Sort (PresortItemSc active).
  function parseFunctionRow(html, fnName) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var tables = doc.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      if (tables[t].textContent.toLowerCase().indexOf(fnName.toLowerCase()) < 0) continue;
      var rows = tables[t].querySelectorAll('tr');
      var foundFn = false;
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('td');
        if (!cells.length) continue;
        if (rows[r].textContent.toLowerCase().indexOf(fnName.toLowerCase()) >= 0) foundFn = true;
        if (!foundFn) continue;
        if (cells[0].textContent.trim() !== 'Total') continue;
        var rate  = nthNum(rows[r], 4); // 5th numeric = EACH UPH
        var units = nthNum(rows[r], 3); // 4th numeric = EACH UNIT
        var hours = nthNum(rows[r], 0); // 1st numeric = Total Paid Hours
        if (rate !== null) {
          console.log('[FCLM UMS] ' + fnName + ' UPH=' + rate + ' units=' + units + ' hrs=' + hours);
          return { rate: rate, units: units, hours: hours };
        }
      }
    }
    console.log('[FCLM UMS] ' + fnName + ': Total row not found');
    return { rate: null, units: null, hours: null };
  }

  // ── Colors ───────────────────────────────────────────────────────────────
  function getColors(rate, target) {
    var t = parseFloat(target);
    if (!rate || !t || isNaN(t))
      return { bg: 'rgba(71,85,105,0.25)', border: '#334155', val: '#64748b', pct: '—' };
    var p = rate / t;
    if (p >= 1.00) return { bg: 'rgba(34,197,94,0.13)',  border: '#22c55e', val: '#4ade80', pct: Math.round(p * 100) + '%' };
    if (p >= 0.85) return { bg: 'rgba(245,158,11,0.13)', border: '#f59e0b', val: '#fbbf24', pct: Math.round(p * 100) + '%' };
    return              { bg: 'rgba(239,68,68,0.13)',   border: '#ef4444', val: '#f87171', pct: Math.round(p * 100) + '%' };
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function renderCard(id, rate, units, hours, target, label, extraStyle) {
    var el = document.getElementById('ums-c-' + id);
    if (!el) return;
    var c = getColors(rate, target);
    var t = parseFloat(target);
    el.style.cssText = 'background:' + c.bg + ';border:1px solid ' + c.border +
      ';border-radius:8px;padding:10px;min-height:96px;transition:border-color 0.3s,background 0.3s;' + (extraStyle || '');
    el.innerHTML =
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</div>' +
      '<div style="font-size:22px;font-weight:900;color:' + c.val + ';line-height:1.1;">' + (rate !== null ? rate.toFixed(1) : '—') + '</div>' +
      '<div style="font-weight:900;font-size:10px;color:#cbd5e1;margin-top:1px;">UPH</div>' +
      '<div style="font-size:12px;font-weight:900;color:#cbd5e1;margin-top:2px;">' + (units !== null ? units.toLocaleString() + ' units' : '') + '</div>' +
      '<div style="font-size:12px;font-weight:900;color:#94a3b8;margin-top:2px;">' + (hours !== null ? hours.toFixed(2) + ' hrs' : '') + '</div>' +
      '<div style="font-weight:900;margin-top:4px;font-size:11px;color:#cbd5e1;">Target: <span style="color:' + c.val + ';">' + (t ? t.toFixed(0) : 'Not set') + '</span></div>' +
      '<div style="font-size:12px;font-weight:900;color:' + c.val + ';margin-top:2px;">' + c.pct + '</div>';
  }

  function renderAll() {
    renderCard('uis5lb',  rates.uis5lb.rate,  rates.uis5lb.units,  rates.uis5lb.hours,  cfg.t5lb,     'UIS 5LB');
    renderCard('uis20lb', rates.uis20lb.rate, rates.uis20lb.units, rates.uis20lb.hours, cfg.t20lb,    'UIS 20LB');
    renderCard('manSort', rates.manSort.rate, rates.manSort.units, rates.manSort.hours, cfg.tManSort, 'MS Rate', 'grid-column:1/-1;');
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  async function fetchAll() {
    if (fetching) return;
    fetching = true;
    setStatus('⟳ Fetching…');
    var btn = document.getElementById('ums-fetch');
    if (btn) btn.disabled = true;
    try {
      var html = await httpGet(buildURL());
      rates.uis5lb  = parseFunctionRow(html, 'UIS_5lb_SCP_Induct');
      rates.uis20lb = parseFunctionRow(html, 'UIS_20lb_SCP_Induct');
      rates.manSort = parseFunctionRow(html, 'RC Sort Primary');
      lastUpdated = new Date();
      renderAll();
      setStatus('Updated ' + lastUpdated.toLocaleTimeString());
    } catch (e) {
      setStatus('⚠ ' + e.message);
      console.error('[FCLM UMS]', e);
    } finally {
      fetching = false;
      if (btn) btn.disabled = false;
    }
  }

  function setStatus(msg) {
    var el = document.getElementById('ums-status');
    if (el) el.textContent = msg;
  }

  // ── Timer ────────────────────────────────────────────────────────────────
  function startTimer() { stopTimer(); if (cfg.autoRefresh) refreshTimer = setInterval(fetchAll, REFRESH_MS); }
  function stopTimer()  { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  // ── Apply settings ───────────────────────────────────────────────────────
  function applySettings() {
    cfg.startDate  = fromInput(document.getElementById('ums-sdate').value) || cfg.startDate;
    cfg.startHour  = parseInt(document.getElementById('ums-shour').value, 10) || 0;
    cfg.startMin   = parseInt(document.getElementById('ums-smin').value,  10) || 0;
    cfg.endDate    = fromInput(document.getElementById('ums-edate').value) || cfg.endDate;
    cfg.endHour    = parseInt(document.getElementById('ums-ehour').value, 10) || 0;
    cfg.endMin     = parseInt(document.getElementById('ums-emin').value,  10) || 0;
    cfg.t5lb       = document.getElementById('ums-t-5lb').value;
    cfg.t20lb      = document.getElementById('ums-t-20lb').value;
    cfg.tManSort   = document.getElementById('ums-t-mansort').value;
    Object.keys(cfg).forEach(function(k) { GM_setValue('ums_' + k, cfg[k]); });
    renderAll();
    fetchAll();
  }

  function toggleAuto() {
    cfg.autoRefresh = !cfg.autoRefresh;
    GM_setValue('ums_autoRefresh', cfg.autoRefresh);
    var b = document.getElementById('ums-auto');
    if (b) {
      b.textContent       = 'Auto: ' + (cfg.autoRefresh ? 'ON' : 'OFF');
      b.style.background  = cfg.autoRefresh ? '#14532d' : '#374151';
      b.style.borderColor = cfg.autoRefresh ? '#16a34a' : '#4b5563';
    }
    cfg.autoRefresh ? startTimer() : stopTimer();
  }

  // ── Style helpers ────────────────────────────────────────────────────────
  var BASE = 'box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;font-size:12px;';
  var S_INP = BASE + 'background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e2e8f0;outline:none;padding:4px 6px;width:100%;';
  var S_SM  = BASE + 'background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e2e8f0;outline:none;padding:4px 2px;width:44px;text-align:center;';
  function S_BTN(bg, bd) {
    return BASE + 'background:' + bg + ';border:1px solid ' + bd + ';border-radius:4px;color:#e2e8f0;cursor:pointer;font-weight:600;';
  }

  // ── Build panel ──────────────────────────────────────────────────────────
  var panel = document.createElement('div');
  panel.id = 'ums-rt-panel';
  panel.style.cssText = [
    'position:fixed', 'top:20px', 'right:440px', 'width:400px',
    'background:#0d1117', 'border:1px solid #21262d', 'border-radius:10px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.7)', 'color:#e2e8f0',
    'z-index:2147483647', 'font-family:system-ui,-apple-system,sans-serif',
    'font-size:13px',
  ].join(';');

  panel.innerHTML = [
    '<div id="ums-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:#161b22;border-radius:10px 10px 0 0;cursor:grab;border-bottom:1px solid #21262d;">',
      '<span id="ums-title" style="font-weight:900;font-size:13px;color:#f1f5f9;letter-spacing:0.2px;">📦 UIS / ManSort Tracker</span>',
      '<div style="display:flex;gap:10px;align-items:center;">',
        '<span id="ums-gear"    title="Settings" style="font-weight:900;cursor:pointer;opacity:0.55;font-size:14px;line-height:1;">⚙️</span>',
        '<span id="ums-min-btn" title="Minimize" style="font-weight:900;cursor:pointer;opacity:0.55;font-size:18px;line-height:1;margin-top:-1px;">−</span>',
      '</div>',
    '</div>',

    '<div id="ums-settings" style="display:none;padding:12px 14px;border-bottom:1px solid #21262d;background:#0d1117;">',
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#30363d;margin-bottom:8px;">Shift Window</div>',
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;">',
        '<span style="font-weight:900;width:34px;font-size:11px;color:#484f58;">Start</span>',
        '<input id="ums-sdate" type="date" value="' + toInput(cfg.startDate) + '" style="' + S_INP + '">',
        '<input id="ums-shour" type="number" min="0" max="23" value="' + cfg.startHour + '" style="' + S_SM + '">',
        '<span style="font-weight:900;color:#30363d;font-size:14px;">:</span>',
        '<input id="ums-smin"  type="number" min="0" max="59" value="' + pad2(cfg.startMin) + '" style="' + S_SM + '">',
      '</div>',
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:12px;">',
        '<span style="font-weight:900;width:34px;font-size:11px;color:#484f58;">End</span>',
        '<input id="ums-edate" type="date" value="' + toInput(cfg.endDate) + '" style="' + S_INP + '">',
        '<input id="ums-ehour" type="number" min="0" max="23" value="' + cfg.endHour + '" style="' + S_SM + '">',
        '<span style="font-weight:900;color:#30363d;font-size:14px;">:</span>',
        '<input id="ums-emin"  type="number" min="0" max="59" value="' + pad2(cfg.endMin) + '" style="' + S_SM + '">',
      '</div>',
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#30363d;margin-bottom:8px;">Targets (UPH)</div>',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">',
        '<div><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">UIS 5LB</div>',
        '<input id="ums-t-5lb"     type="number" value="' + cfg.t5lb     + '" placeholder="e.g. 1100" style="' + S_INP + '"></div>',
        '<div><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">UIS 20LB</div>',
        '<input id="ums-t-20lb"    type="number" value="' + cfg.t20lb    + '" placeholder="e.g. 570"  style="' + S_INP + '"></div>',
        '<div style="grid-column:1/-1"><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">MS Rate</div>',
        '<input id="ums-t-mansort" type="number" value="' + cfg.tManSort + '" placeholder="e.g. 300"  style="' + S_INP + '"></div>',
      '</div>',
      '<button id="ums-apply" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:6px 0;width:100%;">✓ Apply Changes</button>',
    '</div>',

    '<div id="ums-body">',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 14px;">',
        '<div id="ums-c-uis5lb"  style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="ums-c-uis20lb" style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="ums-c-manSort" style="border-radius:8px;padding:12px 14px;min-height:130px;grid-column:1/-1;"></div>',
      '</div>',
      '<div style="display:flex;align-items:center;gap:8px;padding:6px 14px 12px;border-top:1px solid #21262d;">',
        '<button id="ums-fetch" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:5px 12px;">⟳ Fetch Now</button>',
        '<button id="ums-auto"  style="' + S_BTN(cfg.autoRefresh ? '#14532d' : '#374151', cfg.autoRefresh ? '#16a34a' : '#4b5563') + 'padding:5px 10px;">Auto: ' + (cfg.autoRefresh ? 'ON' : 'OFF') + '</button>',
        '<span id="ums-status" style="font-weight:900;font-size:11px;color:#484f58;flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Not fetched</span>',
      '</div>',
    '</div>',
  ].join('');

  // ── Mount ────────────────────────────────────────────────────────────────
  function mount() {
    if (!document.body) { setTimeout(mount, 100); return; }
    document.body.appendChild(panel);
    init();
  }
  mount();

  function init() {
    renderAll();

    document.getElementById('ums-apply').addEventListener('click', applySettings);
    document.getElementById('ums-fetch').addEventListener('click', fetchAll);
    document.getElementById('ums-auto').addEventListener('click', toggleAuto);

    document.getElementById('ums-gear').addEventListener('click', function () {
      var s = document.getElementById('ums-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('ums-min-btn').addEventListener('click', function () {
      var body     = document.getElementById('ums-body');
      var settings = document.getElementById('ums-settings');
      var btn      = document.getElementById('ums-min-btn');
      var title    = document.getElementById('ums-title');
      var gear     = document.getElementById('ums-gear');
      var collapsed = body.style.display === 'none';
      body.style.display     = collapsed ? 'block' : 'none';
      settings.style.display = 'none';
      btn.textContent        = collapsed ? '−' : '+';
      panel.style.width      = collapsed ? '400px' : '160px';
      if (title) title.style.display = collapsed ? 'block' : 'none';
      if (gear)  gear.style.display  = collapsed ? 'inline' : 'none';
    });

    // ── Drag ──────────────────────────────────────────────────────────────
    var hdr = document.getElementById('ums-hdr');
    var dragging = false, ox, oy, sx, sy;

    var savedX = GM_getValue('ums_posX', null);
    var savedY = GM_getValue('ums_posY', null);
    if (savedX !== null) {
      panel.style.left  = savedX + 'px';
      panel.style.right = 'auto';
      panel.style.top   = savedY + 'px';
    }

    hdr.addEventListener('mousedown', function (e) {
      if (e.target.id === 'ums-gear' || e.target.id === 'ums-min-btn') return;
      dragging = true;
      var r = panel.getBoundingClientRect();
      sx = r.left; sy = r.top; ox = e.clientX; oy = e.clientY;
      hdr.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var nx = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  sx + e.clientX - ox));
      var ny = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, sy + e.clientY - oy));
      panel.style.left  = nx + 'px';
      panel.style.top   = ny + 'px';
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', function () {
      if (dragging) {
        dragging = false;
        hdr.style.cursor = 'grab';
        GM_setValue('ums_posX', parseInt(panel.style.left, 10));
        GM_setValue('ums_posY', parseInt(panel.style.top,  10));
      }
    });

    startTimer();
    fetchAll();
  }

})();
