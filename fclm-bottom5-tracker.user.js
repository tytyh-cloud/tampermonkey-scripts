// ==UserScript==
// @name         FCLM Bottom 5 Tracker
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Bottom 5 performers — RC Sort Primary, UIS 20LB SCP, UIS 5LB SCP
// @author       Tyler
// @match        *://fclm-portal.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      fclm-portal.amazon.com
// @updateURL    https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-bottom5-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-bottom5-tracker.user.js
// @exclude      *://fclm-portal.amazon.com/employee/timeDetails*
// @exclude      *://fclm-portal.amazon.com/reports/ppaTimeOnTask*
// @exclude      *://fclm-portal.amazon.com/employee/ppaTimeDetails*
// ==/UserScript==

(function () {
  'use strict';

  const REFRESH_MS = 60000;
  const INTRA_TAIL =
    '&startHourIntraday1=0&startMinuteIntraday1=0' +
    '&startHourIntraday2=0&startMinuteIntraday2=0' +
    '&startHourIntraday3=0&startMinuteIntraday3=0' +
    '&startHourIntraday4=0&startMinuteIntraday4=0';

  // fnName matched against <caption> of the employee detail table (partial, site-agnostic).
  // RC Sort Primary caption is always exact; UIS captions vary by site suffix (_Induct, _ContPrep...).
  const FUNCTIONS = [
    { label: 'RC Sort Primary', fnName: 'RC Sort Primary', key: 'rcsort', rateLabel: 'UPH' },
    { label: 'UIS 20LB',        fnName: 'UIS_20lb',        key: 'uis20',  rateLabel: 'UPH' },
    { label: 'UIS 5LB SCP',     fnName: 'UIS_5lb_SCP',     key: 'uis5',   rateLabel: 'UPH' },
  ];

  const ROW_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#94a3b8'];

  // ── Persisted config ─────────────────────────────────────────────────────
  let cfg = {
    startDate:   GM_getValue('b5_startDate',   '2026/06/21'),
    startHour:   GM_getValue('b5_startHour',   19),
    startMin:    GM_getValue('b5_startMin',     0),
    endDate:     GM_getValue('b5_endDate',     '2026/06/22'),
    endHour:     GM_getValue('b5_endHour',      6),
    endMin:      GM_getValue('b5_endMin',       30),
    wh:          GM_getValue('b5_wh',          ''),
    autoRefresh: GM_getValue('b5_autoRefresh', true),
  };

  let bottom5 = { rcsort: [], uis20: [], uis5: [] };
  let lastUpdated = null;
  let refreshTimer = null;
  let fetching = false;

  const toInput   = s => s.replace(/\//g, '-');
  const fromInput = s => s.replace(/-/g, '/');
  const pad2      = n => String(n).padStart(2, '0');
  const enc       = s => encodeURIComponent(s);

  // ── URL builder ──────────────────────────────────────────────────────────
  // All three functions live on the same processId=1003009 page.
  function buildURL() {
    return 'https://fclm-portal.amazon.com/reports/functionRollup?' +
      'reportFormat=HTML&warehouseId=' + cfg.wh + '&processId=1003009&maxIntradayDays=1&spanType=Intraday' +
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

  // ── Parser ───────────────────────────────────────────────────────────────
  // Page structure: one <table class="sortable result-table"> per function,
  // each identified by its <caption> (e.g. "RC Sort Primary [4300006775]").
  // Employee rows: cells[0] = AMZN/TEMP/3PTY, cells[2] = Name, cells[10] = JPH.
  // fnName is matched as a substring of the caption — works across site variants.

  var _cachedDoc  = null;
  var _cachedHtml = null;
  function getDoc(html) {
    if (html !== _cachedHtml) {
      _cachedDoc  = new DOMParser().parseFromString(html, 'text/html');
      _cachedHtml = html;
    }
    return _cachedDoc;
  }

  function parseBottom5(html, fnName) {
    var doc    = getDoc(html);
    var needle = fnName.toLowerCase();

    // Find the employee detail table whose <caption> contains the function name
    var tables = doc.querySelectorAll('table');
    var detail = null;
    for (var t = 0; t < tables.length; t++) {
      var cap = tables[t].querySelector('caption');
      if (cap && cap.textContent.toLowerCase().indexOf(needle) >= 0) {
        detail = tables[t];
        break;
      }
    }

    if (!detail) {
      console.log('[FCLM B5] ' + fnName + ': detail table not found');
      return [];
    }

    var results = [];
    // RC Sort Primary: cells[20] = EACH total UPH (cells[10] is a subcategory rate, not the total)
    // UIS functions: cells[10] = UPH
    var rateIdx = (fnName === 'RC Sort Primary' || fnName === 'UIS_5lb_SCP') ? 20 : 10;
    var minCells = rateIdx + 1;
    var rows = detail.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll('td');
      if (cells.length < minCells) continue;

      var type = cells[0].textContent.trim();
      if (!/^(AMZN|TEMP|3PTY)$/.test(type)) continue;

      // Skip Anonymous (no hours, untracked items)
      var rawId = cells[1] ? cells[1].textContent.trim() : '';
      if (rawId === '000000') continue;

      var name = cells[2] ? cells[2].textContent.trim() : '';
      if (!name) continue;

      var rate = parseFloat((cells[rateIdx].textContent || '').replace(/,/g, ''));
      if (isNaN(rate) || rate <= 0) continue;

      results.push({ name: name, rate: rate });
    }

    results.sort(function (a, b) { return a.rate - b.rate; });
    console.log('[FCLM B5] ' + fnName + ': ' + results.length + ' employees, bottom 5: ' +
      results.slice(0, 5).map(function (r) { return r.name + '=' + r.rate.toFixed(1); }).join(', '));
    return results.slice(0, 5);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function renderSection(fn) {
    var el = document.getElementById('b5-sec-' + fn.key);
    if (!el) return;
    var rows = bottom5[fn.key];
    var html = '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #21262d;">' + fn.label + '</div>';
    if (!rows.length) {
      html += '<div style="font-size:11px;color:#484f58;font-weight:900;">No data</div>';
    } else {
      rows.forEach(function (row, i) {
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">';
        html += '<span style="font-size:12px;font-weight:900;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;" title="' + row.name + '">' + row.name + '</span>';
        html += '<span style="font-size:12px;font-weight:900;color:' + ROW_COLORS[i] + ';margin-left:8px;flex-shrink:0;">' + row.rate.toFixed(1) + ' ' + fn.rateLabel + '</span>';
        html += '</div>';
      });
    }
    el.innerHTML = html;
  }

  function renderAll() {
    FUNCTIONS.forEach(renderSection);
    var el = document.getElementById('b5-status');
    if (el && lastUpdated) el.textContent = 'Updated ' + lastUpdated.toLocaleTimeString();
  }

  function setStatus(msg) {
    var el = document.getElementById('b5-status');
    if (el) el.textContent = msg;
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  async function fetchAll() {
    if (fetching) return;
    fetching = true;
    setStatus('⟳ Fetching…');
    var btn = document.getElementById('b5-fetch');
    if (btn) btn.disabled = true;
    try {
      var html = await httpGet(buildURL());
      FUNCTIONS.forEach(function (fn) {
        bottom5[fn.key] = parseBottom5(html, fn.fnName);
      });
      lastUpdated = new Date();
      renderAll();
      setStatus('Updated ' + lastUpdated.toLocaleTimeString());
    } catch (e) {
      setStatus('⚠ ' + e.message);
      console.error('[FCLM B5]', e);
    } finally {
      fetching = false;
      if (btn) btn.disabled = false;
    }
  }

  // ── Timer ────────────────────────────────────────────────────────────────
  function startTimer() { stopTimer(); if (cfg.autoRefresh) refreshTimer = setInterval(fetchAll, REFRESH_MS); }
  function stopTimer()  { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  // ── Apply settings ───────────────────────────────────────────────────────
  function applySettings() {
    cfg.wh        = document.getElementById('b5-wh').value.toUpperCase() || cfg.wh;
    cfg.startDate = fromInput(document.getElementById('b5-sdate').value) || cfg.startDate;
    cfg.startHour = parseInt(document.getElementById('b5-shour').value, 10) || 0;
    cfg.startMin  = parseInt(document.getElementById('b5-smin').value,  10) || 0;
    cfg.endDate   = fromInput(document.getElementById('b5-edate').value) || cfg.endDate;
    cfg.endHour   = parseInt(document.getElementById('b5-ehour').value, 10) || 0;
    cfg.endMin    = parseInt(document.getElementById('b5-emin').value,  10) || 0;
    Object.keys(cfg).forEach(function (k) { GM_setValue('b5_' + k, cfg[k]); });
    fetchAll();
  }

  function toggleAuto() {
    cfg.autoRefresh = !cfg.autoRefresh;
    GM_setValue('b5_autoRefresh', cfg.autoRefresh);
    var b = document.getElementById('b5-auto');
    if (b) {
      b.textContent       = 'Auto: ' + (cfg.autoRefresh ? 'ON' : 'OFF');
      b.style.background  = cfg.autoRefresh ? '#14532d' : '#374151';
      b.style.borderColor = cfg.autoRefresh ? '#16a34a' : '#4b5563';
    }
    cfg.autoRefresh ? startTimer() : stopTimer();
  }

  // ── Style helpers ────────────────────────────────────────────────────────
  var BASE  = 'box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;font-size:12px;';
  var S_INP = BASE + 'background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e2e8f0;outline:none;padding:4px 6px;width:100%;';
  var S_SM  = BASE + 'background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e2e8f0;outline:none;padding:4px 2px;width:44px;text-align:center;';
  function S_BTN(bg, bd) {
    return BASE + 'background:' + bg + ';border:1px solid ' + bd + ';border-radius:4px;color:#e2e8f0;cursor:pointer;font-weight:600;';
  }

  // ── Build panel ──────────────────────────────────────────────────────────
  var panel = document.createElement('div');
  panel.id = 'b5-panel';
  panel.style.cssText = [
    'position:fixed', 'top:20px', 'left:20px', 'width:380px',
    'background:#0d1117', 'border:1px solid #21262d', 'border-radius:10px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.7)', 'color:#e2e8f0',
    'z-index:2147483647', 'font-family:system-ui,-apple-system,sans-serif',
    'font-size:13px',
  ].join(';');

  // Build section HTML for each function
  var sectionsHTML = FUNCTIONS.map(function (fn) {
    return '<div id="b5-sec-' + fn.key + '" style="padding:10px 14px;border-bottom:1px solid #21262d;"></div>';
  }).join('');

  panel.innerHTML = [
    '<div id="b5-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:#161b22;border-radius:10px 10px 0 0;cursor:grab;border-bottom:1px solid #21262d;">',
      '<span style="font-weight:900;font-size:13px;color:#f1f5f9;letter-spacing:0.2px;">📊 Bottom 5 Tracker</span>',
      '<div style="display:flex;gap:10px;align-items:center;">',
        '<span id="b5-gear"    title="Settings" style="cursor:pointer;opacity:0.55;font-size:14px;line-height:1;">⚙️</span>',
        '<span id="b5-min-btn" title="Minimize" style="cursor:pointer;opacity:0.55;font-size:18px;line-height:1;margin-top:-1px;">−</span>',
      '</div>',
    '</div>',

    '<div id="b5-settings" style="display:none;padding:12px 14px;border-bottom:1px solid #21262d;background:#0d1117;">',
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">',
        '<div style="font-weight:900;font-size:11px;color:#484f58;white-space:nowrap;">Site ID</div>',
        '<input id="b5-wh" type="text" maxlength="8" value="' + cfg.wh + '" placeholder="e.g. RFD2" style="' + S_INP + 'text-transform:uppercase;">',
      '</div>',
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#30363d;margin-bottom:8px;">Shift Window</div>',
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;">',
        '<span style="font-weight:900;width:34px;font-size:11px;color:#484f58;">Start</span>',
        '<input id="b5-sdate" type="date" value="' + toInput(cfg.startDate) + '" style="' + S_INP + '">',
        '<input id="b5-shour" type="number" min="0" max="23" value="' + cfg.startHour + '" style="' + S_SM + '">',
        '<span style="font-weight:900;color:#30363d;font-size:14px;">:</span>',
        '<input id="b5-smin"  type="number" min="0" max="59" value="' + pad2(cfg.startMin) + '" style="' + S_SM + '">',
      '</div>',
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:12px;">',
        '<span style="font-weight:900;width:34px;font-size:11px;color:#484f58;">End</span>',
        '<input id="b5-edate" type="date" value="' + toInput(cfg.endDate) + '" style="' + S_INP + '">',
        '<input id="b5-ehour" type="number" min="0" max="23" value="' + cfg.endHour + '" style="' + S_SM + '">',
        '<span style="font-weight:900;color:#30363d;font-size:14px;">:</span>',
        '<input id="b5-emin"  type="number" min="0" max="59" value="' + pad2(cfg.endMin) + '" style="' + S_SM + '">',
      '</div>',
      '<button id="b5-apply" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:6px 0;width:100%;">✓ Apply Changes</button>',
    '</div>',

    '<div id="b5-body">',
      sectionsHTML,
      '<div style="display:flex;align-items:center;gap:8px;padding:6px 14px 10px;">',
        '<button id="b5-fetch" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:5px 12px;">⟳ Fetch Now</button>',
        '<button id="b5-auto"  style="' + S_BTN(cfg.autoRefresh ? '#14532d' : '#374151', cfg.autoRefresh ? '#16a34a' : '#4b5563') + 'padding:5px 10px;">Auto: ' + (cfg.autoRefresh ? 'ON' : 'OFF') + '</button>',
        '<span id="b5-status" style="font-weight:900;font-size:11px;color:#484f58;flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Not fetched</span>',
      '</div>',
    '</div>',
  ].join('');

  // ── Tab (minimized) ──────────────────────────────────────────────────────
  var tab = document.createElement('div');
  tab.id = 'b5-tab';
  tab.style.cssText = 'position:fixed;left:0;top:100px;width:28px;height:120px;background:#161b22;border:1px solid #21262d;border-left:none;border-radius:0 8px 8px 0;cursor:pointer;display:none;z-index:2147483647;align-items:center;justify-content:center;writing-mode:vertical-rl;transform:rotate(180deg);font-family:system-ui,-apple-system,sans-serif;font-size:11px;font-weight:900;color:#f1f5f9;letter-spacing:0.5px;user-select:none;';
  tab.textContent = '📊 Bottom 5';

  // ── Mount ────────────────────────────────────────────────────────────────
  function mount() {
    if (!document.body) { setTimeout(mount, 100); return; }
    document.body.appendChild(panel);
    document.body.appendChild(tab);
    init();
  }
  mount();

  function init() {
    FUNCTIONS.forEach(function (fn) {
      var el = document.getElementById('b5-sec-' + fn.key);
      if (el) el.innerHTML = '<div style="font-size:11px;color:#484f58;font-weight:900;padding:4px 0;">No data</div>';
    });

    document.getElementById('b5-apply').addEventListener('click', applySettings);
    document.getElementById('b5-fetch').addEventListener('click', fetchAll);
    document.getElementById('b5-auto').addEventListener('click', toggleAuto);

    document.getElementById('b5-gear').addEventListener('click', function () {
      var s = document.getElementById('b5-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('b5-min-btn').addEventListener('click', function () {
      document.getElementById('b5-settings').style.display = 'none';
      panel.style.display = 'none';
      tab.style.display   = 'flex';
    });
    tab.addEventListener('click', function () {
      tab.style.display   = 'none';
      panel.style.display = 'block';
    });

    // ── Drag ──────────────────────────────────────────────────────────────
    var hdr = document.getElementById('b5-hdr');
    var dragging = false, ox, oy, sx, sy;

    var savedX = GM_getValue('b5_posX', null);
    var savedY = GM_getValue('b5_posY', null);
    if (savedX !== null) {
      panel.style.left = savedX + 'px';
      panel.style.top  = savedY + 'px';
    }

    hdr.addEventListener('mousedown', function (e) {
      if (e.target.id === 'b5-gear' || e.target.id === 'b5-min-btn') return;
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
      panel.style.left = nx + 'px';
      panel.style.top  = ny + 'px';
    });

    document.addEventListener('mouseup', function () {
      if (dragging) {
        dragging = false;
        hdr.style.cursor = 'grab';
        GM_setValue('b5_posX', parseInt(panel.style.left, 10));
        GM_setValue('b5_posY', parseInt(panel.style.top,  10));
      }
    });

    startTimer();
    fetchAll();
  }

})();
