// ==UserScript==
// @name         FCLM ManSort Cohort Dashboard
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Live 4-cohort (FHD/FHN/BHD/BHN) ManSort dashboard for IMO1 — auto-pulls processPathRollup per shift window, Wednesday ownership alternates, Today/Last 7 Days/Custom views, self-contained inline charts (no CDN).
// @author       Tyler
// @match        *://fclm-portal.amazon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      fclm-portal.amazon.com
// @exclude      *://fclm-portal.amazon.com/employee/timeDetails*
// @exclude      *://fclm-portal.amazon.com/reports/ppaTimeOnTask*
// @exclude      *://fclm-portal.amazon.com/reports/timeOnTask*
// @exclude      *://fclm-portal.amazon.com/employee/ppaTimeDetails*
// @updateURL    https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-mansort-cohort-dashboard.user.js
// @downloadURL  https://raw.githubusercontent.com/tytyh-cloud/tampermonkey-scripts/main/fclm-mansort-cohort-dashboard.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ===== CONFIG (persisted) =====
  const CFG = {
    wh:             GM_getValue('msd_wh', 'IMO1'),
    label:          'Manual Sort - Total',
    greenUPH:       GM_getValue('msd_green', 250),
    yellowUPH:      GM_getValue('msd_yellow', 200),
    rangeDays:      GM_getValue('msd_rangeDays', 35),
    autoRefreshMin: GM_getValue('msd_autoMin', 5),
    dayStart:   { h: 6,  m: 30 },
    dayEnd:     { h: 18, m: 0  },
    nightStart: { h: 18, m: 0  },
    nightEnd:   { h: 5,  m: 0  },
    wedAnchor:      GM_getValue('msd_wedAnchor', '2026-10-07'),
    wedAnchorOwner: GM_getValue('msd_wedOwner', 'BH'),
    wedOverrides:   safeParse(GM_getValue('msd_wedOverrides', '{}'), {}),
  };

  const SHIFTS = ['FHD', 'FHN', 'BHD', 'BHN'];
  const SHIFT_NAMES = { FHD: 'Front Half Days', FHN: 'Front Half Nights', BHD: 'Back Half Days', BHN: 'Back Half Nights' };
  const SHIFT_COLORS = { FHD: '#0052CC', FHN: '#6554C0', BHD: '#00B8D9', BHN: '#FF5630' };
  const REFRESH_MS = 60000;

  function safeParse(s, dflt) { try { return JSON.parse(s); } catch (e) { return dflt; } }

  // ===== DATA STORE (persisted) =====
  let store = safeParse(GM_getValue('msd_data', '{}'), {});
  function saveStore() { GM_setValue('msd_data', JSON.stringify(store)); }
  function records() { return Object.values(store); }
  function putRecord(r) { store[r.date + '|' + r.shift] = r; }

  // ===== DATE HELPERS (local-time, YYYY-MM-DD) =====
  const pad = n => String(n).padStart(2, '0');
  function localStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return localStr(new Date()); }
  function addDays(dstr, n) { const d = new Date(dstr + 'T12:00:00'); d.setDate(d.getDate() + n); return localStr(d); }
  function dow(dstr) { return new Date(dstr + 'T12:00:00').getDay(); }
  function toFCLM(dstr) { return dstr.replace(/-/g, '/'); }

  // ===== WEDNESDAY OWNERSHIP =====
  function wednesdayOwner(dstr) {
    if (CFG.wedOverrides[dstr]) return CFG.wedOverrides[dstr];
    const anchor = new Date(CFG.wedAnchor + 'T12:00:00');
    const d = new Date(dstr + 'T12:00:00');
    const weeks = Math.round((d - anchor) / (7 * 86400000));
    const flip = ((weeks % 2) + 2) % 2;
    const other = CFG.wedAnchorOwner === 'BH' ? 'FH' : 'BH';
    return flip === 0 ? CFG.wedAnchorOwner : other;
  }

  function windowsForDate(dstr) {
    const d = dow(dstr);
    const out = [];
    const dayWin   = sh => ({ shift: sh, startDate: dstr, sh: CFG.dayStart.h,   sm: CFG.dayStart.m,   endDate: dstr,            eh: CFG.dayEnd.h,   em: CFG.dayEnd.m });
    const nightWin = sh => ({ shift: sh, startDate: dstr, sh: CFG.nightStart.h, sm: CFG.nightStart.m, endDate: addDays(dstr,1), eh: CFG.nightEnd.h, em: CFG.nightEnd.m });
    if (d === 3) { const own = wednesdayOwner(dstr); out.push(dayWin(own + 'D'), nightWin(own + 'N')); }
    else if (d === 0 || d === 1 || d === 2) { out.push(dayWin('FHD'), nightWin('FHN')); }
    else if (d === 4 || d === 5 || d === 6) { out.push(dayWin('BHD'), nightWin('BHN')); }
    return out;
  }

  // ===== FETCH + PARSE =====
  function buildURL(w) {
    return 'https://fclm-portal.amazon.com/reports/processPathRollup?reportFormat=HTML' +
      '&warehouseId=' + encodeURIComponent(CFG.wh) +
      '&startDateDay=' + encodeURIComponent(toFCLM(w.endDate)) + '&maxIntradayDays=1&spanType=Intraday' +
      '&startDateIntraday=' + encodeURIComponent(toFCLM(w.startDate)) + '&startHourIntraday=' + w.sh + '&startMinuteIntraday=' + w.sm +
      '&endDateIntraday='   + encodeURIComponent(toFCLM(w.endDate))   + '&endHourIntraday='   + w.eh + '&endMinuteIntraday='   + w.em +
      '&_adjustPlanHours=on&_hideEmptyLineItems=off&_rememberViewForWarehouse=on&employmentType=AllEmployees';
  }

  function httpGet(url) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method: 'GET', url,
      onload:  r => r.status === 200 ? res(r.responseText) : rej(new Error('HTTP ' + r.status)),
      onerror: () => rej(new Error('Network error')),
    }));
  }

  const normLabel = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function parseLineItem(html, label) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const target = normLabel(label);
    const rows = doc.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      for (let i = 0; i < cells.length; i++) {
        const cn = normLabel(cells[i].textContent);
        if (cn && cn.indexOf(target) === 0) {
          const nums = [];
          for (let j = i + 1; j < cells.length && nums.length < 3; j++) {
            const v = parseFloat(cells[j].textContent.trim().replace(/,/g, ''));
            if (!isNaN(v)) nums.push(v);
          }
          if (nums.length === 3) return { units: nums[0], hours: nums[1], rate: nums[2] };
        }
      }
    }
    return null;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let fetching = false;

  async function fetchWindow(w) {
    const html = await httpGet(buildURL(w));
    const li = parseLineItem(html, CFG.label);
    if (!li || !li.hours) return null;
    const rec = { date: w.startDate, shift: w.shift, uph: Math.round(li.rate), units: Math.round(li.units), hours: Math.round(li.hours * 10) / 10, fetchedAt: Date.now() };
    putRecord(rec);
    return rec;
  }

  async function fetchRange(days) {
    if (fetching) return;
    fetching = true;
    try {
      const end = todayStr();
      const start = addDays(end, -(days - 1));
      const wins = [];
      for (let d = start; d <= end; d = addDays(d, 1)) windowsForDate(d).forEach(w => wins.push(w));
      let done = 0, added = 0;
      for (const w of wins) {
        try { if (await fetchWindow(w)) added++; } catch (e) { console.warn('[MSD]', w.shift, w.startDate, e.message); }
        done++;
        setStatus('Fetching ' + done + '/' + wins.length + '...');
        await sleep(120);
      }
      saveStore();
      setStatus('Updated ' + new Date().toLocaleTimeString() + ' - ' + records().length + ' shift rows');
      refreshAll();
    } finally { fetching = false; }
  }

  // ===== VIEW FILTER + AGGREGATION =====
  let currentView = 'today';
  let customFrom = null, customTo = null;

  function maxDate(rows) { return rows.reduce((a, b) => a.date > b.date ? a : b).date; }

  function getFilteredData() {
    const all = records();
    if (all.length === 0) return [];
    const mx = maxDate(all);
    if (currentView === 'today') return all.filter(d => d.date === mx);
    if (currentView === 'custom') {
      if (!customFrom || !customTo) return all.slice();
      return all.filter(d => d.date >= customFrom && d.date <= customTo);
    }
    const wr = weekRange();
    return all.filter(d => d.date >= wr.from && d.date <= wr.to);
  }

  function getStatusColor(uph) { return uph >= CFG.greenUPH ? 'green' : uph >= CFG.yellowUPH ? 'yellow' : 'red'; }

  function getLatestByShift() {
    const out = {}, all = records();
    SHIFTS.forEach(sh => { const e = all.filter(d => d.shift === sh); if (e.length) out[sh] = e.reduce((a, b) => a.date > b.date ? a : b); });
    return out;
  }

  function getTrailing7ByShift() {
    const out = {}, all = records();
    if (!all.length) return out;
    const mx = maxDate(all), cs = addDays(mx, -6);
    SHIFTS.forEach(sh => {
      const rows = all.filter(d => d.shift === sh && d.date >= cs && d.date <= mx);
      if (!rows.length) return;
      const u = rows.reduce((s, r) => s + r.units, 0), h = rows.reduce((s, r) => s + r.hours, 0);
      if (!h) return;
      out[sh] = { uph: Math.round(u / h), units: u, hours: Math.round(h * 10) / 10, shifts: rows.length };
    });
    return out;
  }

  // Previous complete Sun-Sat week relative to today (local).
  function weekRange() {
    const n = new Date();
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const sun = new Date(today); sun.setDate(today.getDate() - today.getDay() - 7); // last week's Sunday
    const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
    return { from: localStr(sun), to: localStr(sat) };
  }
  const fmtMD = s => { const p = s.split('-'); return (+p[1]) + '/' + (+p[2]); };
  // volume-weighted per-cohort summary over an inclusive date range
  function cohortSummaryInRange(from, to) {
    const out = {}, all = records();
    SHIFTS.forEach(sh => {
      const rows = all.filter(d => d.shift === sh && d.date >= from && d.date <= to);
      if (!rows.length) return;
      const u = rows.reduce((s, r) => s + r.units, 0), h = rows.reduce((s, r) => s + r.hours, 0);
      if (!h) return;
      out[sh] = { uph: Math.round(u / h), units: u, hours: Math.round(h * 10) / 10, shifts: rows.length };
    });
    return out;
  }

  function computeMonthData() {
    const all = records();
    if (!all.length) return null;
    const months = {};
    all.forEach(r => { const m = r.date.slice(0, 7); (months[m] = months[m] || []).push(r); });
    const monthKeys = Object.keys(months).sort();
    const latestMonth = all.reduce((a, b) => a.date > b.date ? a : b).date.slice(0, 7);
    const rowsThis = months[latestMonth];
    const sum = rows => { const u = rows.reduce((s, r) => s + r.units, 0), h = rows.reduce((s, r) => s + r.hours, 0); return { units: u, hours: Math.round(h * 10) / 10, uph: h ? Math.round(u / h * 10) / 10 : 0 }; };
    const cohorts = {}; SHIFTS.forEach(sh => { const rs = rowsThis.filter(r => r.shift === sh); if (rs.length) cohorts[sh] = sum(rs); });
    const through = rowsThis.reduce((a, b) => a.date > b.date ? a : b).date;
    const mlabel = m => new Date(m + '-01T12:00:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    return {
      mtd: { month: latestMonth, label: new Date(latestMonth + '-01T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), through, site: sum(rowsThis), cohorts },
      history: monthKeys.map(m => Object.assign({ month: m, label: mlabel(m) }, sum(months[m]))),
    };
  }

  // ===== INLINE SVG CHARTS =====
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function niceMax(v, step) { step = step || 50; return Math.max(step, Math.ceil((v * 1.1) / step) * step); }

  function lineChart(width, dates, series, opts) {
    opts = opts || {};
    const W = width, H = opts.height || 300, padL = 46, padR = 14, padT = 16, padB = 54;
    const pw = W - padL - padR, ph = H - padT - padB;
    const vals = []; series.forEach(s => s.data.forEach(v => { if (v != null) vals.push(v); }));
    if (opts.target) vals.push(opts.target);
    const ymax = niceMax(vals.length ? Math.max(...vals) : 100);
    const x = i => padL + (dates.length <= 1 ? pw / 2 : (i / (dates.length - 1)) * pw);
    const y = v => padT + ph - (v / ymax) * ph;
    let s = '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" font-family="Amazon Ember, Segoe UI, sans-serif">';
    for (let g = 0; g <= 4; g++) { const v = ymax * g / 4, yy = y(v); s += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="#e5e7eb"/><text x="' + (padL - 6) + '" y="' + (yy + 3) + '" text-anchor="end" font-size="10" fill="#9ca3af">' + Math.round(v) + '</text>'; }
    if (opts.target) { const yt = y(opts.target); s += '<rect x="' + padL + '" y="' + padT + '" width="' + pw + '" height="' + (yt - padT) + '" fill="rgba(0,128,47,0.05)"/><line x1="' + padL + '" y1="' + yt + '" x2="' + (W - padR) + '" y2="' + yt + '" stroke="#00802f" stroke-dasharray="4 3"/><text x="' + (W - padR) + '" y="' + (yt - 4) + '" text-anchor="end" font-size="10" fill="#00802f">Target ' + opts.target + '</text>'; }
    const stepX = Math.ceil(dates.length / 8) || 1;
    dates.forEach((d, i) => { if (i % stepX === 0 || i === dates.length - 1) s += '<text x="' + x(i) + '" y="' + (H - padB + 16) + '" text-anchor="middle" font-size="9" fill="#9ca3af" transform="rotate(35 ' + x(i) + ' ' + (H - padB + 16) + ')">' + esc(d.slice(5)) + '</text>'; });
    series.forEach(se => {
      let path = '', pts = '';
      se.data.forEach((v, i) => {
        if (v == null) return;
        path += (path === '' || se.data[i - 1] == null ? 'M' : 'L') + x(i) + ',' + y(v);
        pts += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="3" fill="' + se.color + '"><title>' + se.name + ' - ' + dates[i] + ' - ' + v + ' UPH</title></circle>';
      });
      s += '<path d="' + path + '" fill="none" stroke="' + se.color + '" stroke-width="2"/>' + pts;
    });
    return s + '</svg>' + legend(series);
  }

  function groupedBarChart(width, dates, series, opts) {
    opts = opts || {};
    const W = width, H = opts.height || 300, padL = 50, padR = 14, padT = 16, padB = 54;
    const pw = W - padL - padR, ph = H - padT - padB;
    const vals = []; series.forEach(s => s.data.forEach(v => { if (v != null) vals.push(v); }));
    const ymax = niceMax(vals.length ? Math.max(...vals) : 100, 10000);
    const y = v => padT + ph - (v / ymax) * ph;
    const groups = dates.length || 1, gw = pw / groups, bw = Math.max(2, (gw * 0.8) / series.length);
    let s = '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" font-family="Amazon Ember, Segoe UI, sans-serif">';
    for (let g = 0; g <= 4; g++) { const v = ymax * g / 4, yy = y(v); s += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="#e5e7eb"/><text x="' + (padL - 6) + '" y="' + (yy + 3) + '" text-anchor="end" font-size="10" fill="#9ca3af">' + (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)) + '</text>'; }
    const stepX = Math.ceil(dates.length / 8) || 1;
    dates.forEach((d, i) => {
      const gx = padL + i * gw + (gw - bw * series.length) / 2;
      series.forEach((se, k) => {
        const v = se.data[i]; if (v == null) return;
        const bh = (v / ymax) * ph, bx = gx + k * bw, by = padT + ph - bh;
        s += '<rect x="' + bx + '" y="' + by + '" width="' + (bw - 1) + '" height="' + bh + '" fill="' + se.color + '" rx="1"><title>' + se.name + ' - ' + d + ' - ' + v.toLocaleString() + ' units</title></rect>';
      });
      if (i % stepX === 0 || i === dates.length - 1) s += '<text x="' + (padL + i * gw + gw / 2) + '" y="' + (H - padB + 16) + '" text-anchor="middle" font-size="9" fill="#9ca3af" transform="rotate(35 ' + (padL + i * gw + gw / 2) + ' ' + (H - padB + 16) + ')">' + esc(d.slice(5)) + '</text>';
    });
    return s + '</svg>' + legend(series);
  }

  function comparisonChart(width, items, opts) {
    opts = opts || {};
    const W = width, rowH = 34, H = items.length * rowH + 24, padL = 120, padR = 48, pw = W - padL - padR;
    const vals = items.map(it => it.value);
    const vmax = niceMax(vals.length ? Math.max(...vals) : 100);
    let s = '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" font-family="Amazon Ember, Segoe UI, sans-serif">';
    if (opts.target) { const tx = padL + (opts.target / vmax) * pw; s += '<line x1="' + tx + '" y1="8" x2="' + tx + '" y2="' + (H - 8) + '" stroke="#00802f" stroke-dasharray="4 3"/><text x="' + tx + '" y="7" text-anchor="middle" font-size="9" fill="#00802f">Target ' + opts.target + '</text>'; }
    items.forEach((it, i) => {
      const cy = 16 + i * rowH, bw = (it.value / vmax) * pw;
      s += '<text x="' + (padL - 8) + '" y="' + (cy + rowH / 2 - 2) + '" text-anchor="end" font-size="11" fill="#374151">' + esc(it.label) + '</text>';
      s += '<rect x="' + padL + '" y="' + (cy + 4) + '" width="' + Math.max(0, bw) + '" height="' + (rowH - 14) + '" fill="' + it.color + '" rx="2"/>';
      s += '<text x="' + (padL + Math.max(0, bw) + 6) + '" y="' + (cy + rowH / 2 - 1) + '" font-size="11" font-weight="700" fill="#374151">' + it.value + '</text>';
    });
    return s + '</svg>';
  }

  function legend(series) {
    return '<div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin-top:6px;font-size:11px;color:#5e5e5e;">' +
      series.map(s => '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + s.color + ';margin-right:4px;"></span>' + esc(s.name) + '</span>').join('') + '</div>';
  }

  // ===== UI =====
  let launcher, overlay;
  function el(tag, attrs, html) { const e = document.createElement(tag); if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function setStatus(msg) { const s = document.getElementById('msd-status'); if (s) s.textContent = msg; }

  function buildLauncher() {
    launcher = el('button', { id: 'msd-launch', title: 'ManSort Cohort Dashboard' });
    launcher.textContent = 'ManSort Dashboard';
    Object.assign(launcher.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483000, background: '#4200db', color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 14px', font: '600 13px Amazon Ember, Segoe UI, sans-serif', cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.25)' });
    launcher.addEventListener('click', openDashboard);
    document.body.appendChild(launcher);
  }

  function buildOverlay() {
    overlay = el('div', { id: 'msd-overlay' });
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: 2147483001, display: 'none', background: '#faf9fc', color: '#131920', overflow: 'auto', font: '13px Amazon Ember, Segoe UI, sans-serif', padding: '18px 22px' });
    overlay.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px;"><h1 style="margin:0;font-size:20px;">IMO1 ManSort Cohort Dashboard</h1><span id="msd-status" style="font-size:12px;color:#9ca3af;"></span><div style="flex:1"></div><button id="msd-close" style="background:#fff;border:1px solid #0000001f;border-radius:8px;padding:8px 14px;cursor:pointer;">Close</button></div>' +
      '<div style="font-size:12px;color:#5e5e5e;margin-bottom:14px;">Cohort shift performance - auto-pulled from FCLM. Wednesdays credited to the owning crew.</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;"><button class="msd-view" data-v="today">Today</button><button class="msd-view" data-v="week">Last Week</button><button class="msd-view" data-v="custom">Custom Range</button><span id="msd-custom" style="display:none;gap:8px;align-items:center;"><label style="font-size:12px;">From <input type="date" id="msd-from"></label><label style="font-size:12px;">To <input type="date" id="msd-to"></label><button id="msd-apply">Apply</button></span><div style="flex:1"></div><button id="msd-reload">Full Reload (' + CFG.rangeDays + 'd)</button><button id="msd-settings">Settings</button><button id="msd-csv">Export CSV</button></div>' +
      '<div id="msd-kpis" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;"></div>' +
      '<div id="msd-mtd-head" style="display:flex;align-items:center;gap:10px;margin:4px 0 10px 0;"><h3 id="msd-mtd-title" style="margin:0;font-size:14px;">Month to Date</h3><span id="msd-mtd-label" style="font-size:12px;color:#9ca3af;"></span></div>' +
      '<div id="msd-mtd" style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px;"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;"><div class="msd-card"><div class="msd-ct">UPH Trend by Shift</div><div id="msd-ch-uph"></div></div><div class="msd-card"><div class="msd-ct">Units by Shift</div><div id="msd-ch-units"></div></div><div class="msd-card" style="grid-column:1/-1;"><div class="msd-ct">Latest Shift Comparison - UPH</div><div id="msd-ch-cmp"></div></div><div class="msd-card" style="grid-column:1/-1;"><div class="msd-ct">Month over Month - Units and UPH</div><div id="msd-ch-month"></div></div></div>' +
      '<div class="msd-card"><div class="msd-ct">Shift Detail Log</div><div style="overflow-x:auto;"><table id="msd-table" style="width:100%;border-collapse:collapse;font-size:12px;"></table></div></div>' +
      '<div id="msd-settings-panel" style="display:none;position:fixed;inset:0;background:#00000080;z-index:2147483002;align-items:center;justify-content:center;"></div>';
    const style = el('style');
    style.textContent =
      '#msd-overlay button{font:inherit;background:#fff;border:1px solid #0000001f;border-radius:8px;padding:7px 12px;cursor:pointer;}' +
      '#msd-overlay button.msd-active{background:#4200db;color:#fff;border-color:#4200db;}' +
      '#msd-overlay .msd-card{background:#fff;border:1px solid #0000000f;border-radius:10px;padding:14px;}' +
      '#msd-overlay .msd-ct{font-size:13px;font-weight:600;margin-bottom:8px;}' +
      '#msd-overlay .msd-kpi{background:#fff;border:1px solid #0000000f;border-radius:10px;padding:14px;position:relative;overflow:hidden;}' +
      '#msd-overlay .msd-bar{position:absolute;top:0;left:0;right:0;height:3px;}' +
      '#msd-overlay th{text-align:left;color:#9ca3af;font-size:11px;text-transform:uppercase;padding:8px 10px;border-bottom:2px solid #0000001f;}' +
      '#msd-overlay td{padding:8px 10px;border-bottom:1px solid #0000000f;font-family:SF Mono,Consolas,monospace;}' +
      '.msd-green{color:#00802f}.msd-yellow{color:#b8860b}.msd-red{color:#db0000}' +
      '.msd-bg-green{background:#00802f}.msd-bg-yellow{background:#f2b100}.msd-bg-red{background:#db0000}.msd-bg-gray{background:#9ca3af}';
    overlay.appendChild(style);
    document.body.appendChild(overlay);
    overlay.querySelector('#msd-close').addEventListener('click', () => { overlay.style.display = 'none'; });
    overlay.querySelectorAll('.msd-view').forEach(b => b.addEventListener('click', () => setView(b.getAttribute('data-v'), b)));
    overlay.querySelector('#msd-apply').addEventListener('click', () => { customFrom = document.getElementById('msd-from').value || null; customTo = document.getElementById('msd-to').value || null; refreshAll(); });
    overlay.querySelector('#msd-reload').addEventListener('click', () => fetchRange(CFG.rangeDays));
    overlay.querySelector('#msd-csv').addEventListener('click', exportCSV);
    overlay.querySelector('#msd-settings').addEventListener('click', openSettings);
    const t = overlay.querySelector('.msd-view[data-v="today"]'); if (t) t.classList.add('msd-active');
  }

  function openDashboard() {
    overlay.style.display = 'block';
    refreshAll();
    if (records().length === 0) fetchRange(CFG.rangeDays); else fetchRange(2);
  }

  function setView(v, btn) {
    currentView = v;
    overlay.querySelectorAll('.msd-view').forEach(b => b.classList.remove('msd-active'));
    if (btn) btn.classList.add('msd-active');
    document.getElementById('msd-custom').style.display = v === 'custom' ? 'inline-flex' : 'none';
    refreshAll();
  }

  // ===== RENDER =====
  function refreshAll() { if (!overlay || overlay.style.display === 'none') return; renderKPIs(); renderMTD(); renderTable(); renderCharts(); }

  function renderKPIs() {
    const latest = getLatestByShift(), week = getTrailing7ByShift();
    const wrap = document.getElementById('msd-kpis'); wrap.innerHTML = '';
    const weekView = currentView === 'week';
    const wr = weekView ? weekRange() : null;
    const wk = weekView ? cohortSummaryInRange(wr.from, wr.to) : {};
    const wlabel = weekView ? (fmtMD(wr.from) + '-' + fmtMD(wr.to)) : '';
    const header = sh => '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:600;">' + sh + ' - ' + SHIFT_NAMES[sh] + '</div>';
    const noData = sh => '<div class="msd-bar msd-bg-gray"></div>' + header(sh) + '<div style="font-size:26px;color:#9ca3af;">-</div><div style="font-size:12px;color:#9ca3af;">No data yet</div>';
    const bigCard = (st, sh, uph, subline) => '<div class="msd-bar msd-bg-' + st + '"></div>' + header(sh) + '<div style="font-size:26px;font-weight:700;font-family:SF Mono,Consolas,monospace;" class="msd-' + st + '">' + uph + ' <span style="font-size:13px;color:#9ca3af;">UPH</span></div><div style="font-size:12px;color:#5e5e5e;">' + subline + '</div>';
    SHIFTS.forEach(sh => {
      let inner;
      if (weekView) {
        const w = wk[sh];
        inner = w ? bigCard(getStatusColor(w.uph), sh, w.uph, wlabel + ' - ' + w.units.toLocaleString() + ' units - ' + w.hours + 'h - ' + w.shifts + ' shift' + (w.shifts === 1 ? '' : 's')) : noData(sh);
      } else {
        const d = latest[sh];
        if (d) {
          const st = getStatusColor(d.uph), w = week[sh]; let wline = '';
          if (w) { const delta = d.uph - w.uph, arrow = delta > 0 ? '+' : delta < 0 ? '-' : '', dc = delta > 0 ? '#00802f' : delta < 0 ? '#db0000' : '#9ca3af';
            wline = '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #0000000f;font-size:12px;color:#5e5e5e;">7-day avg <strong class="msd-' + getStatusColor(w.uph) + '">' + w.uph + ' UPH</strong> <span style="color:' + dc + ';font-size:11px;">' + arrow + Math.abs(delta) + '</span><div style="font-size:11px;color:#9ca3af;margin-top:2px;">' + w.units.toLocaleString() + ' units - ' + w.hours + 'h - ' + w.shifts + ' shift' + (w.shifts === 1 ? '' : 's') + '</div></div>'; }
          inner = bigCard(st, sh, d.uph, 'latest - ' + d.units.toLocaleString() + ' units - ' + d.hours + 'h - ' + d.date) + wline;
        } else { inner = noData(sh); }
      }
      wrap.appendChild(el('div', { class: 'msd-kpi' }, inner));
    });
  }

  function summarize(rows) {
    const sum = rs => { const u = rs.reduce((s, r) => s + r.units, 0), h = rs.reduce((s, r) => s + r.hours, 0); return { units: u, hours: Math.round(h * 10) / 10, uph: h ? Math.round(u / h * 10) / 10 : 0 }; };
    const cohorts = {}; SHIFTS.forEach(sh => { const rs = rows.filter(r => r.shift === sh); if (rs.length) cohorts[sh] = sum(rs); });
    return { site: sum(rows), cohorts };
  }

  function renderMTD() {
    const wrap = document.getElementById('msd-mtd'), label = document.getElementById('msd-mtd-label'), title = document.getElementById('msd-mtd-title');
    const head = document.getElementById('msd-mtd-head');
    // The Month to Date summary is redundant on the Last Week tab -> hide it there.
    if (currentView === 'week') { if (head) head.style.display = 'none'; wrap.style.display = 'none'; return; }
    if (head) head.style.display = 'flex';
    wrap.style.display = 'grid';
    const emptyCard = '<div class="msd-kpi"><div class="msd-bar msd-bg-gray"></div><div style="color:#9ca3af;">No data yet</div></div>';
    wrap.innerHTML = '';
    const card = (title, d, isSite) => {
      if (!d || !d.hours) return '<div class="msd-kpi"><div class="msd-bar msd-bg-gray"></div><div style="font-size:11px;text-transform:uppercase;color:#9ca3af;font-weight:600;">' + title + '</div><div style="color:#9ca3af;">-</div></div>';
      const st = isSite ? 'gray' : getStatusColor(d.uph);
      return '<div class="msd-kpi"><div class="msd-bar ' + (isSite ? '' : 'msd-bg-' + st) + '" style="' + (isSite ? 'background:#4200db' : '') + '"></div><div style="font-size:11px;text-transform:uppercase;color:#9ca3af;font-weight:600;">' + title + '</div><div style="font-size:24px;font-weight:700;font-family:SF Mono,Consolas,monospace;" class="' + (isSite ? '' : 'msd-' + st) + '">' + Math.round(d.uph) + ' <span style="font-size:12px;color:#9ca3af;">UPH</span></div><div style="font-size:12px;color:#5e5e5e;">' + Math.round(d.units).toLocaleString() + ' units - ' + Math.round(d.hours) + 'h</div></div>';
    };
    const render = summary => { let html = card('Site total - window sum', summary.site, true); SHIFTS.forEach(sh => html += card(sh + ' - ' + SHIFT_NAMES[sh], summary.cohorts[sh], false)); wrap.innerHTML = html; };
    if (currentView === 'custom' && customFrom && customTo) {
      if (title) title.textContent = 'Range Summary';
      const rows = getFilteredData();
      if (!rows.length) { label.textContent = customFrom + ' to ' + customTo + ' (no data)'; wrap.innerHTML = emptyCard; return; }
      label.textContent = customFrom + ' to ' + customTo;
      render(summarize(rows));
      return;
    }
    if (title) title.textContent = 'Month to Date';
    const md = computeMonthData();
    if (!md) { label.textContent = ''; wrap.innerHTML = emptyCard; return; }
    label.textContent = md.mtd.label + ' - through ' + md.mtd.through;
    render(md.mtd);
  }

  function renderTable() {
    const rows = getFilteredData().slice().sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : a.shift.localeCompare(b.shift));
    const t = document.getElementById('msd-table');
    let html = '<thead><tr><th>Date</th><th>Shift</th><th>UPH</th><th>Units</th><th>Hours</th><th>Status</th></tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:24px;">No data in this view.</td></tr>';
    else rows.forEach(d => { const st = getStatusColor(d.uph), lbl = st === 'green' ? 'On Target' : st === 'yellow' ? 'Caution' : 'Below Target'; html += '<tr><td>' + d.date + '</td><td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + SHIFT_COLORS[d.shift] + ';margin-right:6px;"></span>' + d.shift + '</td><td style="font-weight:600;">' + d.uph + '</td><td>' + d.units.toLocaleString() + '</td><td>' + d.hours + '</td><td class="msd-' + st + '" style="font-weight:600;">' + lbl + '</td></tr>'; });
    html += '</tbody>'; t.innerHTML = html;
  }

  function renderCharts() {
    const fd = getFilteredData();
    const dates = [...new Set(fd.map(d => d.date))].sort();
    const mkSeries = key => SHIFTS.map(sh => ({ name: sh, color: SHIFT_COLORS[sh], data: dates.map(dt => { const e = fd.find(d => d.date === dt && d.shift === sh); return e ? e[key] : null; }) }));
    document.getElementById('msd-ch-uph').innerHTML = lineChart(Math.max(320, document.getElementById('msd-ch-uph').clientWidth || 500), dates, mkSeries('uph'), { target: CFG.greenUPH });
    document.getElementById('msd-ch-units').innerHTML = groupedBarChart(Math.max(320, document.getElementById('msd-ch-units').clientWidth || 500), dates, mkSeries('units'), {});
    const latest = getLatestByShift();
    const cmp = SHIFTS.filter(sh => latest[sh]).map(sh => ({ label: sh + ' - ' + SHIFT_NAMES[sh], value: latest[sh].uph, color: SHIFT_COLORS[sh] }));
    document.getElementById('msd-ch-cmp').innerHTML = cmp.length ? comparisonChart(Math.max(320, document.getElementById('msd-ch-cmp').clientWidth || 900), cmp, { target: CFG.greenUPH }) : '<div style="color:#9ca3af;font-size:12px;">No data.</div>';
    const md = computeMonthData();
    if (md && md.history.length) {
      const dts = md.history.map(h => h.label);
      document.getElementById('msd-ch-month').innerHTML = groupedBarChart(Math.max(320, document.getElementById('msd-ch-month').clientWidth || 900), dts, [{ name: 'Units', color: '#8575ff', data: md.history.map(h => h.units) }], { height: 240 }) + '<div style="font-size:11px;color:#5e5e5e;text-align:center;">UPH by month: ' + md.history.map(h => h.label + ' ' + Math.round(h.uph)).join('  -  ') + '</div>';
    } else document.getElementById('msd-ch-month').innerHTML = '<div style="color:#9ca3af;font-size:12px;">No month history yet.</div>';
  }

  function exportCSV() {
    const rows = records().slice().sort((a, b) => a.date < b.date ? 1 : -1);
    if (!rows.length) { setStatus('No data to export.'); return; }
    let csv = 'Date,Shift,UPH,Units,Hours\n';
    rows.forEach(d => csv += [d.date, d.shift, d.uph, d.units, d.hours].join(',') + '\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'IMO1_Mansort_Cohort_' + todayStr() + '.csv';
    a.click();
  }

  // ===== SETTINGS =====
  function openSettings() {
    const p = document.getElementById('msd-settings-panel');
    p.style.display = 'flex';
    const row = (label, id, val, type) => '<label style="font-size:12px;display:block;margin:8px 0 4px;">' + label + '</label><input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val) + '" style="width:100%;padding:7px;box-sizing:border-box;">';
    p.innerHTML =
      '<div style="background:#fff;border-radius:12px;padding:20px;max-width:460px;width:92%;max-height:88vh;overflow:auto;"><h2 style="margin:0 0 12px;font-size:16px;">Dashboard Settings</h2>' +
      row('Warehouse', 'msd-s-wh', CFG.wh) + row('Green UPH (>=)', 'msd-s-green', CFG.greenUPH, 'number') + row('Yellow UPH (>=)', 'msd-s-yellow', CFG.yellowUPH, 'number') + row('Full-reload range (days)', 'msd-s-range', CFG.rangeDays, 'number') + row('Auto-refresh (minutes)', 'msd-s-auto', CFG.autoRefreshMin, 'number') +
      '<h3 style="margin:16px 0 8px;font-size:13px;">Wednesday crossover ownership</h3>' + row('Anchor Wednesday (YYYY-MM-DD)', 'msd-s-wanchor', CFG.wedAnchor) +
      '<label style="font-size:12px;display:block;margin:8px 0 4px;">Anchor owner</label><select id="msd-s-wowner" style="width:100%;padding:7px;"><option' + (CFG.wedAnchorOwner === 'BH' ? ' selected' : '') + '>BH</option><option' + (CFG.wedAnchorOwner === 'FH' ? ' selected' : '') + '>FH</option></select>' +
      '<label style="font-size:12px;display:block;margin:8px 0 4px;">Overrides (JSON)</label><textarea id="msd-s-woverrides" style="width:100%;height:60px;font-family:monospace;font-size:11px;">' + esc(JSON.stringify(CFG.wedOverrides)) + '</textarea>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;"><button id="msd-s-cancel">Cancel</button><button id="msd-s-save" style="background:#4200db;color:#fff;border-color:#4200db;">Save</button></div></div>';
    p.querySelector('#msd-s-cancel').addEventListener('click', () => p.style.display = 'none');
    p.querySelector('#msd-s-save').addEventListener('click', saveSettings);
  }

  function saveSettings() {
    CFG.wh = document.getElementById('msd-s-wh').value.toUpperCase() || 'IMO1';
    CFG.greenUPH = parseInt(document.getElementById('msd-s-green').value, 10) || 250;
    CFG.yellowUPH = parseInt(document.getElementById('msd-s-yellow').value, 10) || 200;
    CFG.rangeDays = parseInt(document.getElementById('msd-s-range').value, 10) || 35;
    CFG.autoRefreshMin = parseInt(document.getElementById('msd-s-auto').value, 10) || 5;
    CFG.wedAnchor = document.getElementById('msd-s-wanchor').value || CFG.wedAnchor;
    CFG.wedAnchorOwner = document.getElementById('msd-s-wowner').value;
    CFG.wedOverrides = safeParse(document.getElementById('msd-s-woverrides').value, CFG.wedOverrides);
    GM_setValue('msd_wh', CFG.wh); GM_setValue('msd_green', CFG.greenUPH); GM_setValue('msd_yellow', CFG.yellowUPH);
    GM_setValue('msd_rangeDays', CFG.rangeDays); GM_setValue('msd_autoMin', CFG.autoRefreshMin);
    GM_setValue('msd_wedAnchor', CFG.wedAnchor); GM_setValue('msd_wedOwner', CFG.wedAnchorOwner);
    GM_setValue('msd_wedOverrides', JSON.stringify(CFG.wedOverrides));
    document.getElementById('msd-settings-panel').style.display = 'none';
    document.getElementById('msd-reload').textContent = 'Full Reload (' + CFG.rangeDays + 'd)';
    startAuto(); refreshAll();
  }

  // ===== AUTO-REFRESH + INIT =====
  let autoTimer = null;
  function startAuto() { if (autoTimer) clearInterval(autoTimer); autoTimer = setInterval(() => { if (overlay && overlay.style.display !== 'none') fetchRange(2); }, Math.max(1, CFG.autoRefreshMin) * REFRESH_MS); }

  function init() { if (document.getElementById('msd-launch')) return; buildLauncher(); buildOverlay(); startAuto(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  if (typeof module !== 'undefined') module.exports = { windowsForDate, wednesdayOwner, getFilteredData, lineChart, groupedBarChart, comparisonChart, computeMonthData, getLatestByShift, getTrailing7ByShift, weekRange, cohortSummaryInRange, _setStore: s => { store = s; }, _setView: (v, f, t) => { currentView = v; customFrom = f; customTo = t; }, CFG };
})();
