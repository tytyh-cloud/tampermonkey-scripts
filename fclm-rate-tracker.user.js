// ==UserScript==
// @name         RPND Rate Tracker
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Floating overlay — Decant, Decant Non-TI, Prep, Each Receive rates from FCLM
// @author       Tyler
// @updateURL    https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-rate-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-rate-tracker.user.js
// @match        *://fclm-portal.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      fclm-portal.amazon.com
// @exclude      *://fclm-portal.amazon.com/employee/timeDetails*
// @exclude      *://fclm-portal.amazon.com/reports/ppaTimeOnTask*
// @exclude      *://fclm-portal.amazon.com/employee/ppaTimeDetails*
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
    startDate:   GM_getValue('startDate',   '2026/06/15'),
    startHour:   GM_getValue('startHour',   17),
    startMin:    GM_getValue('startMin',    0),
    endDate:     GM_getValue('endDate',     '2026/06/16'),
    endHour:     GM_getValue('endHour',     6),
    endMin:      GM_getValue('endMin',      30),
    tDecant:     GM_getValue('tDecant',     ''),
    tDecantNTI:  GM_getValue('tDecantNTI',  ''),
    tPrep:       GM_getValue('tPrep',       ''),
    tEachRecv:   GM_getValue('tEachRecv',   ''),
    autoRefresh: GM_getValue('autoRefresh', true),
  };

  let rates     = { decant:{rate:null,units:null,hours:null}, decantNTI:{rate:null,units:null,hours:null}, prep:{rate:null,units:null,hours:null}, eachRecv:{rate:null,units:null,hours:null} };
  let lastUpdated = null;
  let refreshTimer = null;
  let fetching    = false;

  const toInput   = s => s.replace(/\//g, '-');
  const fromInput = s => s.replace(/-/g, '/');
  const pad2      = n => String(n).padStart(2, '0');
  const enc       = s => encodeURIComponent(s);

  // ── URL builders ─────────────────────────────────────────────────────────
  function buildPPR() {
    return 'https://fclm-portal.amazon.com/reports/processPathRollup?' +
      'reportFormat=HTML&warehouseId=' + WH + '&maxIntradayDays=1&spanType=Intraday' +
      '&startDateIntraday=' + enc(cfg.startDate) + '&startHourIntraday=' + cfg.startHour + '&startMinuteIntraday=' + cfg.startMin +
      '&endDateIntraday='   + enc(cfg.endDate)   + '&endHourIntraday='   + cfg.endHour  + '&endMinuteIntraday='   + cfg.endMin +
      '&_adjustPlanHours=on&_hideEmptyLineItems=on&_rememberViewForWarehouse=on&employmentType=AllEmployees' + INTRA_TAIL;
  }


  function buildRollup(pid) {
    return 'https://fclm-portal.amazon.com/reports/functionRollup?' +
      'reportFormat=HTML&warehouseId=' + WH + '&processId=' + pid + '&maxIntradayDays=1&spanType=Intraday' +
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
      onerror: () => rej(new Error('Network error'))
    }));
  }

  // ── Parse helpers ─────────────────────────────────────────────────────────
  // Normalize em-dashes/en-dashes to " - " and collapse whitespace.
  function norm(s) {
    return s.replace(/[\u2012\u2013\u2014]/g, ' - ').replace(/\s+/g, ' ').toLowerCase().trim();
  }

  // Return the nth numeric cell value (0-based) from a <tr>, skipping non-numeric cells.
  function nthNum(row, n) {
    var cells = row.querySelectorAll('td');
    var count = 0;
    for (var i = 0; i < cells.length; i++) {
      var v = parseFloat(cells[i].textContent.trim().replace(/,/g, ''));
      if (!isNaN(v)) {
        if (count === n) return v;
        count++;
      }
    }
    return null;
  }

  // ── PPR parser ────────────────────────────────────────────────────────────
  // Rows: "Each Receive – Total" and "Prep – Total" (FCLM uses en-dash U+2013).
  // Column layout: [icon] [Line Item] [Unit] [Vol #1] [Hrs #2] [Actual Rate #3]
  // → Actual Rate is the 3rd numeric value in the row (0-based index 2).
  function parsePPR(html, searchTerms, label) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var tables = doc.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      var rows = tables[t].querySelectorAll('tr');
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('td');
        if (!cells.length) continue;
        var txt = norm(rows[r].textContent);
        var matched = false;
        for (var s = 0; s < searchTerms.length; s++) {
          if (txt.indexOf(norm(searchTerms[s])) >= 0) { matched = true; break; }
        }
        if (matched) {
          var val = nthNum(rows[r], 2); // 3rd numeric = Actual Rate
          var u   = nthNum(rows[r], 0); // 1st numeric = Volume (units)
          var hrs = nthNum(rows[r], 1); // 2nd numeric = Hours
          if (val !== null) {
            console.log('[FCLM PPR] ' + label + ' = ' + val + ' (' + u + ' units, ' + hrs + ' hrs)');
            return { rate: val, units: u, hours: hrs };
          }
        }
      }
    }
    console.log('[FCLM PPR] ' + label + ': row not found. Searched: ' + searchTerms.join(', '));
    return { rate: null, units: null, hours: null };
  }

  // ── Function Rollup parser ────────────────────────────────────────────────
  // Column layout in data rows: [Size/Total] [Total Paid Hrs #1] [Jobs #2]
  //   [JPH #3] [EACH UNIT #4] [EACH UPH #5] ...
  // → EACH UPH is the 5th numeric value (0-based index 4).
  // Finds the first row where any <td> has exact text "Total".
  function parseFRollup(html, label) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var tables = doc.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      var rows = tables[t].querySelectorAll('tr');
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('td');
        if (!cells.length) continue;
        var hasTotal = false;
        for (var c = 0; c < cells.length; c++) {
          if (cells[c].textContent.trim() === 'Total') { hasTotal = true; break; }
        }
        if (hasTotal) {
          var val = nthNum(rows[r], 4); // 5th numeric = EACH UPH
          var u   = cells.length > 4 ? parseFloat(cells[4].textContent.trim().replace(/,/g,'')) : null;
          var hrs = nthNum(rows[r], 0); // 1st numeric = Total Paid Hours
          if (val !== null) {
            console.log('[FCLM FR] ' + label + ' = ' + val);
            return { rate: val, units: (u && !isNaN(u) ? u : null), hours: hrs };
          }
        }
      }
    }
    console.log('[FCLM FR] ' + label + ': Total row not found');
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
    var el = document.getElementById('fclm-c-' + id);
    if (!el) return;
    var c = getColors(rate, target);
    var t = parseFloat(target);
    el.style.cssText = 'background:' + c.bg + ';border:1px solid ' + c.border + ';border-radius:8px;padding:10px;min-height:96px;transition:border-color 0.3s,background 0.3s;' + (extraStyle || '');
    el.innerHTML =
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</div>' +
      '<div style="font-size:22px;font-weight:900;color:' + c.val + ';line-height:1.1;">' + (rate !== null ? rate.toFixed(1) : '—') + '</div>' +
      '<div style="font-weight:900;font-size:10px;color:#cbd5e1;margin-top:1px;">UPH</div>' +
      '<div style="font-weight:900;font-size:11px;color:#cbd5e1;margin-top:2px;">' + (units !== null ? units.toLocaleString() + ' units' : '') + '</div>' +
      '<div style="font-weight:900;font-size:11px;color:#94a3b8;margin-top:2px;">' + (hours !== null ? hours.toFixed(2) + ' hrs' : '') + '</div>' +
      '<div style="font-weight:900;margin-top:4px;font-size:11px;color:#cbd5e1;">Target: <span style="color:' + c.val + ';">' + (t ? t.toFixed(0) : 'Not set') + '</span></div>' +
      '<div style="font-size:12px;font-weight:900;color:' + c.val + ';margin-top:2px;">' + c.pct + '</div>';
  }

  function renderAll() {
    renderCard('decant',    rates.decant.rate,    rates.decant.units,    rates.decant.hours,    cfg.tDecant,    'Decant');
    renderCard('decantNTI', rates.decantNTI.rate, rates.decantNTI.units, rates.decantNTI.hours, cfg.tDecantNTI, 'Decant Non-TI');
    renderCard('prep',      rates.prep.rate,      rates.prep.units,      rates.prep.hours,      cfg.tPrep,      'Prep - Total');
    renderCard('eachRecv',  rates.eachRecv.rate,  rates.eachRecv.units,  rates.eachRecv.hours,  cfg.tEachRecv,  'Each Receive');
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  async function fetchAll() {
    if (fetching) return;
    fetching = true;
    setStatus('⟳ Fetching…');
    var btn = document.getElementById('fclm-fetch');
    if (btn) btn.disabled = true;
    try {
      var results = await Promise.all([
        httpGet(buildPPR()),
        httpGet(buildRollup('1003033')),
        httpGet(buildRollup('1003019')),
      ]);
      var ppr = results[0], r1 = results[1], r2 = results[2];

      // PPR: "Each Receive – Total" and "Prep – Total" — search normalized (handles en-dash)
      rates.eachRecv  = parsePPR(ppr, ['each receive - total', 'each receive  total'], 'EachRecv');
      rates.prep      = parsePPR(ppr, ['prep - total', 'prep  total'],                 'Prep');
      // Function Rollup: Total row, EACH UPH column
      rates.decant    = parseFRollup(r2, 'Decant');
      rates.decantNTI = parseFRollup(r1, 'DecantNTI');

      lastUpdated = new Date();
      renderAll();
      setStatus('Updated ' + lastUpdated.toLocaleTimeString());
    } catch (e) {
      setStatus('⚠ ' + e.message);
      console.error('[FCLM Tracker]', e);
    } finally {
      fetching = false;
      if (btn) btn.disabled = false;
    }
  }

  function setStatus(msg) {
    var el = document.getElementById('fclm-status');
    if (el) el.textContent = msg;
  }

  // ── Timer ────────────────────────────────────────────────────────────────
  function startTimer() { stopTimer(); if (cfg.autoRefresh) refreshTimer = setInterval(fetchAll, REFRESH_MS); }
  function stopTimer()  { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  // ── Apply settings ───────────────────────────────────────────────────────
  function applySettings() {
    cfg.startDate  = fromInput(document.getElementById('fclm-sdate').value) || cfg.startDate;
    cfg.startHour  = parseInt(document.getElementById('fclm-shour').value,  10) || 0;
    cfg.startMin   = parseInt(document.getElementById('fclm-smin').value,   10) || 0;
    cfg.endDate    = fromInput(document.getElementById('fclm-edate').value) || cfg.endDate;
    cfg.endHour    = parseInt(document.getElementById('fclm-ehour').value,  10) || 0;
    cfg.endMin     = parseInt(document.getElementById('fclm-emin').value,   10) || 0;
    cfg.tDecant    = document.getElementById('fclm-t-decant').value;
    cfg.tDecantNTI = document.getElementById('fclm-t-decantNTI').value;
    cfg.tPrep      = document.getElementById('fclm-t-prep').value;
    cfg.tEachRecv  = document.getElementById('fclm-t-eachRecv').value;
    Object.keys(cfg).forEach(function(k) { GM_setValue(k, cfg[k]); });
    renderAll();
    fetchAll();
  }

  function toggleAuto() {
    cfg.autoRefresh = !cfg.autoRefresh;
    GM_setValue('autoRefresh', cfg.autoRefresh);
    var b = document.getElementById('fclm-auto');
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
  panel.id = 'fclm-rt-panel';
  panel.style.cssText = [
    'position:fixed', 'top:20px', 'right:20px', 'width:400px',
    'background:#0d1117', 'border:1px solid #21262d', 'border-radius:10px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.7)', 'color:#e2e8f0',
    'z-index:2147483647', 'font-family:system-ui,-apple-system,sans-serif',
    'font-size:13px',
  ].join(';');

  panel.innerHTML = [
    '<div id="fclm-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:#161b22;border-radius:10px 10px 0 0;cursor:grab;border-bottom:1px solid #21262d;">',
      '<span id="fclm-title" style="font-weight:900;font-size:13px;color:#f1f5f9;letter-spacing:0.2px;">📊 RPND Rate Tracker</span>',
      '<div style="display:flex;gap:10px;align-items:center;">',
        '<span id="fclm-gear"    title="Settings" style="font-weight:900;cursor:pointer;opacity:0.55;font-size:14px;line-height:1;">⚙️</span>',
        '<span id="fclm-min-btn" title="Minimize" style="font-weight:900;cursor:pointer;opacity:0.55;font-size:18px;line-height:1;margin-top:-1px;">−</span>',
      '</div>',
    '</div>',

    '<div id="fclm-settings" style="display:none;padding:12px 14px;border-bottom:1px solid #21262d;background:#0d1117;">',
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#30363d;margin-bottom:8px;">Shift Window</div>',
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;">',
        '<span style="font-weight:900;width:34px;font-size:11px;color:#484f58;">Start</span>',
        '<input id="fclm-sdate" type="date" value="' + toInput(cfg.startDate) + '" style="' + S_INP + '">',
        '<input id="fclm-shour" type="number" min="0" max="23" value="' + cfg.startHour + '" style="' + S_SM + '">',
        '<span style="font-weight:900;color:#30363d;font-size:14px;">:</span>',
        '<input id="fclm-smin"  type="number" min="0" max="59" value="' + pad2(cfg.startMin) + '" style="' + S_SM + '">',
      '</div>',
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:12px;">',
        '<span style="font-weight:900;width:34px;font-size:11px;color:#484f58;">End</span>',
        '<input id="fclm-edate" type="date" value="' + toInput(cfg.endDate) + '" style="' + S_INP + '">',
        '<input id="fclm-ehour" type="number" min="0" max="23" value="' + cfg.endHour + '" style="' + S_SM + '">',
        '<span style="font-weight:900;color:#30363d;font-size:14px;">:</span>',
        '<input id="fclm-emin"  type="number" min="0" max="59" value="' + pad2(cfg.endMin) + '" style="' + S_SM + '">',
      '</div>',
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#30363d;margin-bottom:8px;">Targets (UPH)</div>',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">',
        '<div><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">Decant</div>',
        '<input id="fclm-t-decant"    type="number" value="' + cfg.tDecant    + '" placeholder="e.g. 250" style="' + S_INP + '"></div>',
        '<div><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">Decant Non-TI</div>',
        '<input id="fclm-t-decantNTI" type="number" value="' + cfg.tDecantNTI + '" placeholder="e.g. 200" style="' + S_INP + '"></div>',
        '<div><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">Prep - Total</div>',
        '<input id="fclm-t-prep"      type="number" value="' + cfg.tPrep      + '" placeholder="e.g. 180" style="' + S_INP + '"></div>',
        '<div><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">Each Receive</div>',
        '<input id="fclm-t-eachRecv"  type="number" value="' + cfg.tEachRecv  + '" placeholder="e.g. 100" style="' + S_INP + '"></div>',
      '</div>',
      '<button id="fclm-apply" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:6px 0;width:100%;">✓ Apply Changes</button>',
    '</div>',

    '<div id="fclm-body">',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 14px;">',
        '<div id="fclm-c-decant"    style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="fclm-c-decantNTI" style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="fclm-c-prep"      style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="fclm-c-eachRecv"  style="border-radius:8px;padding:10px;min-height:96px;"></div>',
      '</div>',
      '<div style="display:flex;align-items:center;gap:8px;padding:6px 14px 12px;border-top:1px solid #21262d;">',
        '<button id="fclm-fetch" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:5px 12px;">⟳ Fetch Now</button>',
        '<button id="fclm-auto"  style="' + S_BTN(cfg.autoRefresh ? '#14532d' : '#374151', cfg.autoRefresh ? '#16a34a' : '#4b5563') + 'padding:5px 10px;">Auto: ' + (cfg.autoRefresh ? 'ON' : 'OFF') + '</button>',
        '<span id="fclm-status" style="font-weight:900;font-size:11px;color:#484f58;flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Not fetched</span>',
      '</div>',
    '</div>',
  ].join('');

  // ── Tab (minimized state) ────────────────────────────────────────────────
  var tab = document.createElement('div');
  tab.id = 'fclm-rt-tab';
  tab.style.cssText = 'position:fixed;right:0;top:100px;width:28px;height:120px;background:#161b22;border:1px solid #21262d;border-right:none;border-radius:8px 0 0 8px;cursor:pointer;display:none;z-index:2147483647;align-items:center;justify-content:center;writing-mode:vertical-rl;font-family:system-ui,-apple-system,sans-serif;font-size:11px;font-weight:900;color:#f1f5f9;letter-spacing:0.5px;user-select:none;';
  tab.textContent = '\ud83d\udcca RPND Rates';

  // ── Mount ────────────────────────────────────────────────────────────────
  function mount() {
    if (!document.body) { setTimeout(mount, 100); return; }
    document.body.appendChild(panel);
    document.body.appendChild(tab);
    init();
  }
  mount();

  function init() {
    renderAll();

    document.getElementById('fclm-apply').addEventListener('click', applySettings);
    document.getElementById('fclm-fetch').addEventListener('click', fetchAll);
    document.getElementById('fclm-auto').addEventListener('click', toggleAuto);

    document.getElementById('fclm-gear').addEventListener('click', function () {
      var s = document.getElementById('fclm-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('fclm-min-btn').addEventListener('click', function () {
      document.getElementById('fclm-settings').style.display = 'none';
      panel.style.display = 'none';
      tab.style.display   = 'flex';
    });
    tab.addEventListener('click', function () {
      tab.style.display   = 'none';
      panel.style.display = 'block';
    });

    // ── Drag ──────────────────────────────────────────────────────────────
    var hdr = document.getElementById('fclm-hdr');
    var dragging = false, ox, oy, sx, sy;

    var savedX = GM_getValue('posX', null);
    var savedY = GM_getValue('posY', null);
    if (savedX !== null) {
      panel.style.left  = savedX + 'px';
      panel.style.right = 'auto';
      panel.style.top   = savedY + 'px';
    }

    hdr.addEventListener('mousedown', function (e) {
      if (e.target.id === 'fclm-gear' || e.target.id === 'fclm-min-btn') return;
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
        GM_setValue('posX', parseInt(panel.style.left,  10));
        GM_setValue('posY', parseInt(panel.style.top,   10));
      }
    });

    startTimer();
    fetchAll();
  }

})();
