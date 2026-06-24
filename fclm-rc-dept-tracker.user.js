// ==UserScript==
// @name         FCLM RC Dept Tracker
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  UIS/ManSort rates + Bottom 5 performers - single panel for RC dept
// @author       Tyler
// @updateURL    https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-rc-dept-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-rc-dept-tracker.user.js
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

  const REFRESH_MS = 60000;
  const INTRA_TAIL =
    '&startHourIntraday1=0&startMinuteIntraday1=0' +
    '&startHourIntraday2=0&startMinuteIntraday2=0' +
    '&startHourIntraday3=0&startMinuteIntraday3=0' +
    '&startHourIntraday4=0&startMinuteIntraday4=0';

  // Functions tracked in Bottom 5 tab
  const B5_FUNCTIONS = [
    { label: 'UIS 5LB SCP',     fnName: 'UIS_5lb_SCP',     key: 'uis5',   rateLabel: 'UPH' },
    { label: 'UIS 20LB SCP',    fnName: 'UIS_20lb_SCP',    key: 'uis20',  rateLabel: 'UPH' },
    { label: 'RC Sort Primary', fnName: 'RC Sort Primary', key: 'rcsort', rateLabel: 'UPH' },
  ];

  const ROW_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#60a5fa'];

  // -- Config (rc_ prefix avoids collision with ums_ and b5_ if old scripts still installed)
  var cfg = {
    startDate:   GM_getValue('rc_startDate',   '2026/06/21'),
    startHour:   GM_getValue('rc_startHour',   19),
    startMin:    GM_getValue('rc_startMin',     0),
    endDate:     GM_getValue('rc_endDate',     '2026/06/22'),
    endHour:     GM_getValue('rc_endHour',      6),
    endMin:      GM_getValue('rc_endMin',       30),
    wh:          GM_getValue('rc_wh',          ''),
    t5lb:        GM_getValue('rc_t5lb',        ''),
    t20lb:       GM_getValue('rc_t20lb',       ''),
    tManSort:    GM_getValue('rc_tManSort',    ''),
    tVol:        GM_getValue('rc_tVol',        ''),
    autoRefresh: GM_getValue('rc_autoRefresh', true),
  };

  // -- State
  var rates = {
    uis5lb:  { rate: null, units: null, hours: null },
    uis20lb: { rate: null, units: null, hours: null },
    manSort: { rate: null, units: null, hours: null },
  };
  var rcSortVol = null;
  var bottom5   = { rcsort: [], uis20: [], uis5: [] };
  var lastUpdated   = null;
  var refreshTimer  = null;
  var fetching      = false;

  var toInput   = function (s) { return s.replace(/\//g, '-'); };
  var fromInput = function (s) { return s.replace(/-/g, '/'); };
  var pad2      = function (n) { return String(n).padStart(2, '0'); };
  var enc       = function (s) { return encodeURIComponent(s); };

  // -- URL ------------------------------------------------------------------
  function buildURL() {
    return 'https://fclm-portal.amazon.com/reports/functionRollup?' +
      'reportFormat=HTML&warehouseId=' + cfg.wh + '&processId=1003009&maxIntradayDays=1&spanType=Intraday' +
      '&startDateIntraday='  + enc(cfg.startDate) + '&startHourIntraday='  + cfg.startHour + '&startMinuteIntraday='  + cfg.startMin +
      '&endDateIntraday='    + enc(cfg.endDate)   + '&endHourIntraday='    + cfg.endHour   + '&endMinuteIntraday='    + cfg.endMin +
      INTRA_TAIL;
  }

  // -- HTTP -----------------------------------------------------------------
  function httpGet(url) {
    return new Promise(function (res, rej) {
      GM_xmlhttpRequest({
        method:  'GET',
        url:     url,
        onload:  function (r) { r.status === 200 ? res(r.responseText) : rej(new Error('HTTP ' + r.status)); },
        onerror: function ()  { rej(new Error('Network error')); },
      });
    });
  }

  // -- Parsed-doc cache (avoid re-parsing the same HTML for each function call)
  var _cachedDoc  = null;
  var _cachedHtml = null;
  function getDoc(html) {
    if (html !== _cachedHtml) {
      _cachedDoc  = new DOMParser().parseFromString(html, 'text/html');
      _cachedHtml = html;
    }
    return _cachedDoc;
  }

  // -- Rate parser: finds "Total" row in summary rollup table ---------------
  function nthNum(row, n) {
    var cells = row.querySelectorAll('td');
    var count = 0;
    for (var i = 0; i < cells.length; i++) {
      var v = parseFloat(cells[i].textContent.trim().replace(/,/g, ''));
      if (!isNaN(v)) { if (count === n) return v; count++; }
    }
    return null;
  }

  function parseFunctionRow(html, fnName) {
    var doc    = getDoc(html);
    var needle = fnName.toLowerCase();
    var tables = doc.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      if (tables[t].textContent.toLowerCase().indexOf(needle) < 0) continue;
      var rows = tables[t].querySelectorAll('tr');
      var found = false;
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('td');
        if (!cells.length) continue;
        if (rows[r].textContent.toLowerCase().indexOf(needle) >= 0) found = true;
        if (!found) continue;
        if (cells[0].textContent.trim() !== 'Total') continue;
        return { rate: nthNum(rows[r], 4), units: nthNum(rows[r], 3), hours: nthNum(rows[r], 0) };
      }
    }
    return { rate: null, units: null, hours: null };
  }

  // -- Bottom 5 parser: employee detail table, picks widest matching table --
  function parseBottom5(html, fnName) {
    var doc    = getDoc(html);
    var needle = fnName.toLowerCase();
    var tables = doc.querySelectorAll('table');
    var detail = null, bestCells = -1;
    for (var t = 0; t < tables.length; t++) {
      var cap = tables[t].querySelector('caption');
      if (!cap || cap.textContent.toLowerCase().indexOf(needle) < 0) continue;
      var firstRow = tables[t].querySelector('tr td');
      var rowCells = firstRow ? firstRow.parentNode.querySelectorAll('td').length : 0;
      if (rowCells > bestCells) { bestCells = rowCells; detail = tables[t]; }
    }
    if (!detail) return [];
    var results = [];
    var rows = detail.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll('td');
      if (cells.length < 21) continue;
      var type = cells[0].textContent.trim();
      if (!/^(AMZN|TEMP|3PTY)$/.test(type)) continue;
      if ((cells[1] ? cells[1].textContent.trim() : '') === '000000') continue;
      var name = cells[2] ? cells[2].textContent.trim() : '';
      if (!name) continue;
      var rate = parseFloat((cells[20].textContent || '').replace(/,/g, ''));
      if (isNaN(rate) || rate <= 0) continue;
      results.push({ name: name, rate: rate });
    }
    results.sort(function (a, b) { return a.rate - b.rate; });
    return results.slice(0, 5);
  }

  // -- Rate card colors -----------------------------------------------------
  function getColors(rate, target) {
    var t = parseFloat(target);
    if (!rate || !t || isNaN(t))
      return { bg: 'rgba(71,85,105,0.25)', border: '#334155', val: '#64748b', pct: '-' };
    var p = rate / t;
    if (p >= 1.00) return { bg: 'rgba(34,197,94,0.13)',  border: '#22c55e', val: '#4ade80', pct: Math.round(p * 100) + '%' };
    if (p >= 0.85) return { bg: 'rgba(245,158,11,0.13)', border: '#f59e0b', val: '#fbbf24', pct: Math.round(p * 100) + '%' };
    return               { bg: 'rgba(239,68,68,0.13)',   border: '#ef4444', val: '#f87171', pct: Math.round(p * 100) + '%' };
  }

  // -- Render: Rates tab ----------------------------------------------------
  function renderRateCard(id, rate, units, hours, target, label, extraStyle) {
    var el = document.getElementById('rc-c-' + id);
    if (!el) return;
    var c = getColors(rate, target);
    var t = parseFloat(target);
    el.style.cssText = 'background:' + c.bg + ';border:1px solid ' + c.border +
      ';border-radius:8px;padding:10px;min-height:96px;transition:border-color 0.3s,background 0.3s;' + (extraStyle || '');
    el.innerHTML =
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</div>' +
      '<div style="font-size:22px;font-weight:900;color:' + c.val + ';line-height:1.1;">' + (rate !== null ? rate.toFixed(1) : '-') + '</div>' +
      '<div style="font-weight:900;font-size:10px;color:#cbd5e1;margin-top:1px;">UPH</div>' +
      '<div style="font-size:12px;font-weight:900;color:#cbd5e1;margin-top:2px;">' + (units !== null ? units.toLocaleString() + ' units' : '') + '</div>' +
      '<div style="font-size:12px;font-weight:900;color:#94a3b8;margin-top:2px;">'  + (hours !== null ? hours.toFixed(2) + ' hrs' : '')  + '</div>' +
      '<div style="font-weight:900;margin-top:4px;font-size:11px;color:#cbd5e1;">Target: <span style="color:' + c.val + ';">' + (t ? t.toFixed(0) : 'Not set') + '</span></div>' +
      '<div style="font-size:12px;font-weight:900;color:' + c.val + ';margin-top:2px;">' + c.pct + '</div>';
  }

  function renderVolCard() {
    var el = document.getElementById('rc-vol');
    if (!el) return;
    var t = parseFloat(cfg.tVol);
    var p = (rcSortVol !== null && t && !isNaN(t)) ? rcSortVol / t : null;
    var col = '#cbd5e1', bg = 'rgba(71,85,105,0.15)', bdr = '#334155', pct = '';
    if (p !== null) {
      if      (p >= 1.00) { col = '#4ade80'; bg = 'rgba(34,197,94,0.13)';  bdr = '#22c55e'; }
      else if (p >= 0.85) { col = '#fbbf24'; bg = 'rgba(245,158,11,0.13)'; bdr = '#f59e0b'; }
      else                { col = '#f87171'; bg = 'rgba(239,68,68,0.13)';  bdr = '#ef4444'; }
      pct = Math.round(p * 100) + '%';
    }
    el.style.background  = bg;
    el.style.borderColor = bdr;
    el.innerHTML =
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;margin-bottom:4px;">RC Sort - Total Vol</div>' +
      '<div style="font-size:22px;font-weight:900;color:' + col + ';line-height:1.1;">' + (rcSortVol !== null ? rcSortVol.toLocaleString() : '-') + '</div>' +
      '<div style="font-weight:900;font-size:10px;color:#94a3b8;margin-top:1px;">units processed</div>' +
      '<div style="font-weight:900;margin-top:4px;font-size:11px;color:#cbd5e1;">Goal: <span style="color:' + col + ';">' + (t ? t.toLocaleString() : 'Not set') + '</span></div>' +
      (pct ? '<div style="font-size:12px;font-weight:900;color:' + col + ';margin-top:2px;">' + pct + '</div>' : '');
  }

  function renderRates() {
    renderRateCard('uis5lb',  rates.uis5lb.rate,  rates.uis5lb.units,  rates.uis5lb.hours,  cfg.t5lb,     'UIS 5LB');
    renderRateCard('uis20lb', rates.uis20lb.rate, rates.uis20lb.units, rates.uis20lb.hours, cfg.t20lb,    'UIS 20LB');
    renderRateCard('manSort', rates.manSort.rate, rates.manSort.units, rates.manSort.hours, cfg.tManSort, 'MS Rate', 'grid-column:1/-1;');
    renderVolCard();
  }

  // -- Render: Bottom 5 tab -------------------------------------------------
  function renderB5Section(fn) {
    var el = document.getElementById('rc-b5-' + fn.key);
    if (!el) return;
    var rows = bottom5[fn.key];
    var html = '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #21262d;">' + fn.label + '</div>';
    if (!rows.length) {
      html += '<div style="font-size:11px;color:#484f58;font-weight:900;">No data</div>';
    } else {
      rows.forEach(function (row, i) {
        html +=
          '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">' +
          '<span style="font-size:12px;font-weight:900;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;" title="' + row.name + '">' + row.name + '</span>' +
          '<span style="font-size:12px;font-weight:900;color:' + ROW_COLORS[i] + ';margin-left:8px;flex-shrink:0;">' + row.rate.toFixed(1) + ' ' + fn.rateLabel + '</span>' +
          '</div>';
      });
    }
    el.innerHTML = html;
  }

  function renderBottom5() {
    B5_FUNCTIONS.forEach(renderB5Section);
  }

  // -- Tab switch -----------------------------------------------------------
  function showTab(name) {
    document.getElementById('rc-view-rates').style.display   = name === 'rates'   ? 'block' : 'none';
    document.getElementById('rc-view-b5').style.display      = name === 'bottom5' ? 'block' : 'none';
    ['rates', 'bottom5'].forEach(function (t) {
      var btn    = document.getElementById('rc-tb-' + t);
      var active = (t === name);
      btn.style.color            = active ? '#f1f5f9' : '#64748b';
      btn.style.fontWeight       = active ? '900'     : '600';
      btn.style.borderBottomColor = active ? '#60a5fa' : 'transparent';
    });
  }

  // -- Status ---------------------------------------------------------------
  function setStatus(msg) {
    var el = document.getElementById('rc-status');
    if (el) el.textContent = msg;
  }

  // -- Fetch (one request, feeds both tabs) ---------------------------------
  async function fetchAll() {
    if (fetching) return;
    fetching = true;
    setStatus('~| Fetching...');
    var btn = document.getElementById('rc-fetch');
    if (btn) btn.disabled = true;
    try {
      var html = await httpGet(buildURL());

      // --- Rates ---
      var _scp5 = parseFunctionRow(html, 'UIS_5lb_SCP_Induct');
      var _ind5 = parseFunctionRow(html, 'UIS_5lb_Induct');
      rates.uis5lb = {
        units: (_scp5.units || 0) + (_ind5.units || 0) || null,
        hours: (_scp5.hours || 0) + (_ind5.hours || 0) || null,
        rate:  _scp5.rate || _ind5.rate,
      };
      var _scp20 = parseFunctionRow(html, 'UIS_20lb_SCP_Induct');
      var _ind20 = parseFunctionRow(html, 'UIS_20lb_Induct');
      rates.uis20lb = {
        units: (_scp20.units || 0) + (_ind20.units || 0) || null,
        hours: (_scp20.hours || 0) + (_ind20.hours || 0) || null,
        rate:  _scp20.rate || _ind20.rate,
      };
      rates.manSort = parseFunctionRow(html, 'RC Sort Primary');
      rcSortVol = (rates.uis5lb.units || 0) + (rates.uis20lb.units || 0) + (rates.manSort.units || 0) || null;

      // --- Bottom 5 ---
      B5_FUNCTIONS.forEach(function (fn) {
        bottom5[fn.key] = parseBottom5(html, fn.fnName);
      });

      lastUpdated = new Date();
      renderRates();
      renderBottom5();
      setStatus('Updated ' + lastUpdated.toLocaleTimeString());
    } catch (e) {
      setStatus('!! ' + e.message);
      console.error('[FCLM RC]', e);
    } finally {
      fetching = false;
      if (btn) btn.disabled = false;
    }
  }

  // -- Timer ----------------------------------------------------------------
  function startTimer() { stopTimer(); if (cfg.autoRefresh) refreshTimer = setInterval(fetchAll, REFRESH_MS); }
  function stopTimer()  { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  // -- Apply settings -------------------------------------------------------
  function applySettings() {
    cfg.wh        = document.getElementById('rc-wh').value.toUpperCase()       || cfg.wh;
    cfg.startDate = fromInput(document.getElementById('rc-sdate').value)        || cfg.startDate;
    cfg.startHour = parseInt(document.getElementById('rc-shour').value, 10)     || 0;
    cfg.startMin  = parseInt(document.getElementById('rc-smin').value,  10)     || 0;
    cfg.endDate   = fromInput(document.getElementById('rc-edate').value)        || cfg.endDate;
    cfg.endHour   = parseInt(document.getElementById('rc-ehour').value, 10)     || 0;
    cfg.endMin    = parseInt(document.getElementById('rc-emin').value,  10)     || 0;
    cfg.t5lb      = document.getElementById('rc-t-5lb').value;
    cfg.t20lb     = document.getElementById('rc-t-20lb').value;
    cfg.tManSort  = document.getElementById('rc-t-mansort').value;
    cfg.tVol      = document.getElementById('rc-t-vol').value;
    Object.keys(cfg).forEach(function (k) { GM_setValue('rc_' + k, cfg[k]); });
    renderRates();
    fetchAll();
  }

  function toggleAuto() {
    cfg.autoRefresh = !cfg.autoRefresh;
    GM_setValue('rc_autoRefresh', cfg.autoRefresh);
    var b = document.getElementById('rc-auto');
    if (b) {
      b.textContent       = 'Auto: ' + (cfg.autoRefresh ? 'ON' : 'OFF');
      b.style.background  = cfg.autoRefresh ? '#14532d' : '#374151';
      b.style.borderColor = cfg.autoRefresh ? '#16a34a' : '#4b5563';
    }
    cfg.autoRefresh ? startTimer() : stopTimer();
  }

  // -- Style helpers --------------------------------------------------------
  var BASE  = 'box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;font-size:12px;';
  var S_INP = BASE + 'background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e2e8f0;outline:none;padding:4px 6px;width:100%;';
  var S_SM  = BASE + 'background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e2e8f0;outline:none;padding:4px 2px;width:44px;text-align:center;';
  function S_BTN(bg, bd) {
    return BASE + 'background:' + bg + ';border:1px solid ' + bd + ';border-radius:4px;color:#e2e8f0;cursor:pointer;font-weight:600;';
  }

  // -- Build HTML sections --------------------------------------------------
  var b5SectionsHTML = B5_FUNCTIONS.map(function (fn) {
    return '<div id="rc-b5-' + fn.key + '" style="padding:10px 14px;border-bottom:1px solid #21262d;"></div>';
  }).join('');

  // -- Build panel ----------------------------------------------------------
  var panel = document.createElement('div');
  panel.id = 'rc-panel';
  panel.style.cssText = [
    'position:fixed', 'top:20px', 'right:440px', 'width:400px',
    'background:#0d1117', 'border:1px solid #21262d', 'border-radius:10px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.7)', 'color:#e2e8f0',
    'z-index:2147483647', 'font-family:system-ui,-apple-system,sans-serif', 'font-size:13px',
  ].join(';');

  panel.innerHTML = [
    // -- Header
    '<div id="rc-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:#161b22;border-radius:10px 10px 0 0;cursor:grab;border-bottom:1px solid #21262d;">',
      '<span style="font-weight:900;font-size:13px;color:#f1f5f9;letter-spacing:0.2px;">RC Dept Tracker</span>',
      '<div style="display:flex;gap:10px;align-items:center;">',
        '<span id="rc-gear"    title="Settings" style="cursor:pointer;opacity:0.55;font-size:14px;line-height:1;">&#9881;</span>',
        '<span id="rc-min-btn" title="Minimize" style="cursor:pointer;opacity:0.55;font-size:18px;line-height:1;margin-top:-1px;">-</span>',
      '</div>',
    '</div>',

    // -- Settings
    '<div id="rc-settings" style="display:none;padding:12px 14px;border-bottom:1px solid #21262d;background:#0d1117;">',
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">',
        '<div style="font-weight:900;font-size:11px;color:#484f58;white-space:nowrap;">Site ID</div>',
        '<input id="rc-wh" type="text" maxlength="8" value="' + cfg.wh + '" placeholder="e.g. RFD2" style="' + S_INP + 'text-transform:uppercase;">',
      '</div>',
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#30363d;margin-bottom:8px;">Shift Window</div>',
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;">',
        '<span style="font-weight:900;width:34px;font-size:11px;color:#484f58;">Start</span>',
        '<input id="rc-sdate" type="date" value="' + toInput(cfg.startDate) + '" style="' + S_INP + '">',
        '<input id="rc-shour" type="number" min="0" max="23" value="' + cfg.startHour + '" style="' + S_SM + '">',
        '<span style="font-weight:900;color:#30363d;font-size:14px;">:</span>',
        '<input id="rc-smin"  type="number" min="0" max="59" value="' + pad2(cfg.startMin) + '" style="' + S_SM + '">',
      '</div>',
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:12px;">',
        '<span style="font-weight:900;width:34px;font-size:11px;color:#484f58;">End</span>',
        '<input id="rc-edate" type="date" value="' + toInput(cfg.endDate) + '" style="' + S_INP + '">',
        '<input id="rc-ehour" type="number" min="0" max="23" value="' + cfg.endHour + '" style="' + S_SM + '">',
        '<span style="font-weight:900;color:#30363d;font-size:14px;">:</span>',
        '<input id="rc-emin"  type="number" min="0" max="59" value="' + pad2(cfg.endMin) + '" style="' + S_SM + '">',
      '</div>',
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#30363d;margin-bottom:8px;">Rate Targets (UPH)</div>',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">',
        '<div><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">UIS 5LB</div>',
          '<input id="rc-t-5lb" type="number" value="' + cfg.t5lb + '" placeholder="e.g. 1100" style="' + S_INP + '"></div>',
        '<div><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">UIS 20LB</div>',
          '<input id="rc-t-20lb" type="number" value="' + cfg.t20lb + '" placeholder="e.g. 570" style="' + S_INP + '"></div>',
        '<div style="grid-column:1/-1"><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">MS Rate</div>',
          '<input id="rc-t-mansort" type="number" value="' + cfg.tManSort + '" placeholder="e.g. 300" style="' + S_INP + '"></div>',
        '<div style="grid-column:1/-1"><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">Total Vol Goal</div>',
          '<input id="rc-t-vol" type="number" value="' + cfg.tVol + '" placeholder="e.g. 400000" style="' + S_INP + '"></div>',
      '</div>',
      '<button id="rc-apply" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:6px 0;width:100%;">>> Apply Changes</button>',
    '</div>',

    // -- Tab bar
    '<div style="display:flex;border-bottom:1px solid #21262d;background:#0d1117;">',
      '<button id="rc-tb-rates"   style="' + BASE + 'flex:1;padding:8px 0;background:none;border:none;border-bottom:2px solid #60a5fa;color:#f1f5f9;font-weight:900;cursor:pointer;">Rates</button>',
      '<button id="rc-tb-bottom5" style="' + BASE + 'flex:1;padding:8px 0;background:none;border:none;border-bottom:2px solid transparent;color:#64748b;font-weight:600;cursor:pointer;">Bottom 5</button>',
    '</div>',

    // -- Rates view
    '<div id="rc-view-rates">',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 14px;">',
        '<div id="rc-c-uis5lb"  style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="rc-c-uis20lb" style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="rc-c-manSort" style="border-radius:8px;padding:12px 14px;min-height:130px;grid-column:1/-1;"></div>',
        '<div id="rc-vol" style="grid-column:1/-1;background:rgba(71,85,105,0.15);border:1px solid #334155;border-radius:8px;padding:10px;"></div>',
      '</div>',
    '</div>',

    // -- Bottom 5 view
    '<div id="rc-view-b5" style="display:none;">',
      b5SectionsHTML,
    '</div>',

    // -- Footer
    '<div style="display:flex;align-items:center;gap:8px;padding:6px 14px 10px;border-top:1px solid #21262d;">',
      '<button id="rc-fetch" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:5px 12px;">~| Fetch Now</button>',
      '<button id="rc-auto"  style="' + S_BTN(cfg.autoRefresh ? '#14532d' : '#374151', cfg.autoRefresh ? '#16a34a' : '#4b5563') + 'padding:5px 10px;">Auto: ' + (cfg.autoRefresh ? 'ON' : 'OFF') + '</button>',
      '<span id="rc-status" style="font-weight:900;font-size:11px;color:#484f58;flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Not fetched</span>',
    '</div>',
  ].join('');

  // -- Minimized tab --------------------------------------------------------
  var tab = document.createElement('div');
  tab.id = 'rc-tab';
  tab.style.cssText = 'position:fixed;right:0;top:240px;width:28px;height:120px;background:#161b22;border:1px solid #21262d;border-right:none;border-radius:8px 0 0 8px;cursor:pointer;display:none;z-index:2147483647;align-items:center;justify-content:center;writing-mode:vertical-rl;font-family:system-ui,-apple-system,sans-serif;font-size:11px;font-weight:900;color:#f1f5f9;letter-spacing:0.5px;user-select:none;';
  tab.textContent = 'RC Dept Tracker';

  // -- Mount ----------------------------------------------------------------
  function mount() {
    if (!document.body) { setTimeout(mount, 100); return; }
    document.body.appendChild(panel);
    document.body.appendChild(tab);
    init();
  }
  mount();

  function init() {
    // Initial placeholder state
    renderRates();
    B5_FUNCTIONS.forEach(function (fn) {
      var el = document.getElementById('rc-b5-' + fn.key);
      if (el) el.innerHTML = '<div style="font-size:11px;color:#484f58;font-weight:900;padding:4px 0;">No data</div>';
    });

    // Event listeners
    document.getElementById('rc-apply').addEventListener('click', applySettings);
    document.getElementById('rc-fetch').addEventListener('click', fetchAll);
    document.getElementById('rc-auto').addEventListener('click', toggleAuto);

    document.getElementById('rc-tb-rates').addEventListener('click',   function () { showTab('rates');   });
    document.getElementById('rc-tb-bottom5').addEventListener('click', function () { showTab('bottom5'); });

    document.getElementById('rc-gear').addEventListener('click', function () {
      var s = document.getElementById('rc-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('rc-min-btn').addEventListener('click', function () {
      document.getElementById('rc-settings').style.display = 'none';
      panel.style.display = 'none';
      tab.style.display   = 'flex';
    });
    tab.addEventListener('click', function () {
      tab.style.display   = 'none';
      panel.style.display = 'block';
    });

    // -- Drag
    var hdr      = document.getElementById('rc-hdr');
    var dragging = false, ox, oy, sx, sy;

    var savedX = GM_getValue('rc_posX', null);
    var savedY = GM_getValue('rc_posY', null);
    if (savedX !== null) {
      panel.style.left  = savedX + 'px';
      panel.style.right = 'auto';
      panel.style.top   = savedY + 'px';
    }

    hdr.addEventListener('mousedown', function (e) {
      if (e.target.id === 'rc-gear' || e.target.id === 'rc-min-btn') return;
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
        GM_setValue('rc_posX', parseInt(panel.style.left, 10));
        GM_setValue('rc_posY', parseInt(panel.style.top,  10));
      }
    });

    startTimer();
    fetchAll();
  }

})();
