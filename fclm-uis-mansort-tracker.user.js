// ==UserScript==
// @name         FCLM UIS / ManSort Tracker
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Floating overlay — UIS 5LB, UIS 20LB, ManSort rates from FCLM
// @author       Tyler
// @updateURL    https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-uis-mansort-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-uis-mansort-tracker.user.js
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

  const WH = () => cfg.wh;
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
    tVol:        GM_getValue('ums_tVol',        ''),
    autoRefresh: GM_getValue('ums_autoRefresh', true),
    wh:          GM_getValue('ums_wh', ''),
  };

  let rates = {
    uis5lb:  { rate: null, units: null, hours: null },
    uis20lb: { rate: null, units: null, hours: null },
    manSort: { rate: null, units: null, hours: null },
  };
  let rcSortVol  = null;
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
      'reportFormat=HTML&warehouseId=' + WH() + '&processId=1003009&maxIntradayDays=1&spanType=Intraday' +
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

  // ── Helpers ──────────────────────────────────────────────────────────────
  function nthNum(row, n) {
    var cells = row.querySelectorAll('td');
    var count = 0;
    for (var i = 0; i < cells.length; i++) {
      var v = parseFloat(cells[i].textContent.trim().replace(/,/g, ''));
      if (!isNaN(v)) { if (count === n) return v; count++; }
    }
    return null;
  }

  // ── Parser ─────────────────────────────────────────────────────────────────────────
  // Parse HTML once and cache the doc.
  var _cachedDoc  = null;
  var _cachedHtml = null;
  function getDoc(html) {
    if (html !== _cachedHtml) {
      _cachedDoc  = new DOMParser().parseFromString(html, 'text/html');
      _cachedHtml = html;
    }
    return _cachedDoc;
  }

  // Aggregate employee rows for a named function section.
  // No summary Total row exists — must sum individual rows.
  //
  // Cell layout (0-indexed, fixed 21 cols on Total tab):
  //   [0]=Type  [1]=ID  [2]=Name  [3]=Manager
  //   [4-7]=Size Hrs (S/M/L/HB)  [8]=Total Hrs
  //   [9]=Jobs  [10]=JPH
  //   [11-18]=EACH-S/M/L/HB UNIT+UPH pairs
  //   [19]=EACH-Total UNIT  [20]=EACH-Total UPH
  //
  // isSort=true  → rate = totalJobs / totalHrs  (JPH, for RC Sort)
  // isSort=false → rate = totalUnits / totalHrs (UPH, for UIS)
  // units always = EACH-Total UNIT (for volume card)
  // Skips Anonymous rows (ID=000000).
  function parseSection(html, fnName, isSort) {
    var doc    = getDoc(html);
    var needle = fnName.toLowerCase();
    var tables = doc.querySelectorAll('table');

    for (var t = 0; t < tables.length; t++) {
      if (tables[t].textContent.toLowerCase().indexOf(needle) < 0) continue;
      var rows = tables[t].querySelectorAll('tr');
      var inSection = false;
      var totalHours = 0, totalUnits = 0, totalJobs = 0;
      var hasData = false;

      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('td');
        if (!cells.length) continue;
        var rowText = rows[r].textContent.toLowerCase();
        var type    = cells[0] ? cells[0].textContent.trim() : '';

        // Section header: row contains our function name.
        if (rowText.indexOf(needle) >= 0) {
          if (inSection && hasData) break; // already processed this section
          inSection = true;
          continue;
        }
        if (!inSection) continue;

        // New section started (another function’s header has bracket ID, not a data row).
        var isDataRow = /^(AMZN|TEMP|3PTY)$/.test(type);
        if (!isDataRow && rowText.indexOf('[') >= 0) {
          if (hasData) break;
          continue;
        }

        // Skip column headers and any other non-data rows.
        if (!isDataRow) continue;

        // Skip Anonymous — untracked items with no hours.
        var id = cells[1] ? cells[1].textContent.trim() : '';
        if (id === '000000') continue;

        // Need at least 20 cells for a full data row.
        if (cells.length < 20) continue;

        var hrs   = parseFloat((cells[8].textContent  || '').replace(/,/g, ''));
        var units = parseFloat((cells[19].textContent || '').replace(/,/g, ''));
        var jobs  = parseFloat((cells[9].textContent  || '').replace(/,/g, ''));

        if (!isNaN(hrs) && hrs > 0) {
          totalHours += hrs;
          if (!isNaN(units) && units > 0) totalUnits += units;
          if (!isNaN(jobs)  && jobs  > 0) totalJobs  += jobs;
          hasData = true;
        }
      }

      if (hasData && totalHours > 0) {
        var rate = isSort ? (totalJobs / totalHours) : (totalUnits / totalHours);
        console.log('[FCLM UMS] ' + fnName + ' rate=' + rate.toFixed(1) +
          ' units=' + totalUnits + ' jobs=' + totalJobs + ' hrs=' + totalHours.toFixed(2));
        return { rate: rate, units: totalUnits, hours: totalHours };
      }
    }

    console.log('[FCLM UMS] ' + fnName + ': no data found');
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

  // ── Render cards ─────────────────────────────────────────────────────────
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

  function renderRCSortVol() {
    var el = document.getElementById('ums-rc-vol');
    if (!el) return;
    var t = parseFloat(cfg.tVol);
    var hasTgt = rcSortVol !== null && t && !isNaN(t);
    var p = hasTgt ? rcSortVol / t : null;
    var col = '#cbd5e1';
    var bg  = 'rgba(71,85,105,0.15)';
    var bdr = '#334155';
    var pct = '';
    if (p !== null) {
      if (p >= 1.00) { col = '#4ade80'; bg = 'rgba(34,197,94,0.13)';  bdr = '#22c55e'; }
      else if (p >= 0.85) { col = '#fbbf24'; bg = 'rgba(245,158,11,0.13)'; bdr = '#f59e0b'; }
      else { col = '#f87171'; bg = 'rgba(239,68,68,0.13)'; bdr = '#ef4444'; }
      pct = Math.round(p * 100) + '%';
    }
    el.style.background = bg;
    el.style.borderColor = bdr;
    el.innerHTML =
      '<div style="font-weight:900;font-size:10px;text-transform:uppercase;letter-spacing:0.6px;color:#94a3b8;margin-bottom:4px;">RC Sort — Total Vol</div>' +
      '<div style="font-size:22px;font-weight:900;color:' + col + ';line-height:1.1;">' + (rcSortVol !== null ? rcSortVol.toLocaleString() : '—') + '</div>' +
      '<div style="font-weight:900;font-size:10px;color:#94a3b8;margin-top:1px;">units processed</div>' +
      '<div style="font-weight:900;margin-top:4px;font-size:11px;color:#cbd5e1;">Goal: <span style="color:' + col + ';">' + (t ? t.toLocaleString() : 'Not set') + '</span></div>' +
      (pct ? '<div style="font-size:12px;font-weight:900;color:' + col + ';margin-top:2px;">' + pct + '</div>' : '');
  }

  function renderAll() {
    renderCard('uis5lb',  rates.uis5lb.rate,  rates.uis5lb.units,  rates.uis5lb.hours,  cfg.t5lb,     'UIS 5LB');
    renderCard('uis20lb', rates.uis20lb.rate, rates.uis20lb.units, rates.uis20lb.hours, cfg.t20lb,    'UIS 20LB');
    renderCard('manSort', rates.manSort.rate, rates.manSort.units, rates.manSort.hours, cfg.tManSort, 'MS Rate', 'grid-column:1/-1;');
    renderRCSortVol();
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

      // UIS 5LB: SCP-only rate; units = SCP + non-SCP combined
      var _scp5 = parseSection(html, 'UIS_5lb_SCP_Induct', false);
      var _ind5 = parseSection(html, 'UIS_5lb_Induct',     false);
      rates.uis5lb = {
        rate:  _scp5.rate,
        units: (_scp5.units || 0) + (_ind5.units || 0) || null,
        hours: (_scp5.hours || 0) + (_ind5.hours || 0) || null,
      };

      // UIS 20LB: SCP-only rate; units = SCP + non-SCP combined
      var _scp20 = parseSection(html, 'UIS_20lb_SCP_Induct', false);
      var _ind20 = parseSection(html, 'UIS_20lb_Induct',     false);
      rates.uis20lb = {
        rate:  _scp20.rate,
        units: (_scp20.units || 0) + (_ind20.units || 0) || null,
        hours: (_scp20.hours || 0) + (_ind20.hours || 0) || null,
      };

      // ManSort: JPH rate from RC Sort Primary
      rates.manSort = parseSection(html, 'RC Sort Primary', true);

      // Total vol = sum of EACH-Total units across all three functions
      var _v = (rates.uis5lb.units || 0) + (rates.uis20lb.units || 0) + (rates.manSort.units || 0);
      rcSortVol = _v || null;
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
    cfg.wh         = document.getElementById('ums-wh').value.toUpperCase() || cfg.wh;
    cfg.t5lb       = document.getElementById('ums-t-5lb').value;
    cfg.t20lb      = document.getElementById('ums-t-20lb').value;
    cfg.tManSort   = document.getElementById('ums-t-mansort').value;
    cfg.tVol       = document.getElementById('ums-t-vol').value;
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
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">',
        '<div style="font-weight:900;font-size:11px;color:#484f58;white-space:nowrap;">Site ID</div>',
        '<input id="ums-wh" type="text" maxlength="8" value="' + cfg.wh + '" placeholder="e.g. RFD2" style="' + S_INP + 'text-transform:uppercase;">',
      '</div>',
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
        '<div style="grid-column:1/-1"><div style="font-weight:900;font-size:11px;color:#484f58;margin-bottom:3px;">Total Vol Goal</div>',
        '<input id="ums-t-vol" type="number" value="' + cfg.tVol + '" placeholder="e.g. 400000" style="' + S_INP + '"></div>',
      '</div>',
      '<button id="ums-apply" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:6px 0;width:100%;">✓ Apply Changes</button>',
    '</div>',

    '<div id="ums-body">',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 14px;">',
        '<div id="ums-c-uis5lb"  style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="ums-c-uis20lb" style="border-radius:8px;padding:10px;min-height:96px;"></div>',
        '<div id="ums-c-manSort" style="border-radius:8px;padding:12px 14px;min-height:130px;grid-column:1/-1;"></div>',
        '<div id="ums-rc-vol" style="grid-column:1/-1;background:rgba(71,85,105,0.15);border:1px solid #334155;border-radius:8px;padding:10px;"></div>',
      '</div>',
      '<div style="display:flex;align-items:center;gap:8px;padding:6px 14px 12px;border-top:1px solid #21262d;">',
        '<button id="ums-fetch" style="' + S_BTN('#1f6feb','#388bfd') + 'padding:5px 12px;">⟳ Fetch Now</button>',
        '<button id="ums-auto"  style="' + S_BTN(cfg.autoRefresh ? '#14532d' : '#374151', cfg.autoRefresh ? '#16a34a' : '#4b5563') + 'padding:5px 10px;">Auto: ' + (cfg.autoRefresh ? 'ON' : 'OFF') + '</button>',
        '<span id="ums-status" style="font-weight:900;font-size:11px;color:#484f58;flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Not fetched</span>',
      '</div>',
    '</div>',
  ].join('');

  // ── Tab (minimized state) ────────────────────────────────────────────────
  var tab = document.createElement('div');
  tab.id = 'ums-rt-tab';
  tab.style.cssText = 'position:fixed;right:0;top:240px;width:28px;height:120px;background:#161b22;border:1px solid #21262d;border-right:none;border-radius:8px 0 0 8px;cursor:pointer;display:none;z-index:2147483647;align-items:center;justify-content:center;writing-mode:vertical-rl;font-family:system-ui,-apple-system,sans-serif;font-size:11px;font-weight:900;color:#f1f5f9;letter-spacing:0.5px;user-select:none;';
  tab.textContent = '\ud83d\udce6 UIS / ManSort';

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

    document.getElementById('ums-apply').addEventListener('click', applySettings);
    document.getElementById('ums-fetch').addEventListener('click', fetchAll);
    document.getElementById('ums-auto').addEventListener('click', toggleAuto);

    document.getElementById('ums-gear').addEventListener('click', function () {
      var s = document.getElementById('ums-settings');
      s.style.display = s.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('ums-min-btn').addEventListener('click', function () {
      document.getElementById('ums-settings').style.display = 'none';
      panel.style.display = 'none';
      tab.style.display   = 'flex';
    });
    tab.addEventListener('click', function () {
      tab.style.display   = 'none';
      panel.style.display = 'block';
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
