// ═══════════════════════════════════════════════════════════════
// MODULE: Operations Dashboard
// A read-only cross-module summary — pulls from OpsTasks (Daily
// Operations), HSChecklistLog/Items/Results (Plant Rounds &
// Compliance, DG Set Operations), and HSInOutLog (Sewage/Garbage/
// Water Tanker/Garden Waste). No writes happen anywhere in this
// module.
//
// Everything on this screen is scoped by the Day / Week / Month
// dropdown at the top EXCEPT the Daily Operations "Open" tiles and
// "By Assignee" — see the note below. Definitions used throughout:
//   - "New Tickets" = CreatedDate falls inside the selected range
//     (same shape as the rest of the app's weekly/monthly reports).
//   - "Open — Daily Operations" / "Open — Failed Tasks (Plant Rounds)"
//     / "By Assignee" = every matching ticket that is open RIGHT NOW,
//     regardless of when it was created — the Day/Week/Month dropdown
//     does NOT filter these (confirmed with the user: "open" means
//     "all open till now", a standing backlog, not a per-period count).
//     This matches Daily Operations' own always-current Open Tickets /
//     By Assignee views.
//   - Everything else DOES move with the dropdown: "New Tickets"
//     above, "Total Failed Tasks" / "Total Tasks Not Performed" below
//     (CreatedDate within the selected range — also confirmed with the
//     user, since these sit alongside the already period-windowed DG
//     Set Operations and In/Out Log tiles in the same section and
//     should move together with them, not stay pinned like the Daily
//     Ops open-ticket counts do), and the DG Set Operations / In-Out
//     Log figures themselves (genuinely period-windowed activity, not
//     a standing backlog).
//   - A Plant-Rounds-originated OpsTask is identified the same way
//     module-hs.js's own Failed Items Log / Task Resolution reports
//     already do: Title starts with "Plant Rounds: " (every
//     auto-createOpsTask call in module-hs.js uses that prefix).
//     Within that set, "not performed" tasks are the ones whose
//     title contains "not performed —" (from evaluateMissedRounds,
//     Security's missed-round check); everything else (failed item,
//     outlier recheck, asset-not-working) counts as "Total Failed
//     Tasks". IMPORTANT CAVEAT: "not performed" auto-flagging only
//     exists today for Security's RoundBased rounds — there's no
//     equivalent auto-check yet for a missed Daily/Weekly/Monthly
//     checklist on other categories (DG Set, Housekeeping, etc.), so
//     this number under-counts if those are meant to be included too.
//   - DG Set Operations math (Run Hours / kWh / Diesel Consumed /
//     Diesel Top Up / Fuel Efficiency) mirrors module-hs.js's
//     loadDgOperationsData() exactly (same legacy Fuel Level
//     fallback, same Remarks-vs-Result numeric extraction, same
//     never-negative clamp) — kept in sync manually since modules
//     don't share internals with each other. If that calculation
//     changes in module-hs.js, mirror the change here too. Fuel
//     Efficiency here is a single period-total ratio (total litres ÷
//     total kWh), simpler than the detailed report's per-day-average
//     approach, since this is a compact summary tile.
//   - DRILL-DOWN: every stat tile except Fuel Efficiency (a pure ratio,
//     nothing to list) and the DG tiles individually (they all open the
//     same combined per-date/shift table) is clickable, as is each By
//     Assignee row. Clicking swaps the whole screen to a list view with
//     a "← Back to Dashboard" button, built entirely from `lastLoaded`
//     — the same snapshot the tile counts were computed from — so the
//     list always matches what the tile showed, with no extra sheet
//     reads. In/Out Log isn't a tile and already shows its full
//     IN/OUT list inline, so it has no separate drill-down.
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('dashboard', {
  label: 'Operations Dashboard',
  icon: '📊',
  roles: ['ALL'], // TESTING: opened to all roles temporarily — revert once roles are finalized, same as the other modules
  init: function (container) {
    DashboardModule.mount(container);
  }
});

const DashboardModule = (function () {
  const IN_OUT_TAB = 'HSInOutLog'; // literal sheet name — not in MVOA.TABS, matches module-hs.js's own TAB_HS_INOUT_LOG
  const IN_OUT_LOG_COLS = ['LogID', 'Type', 'Direction', 'Timestamp', 'PhotoURL', 'LoggedBy'];
  const IN_OUT_TYPES = ['Sewage Disposal', 'Garbage Disposal', 'Water Tanker', 'Garden Waste Disposal'];

  // Column orders below must match the live sheet exactly — copied
  // from module-hs.js's own column lists (HSChecklistItems /
  // HSChecklistLog / HSChecklistItemResults) and shared.js's
  // OPS_TASK_COLS (module-ops.js's COLS is the same list again).
  // Duplicated here rather than imported since modules don't expose
  // their internals to each other — if any of these sheets' columns
  // change, this file needs updating too.
  const ITEM_COLS = ['ItemID', 'TemplateID', 'SeqNo', 'CheckItem', 'Requirement', 'InputType', 'ShiftApplicability', 'Active', 'Unit', 'FailThreshold', 'FailDirection', 'Required', 'AssetPrefix', 'TypicalValue', 'DayApplicability'];
  const LOG_COLS = ['LogID', 'TemplateID', 'PerformedBy', 'Timestamp', 'Shift', 'Status', 'Notes', 'AssetID', 'AssetName'];
  const RESULT_COLS = ['ResultID', 'LogID', 'ItemID', 'Result', 'Remarks'];
  const OPS_TASK_COLS = ['TaskID', 'Title', 'Description', 'Priority', 'AssetID', 'AssetName',
    'CreatedBy', 'CreatedDate', 'PhotoURL_Initial', 'Status', 'ComplianceComment',
    'PhotoURL_Compliance', 'ClosedDate', 'ClosedBy', 'CategoryID', 'AssignedTo',
    'AttachmentURL_2', 'AttachmentURL_3',
    'ComplianceAttachmentURL_2', 'ComplianceAttachmentURL_3',
    'NoteCount', 'LastNoteAt', 'LastNoteAuthor', 'CreatorLastSeenNotesAt', 'AssigneeLastSeenNotesAt',
    'AssigneeSeenAt', 'DelegatedTo'];

  let currentPeriod = 'day'; // 'day' | 'week' | 'month'

  // Snapshot of the last successful load, kept so a tile click can
  // drill into the underlying list without re-fetching from the
  // sheet — refreshed every time loadAndRender() completes.
  let lastLoaded = null;

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatDateShort(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const DG_SHIFT_LABEL = { '1st': '1st Shift', '2nd': '2nd Shift', '3rd': '3rd Shift' };

  function rowsToObjs(rows, cols) {
    return rows.slice(1).map((r, i) => {
      const o = { rowNumber: i + 2 };
      cols.forEach((c, ci) => o[c] = r[ci] !== undefined ? r[ci] : '');
      return o;
    }).filter(o => o[cols[0]]);
  }

  function mondayOfWeek(d) {
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? 6 : day - 1;
    const m = new Date(d);
    m.setDate(m.getDate() - diff);
    m.setHours(0, 0, 0, 0);
    return m;
  }

  function periodRange(period, now) {
    now = now || new Date();
    if (period === 'week') {
      const start = mondayOfWeek(now);
      const end = new Date(start.getTime() + 7 * 86400000);
      return { start, end, label: `Week of ${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` };
    }
    if (period === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { start, end, label: start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) };
    }
    // day (default)
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86400000);
    return { start, end, label: start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) };
  }

  function inRange(iso, range) {
    const t = new Date(iso).getTime();
    return !isNaN(t) && t >= range.start.getTime() && t < range.end.getTime();
  }

  function daysOpen(createdDate) {
    const t = new Date(createdDate).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }

  // ───────────────────────────────────────────────────────────
  // DAILY OPERATIONS (OpsTasks)
  // ───────────────────────────────────────────────────────────
  function isPlantRoundsTask(t) { return /^Plant Rounds:\s/.test(t.Title || ''); }
  function isNotPerformedTask(t) { return isPlantRoundsTask(t) && / not performed —/.test(t.Title || ''); }

  async function loadOpsTasks() {
    const rows = await MVOA.sheetsRead(MVOA.TABS.opsTasks);
    return rowsToObjs(rows, OPS_TASK_COLS);
  }

  function computeDailyOpsStats(tasks, range, assigneeOptions) {
    const createdInPeriod = tasks.filter(t => inRange(t.CreatedDate, range));
    // "Open" counts are NOT period-scoped — they reflect every ticket
    // that is open right now, regardless of when it was created. Only
    // "New Tickets" (above) is scoped to the selected Day/Week/Month
    // window. This now matches Daily Operations' own always-current
    // Open Tickets view number-for-number.
    const openTasks = tasks.filter(t => t.Status === 'Open');
    const openDailyOps = openTasks.filter(t => !isPlantRoundsTask(t));
    const openFailedTasks = openTasks.filter(isPlantRoundsTask);

    // By Assignee — top 3 by open-count, ALSO not period-scoped, for
    // the same reason as above (an assignee's workload is who has open
    // tickets right now, not just ones opened within the window).
    const byAssignee = {};
    openTasks.forEach(t => {
      const key = t.AssignedTo || '';
      if (!byAssignee[key]) byAssignee[key] = [];
      byAssignee[key].push(t);
    });
    const assigneeRows = Object.keys(byAssignee).map(key => {
      const list = byAssignee[key];
      const avgDays = Math.round(list.reduce((sum, t) => sum + daysOpen(t.CreatedDate), 0) / list.length * 10) / 10;
      return {
        key, // raw AssignedTo value ('' = Unassigned) — used to drill down on click
        label: key ? MVOA.assigneeLabel(key, assigneeOptions) : 'Unassigned',
        count: list.length,
        avgDays
      };
    }).sort((a, b) => b.count - a.count).slice(0, 3);

    return {
      newTickets: createdInPeriod.length,
      openDailyOps: openDailyOps.length,
      openFailedTasks: openFailedTasks.length,
      assigneeRows
    };
  }

  function computePlantRoundsTaskStats(tasks, range) {
    // UNLIKE the Daily Ops "Open" tiles above, this IS period-scoped —
    // it counts failures/not-performed events that occurred within the
    // selected Day/Week/Month window (by CreatedDate), matching the DG
    // Set Operations and In/Out Log tiles in this same section, which
    // are also period-windowed. Confirmed with the user: these numbers
    // should move with the dropdown, not stay pinned to "currently
    // open" the way the Daily Ops open-ticket counts do.
    const inPeriod = tasks.filter(t => isPlantRoundsTask(t) && inRange(t.CreatedDate, range));
    const notPerformed = inPeriod.filter(isNotPerformedTask).length;
    return { totalFailedTasks: inPeriod.length - notPerformed, notPerformed };
  }

  // ───────────────────────────────────────────────────────────
  // DG SET OPERATIONS — see the file-header note; this mirrors
  // module-hs.js's loadDgOperationsData() but reduces to period
  // totals instead of a per-day×shift matrix.
  // ───────────────────────────────────────────────────────────
  function extractNumericResult(row) {
    const direct = parseFloat(row.Result);
    if (!isNaN(direct)) return direct;
    const m = (row.Remarks || '').match(/(?:entered|recorded):\s*(-?\d+(?:\.\d+)?)/i);
    return m ? parseFloat(m[1]) : NaN;
  }

  async function loadDgPeriodMetrics(range) {
    const [itemRows, logRows, resultRows] = await Promise.all([
      MVOA.sheetsRead(MVOA.TABS.hsItems),
      MVOA.sheetsRead(MVOA.TABS.hsLog),
      MVOA.sheetsRead(MVOA.TABS.hsItemResults)
    ]);
    const items = rowsToObjs(itemRows, ITEM_COLS).filter(i => i.Active === 'TRUE' || i.Active === 'true' || i.Active === true || i.Active === '1');
    const logs = rowsToObjs(logRows, LOG_COLS);
    const results = rowsToObjs(resultRows, RESULT_COLS);

    const hoursItem = items.find(i => /running hours/i.test(i.CheckItem));
    const kwhItem = items.find(i => /cumulated kwh/i.test(i.CheckItem));
    const beforeItem = items.find(i => /diesel level before top up/i.test(i.CheckItem));
    const afterItem = items.find(i => /diesel level after top up/i.test(i.CheckItem));
    const legacyLevelItem = items.find(i => /^fuel level$/i.test((i.CheckItem || '').trim()));
    const relevantIds = [hoursItem, kwhItem, beforeItem, afterItem, legacyLevelItem].filter(Boolean).map(i => i.ItemID);

    const byDateShift = {};
    results.forEach(r => {
      if (!relevantIds.includes(r.ItemID)) return;
      const log = logs.find(l => l.LogID === r.LogID);
      if (!log || !log.Shift) return;
      const dateKey = new Date(log.Timestamp).toDateString();
      const key = dateKey + '|' + log.Shift;
      if (!byDateShift[key]) byDateShift[key] = { shift: log.Shift, timestamp: log.Timestamp };
      const entry = byDateShift[key];
      if (log.Timestamp < entry.timestamp) entry.timestamp = log.Timestamp;
      const val = extractNumericResult(r);
      if (isNaN(val)) return;
      if (hoursItem && r.ItemID === hoursItem.ItemID) { entry.hours = val; entry.hasModernRound = true; }
      if (kwhItem && r.ItemID === kwhItem.ItemID) { entry.kwh = val; entry.hasModernRound = true; }
      if (beforeItem && r.ItemID === beforeItem.ItemID) { entry.dieselBefore = val; entry.hasModernRound = true; }
      if (afterItem && r.ItemID === afterItem.ItemID) { entry.dieselAfter = val; entry.hasModernRound = true; }
      if (legacyLevelItem && r.ItemID === legacyLevelItem.ItemID) entry.legacyLevel = val;
    });
    const rows = Object.values(byDateShift).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    // Legacy "Fuel Level" fallback is for genuinely OLD shifts that
    // predate the Before/After Top-Up split — i.e. a date+shift with NO
    // modern DG Set Operations round data at all. Once a shift has any
    // modern-round reading on it (Running Hours / Cumulated kWh /
    // Before / After), its diesel-before value must come from the real
    // Before Top Up item or stay unknown — never get silently borrowed
    // from an unrelated legacy item, which could otherwise turn a
    // genuinely-missing reading into a misleading (and sometimes
    // coincidentally zero) computed value instead of showing "—".
    rows.forEach(r => { if (r.dieselBefore == null && r.legacyLevel != null && !r.hasModernRound) r.dieselBefore = r.legacyLevel; });

    const TANK_CAPACITY = 200; // litres, per DG_Set.docx
    const pctToLitres = (pct) => (pct / 100) * TANK_CAPACITY;
    const round2 = (n) => Math.round(n * 100) / 100;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], next = rows[i + 1];
      r.hoursRun = (next && r.hours != null && next.hours != null) ? round2(next.hours - r.hours) : null;
      r.kwhGenerated = (next && r.kwh != null && next.kwh != null) ? round2(next.kwh - r.kwh) : null;
      r.dieselTopUpLitres = (r.dieselBefore != null && r.dieselAfter != null) ? round2(pctToLitres(r.dieselAfter - r.dieselBefore)) : null;
      if (r.dieselAfter != null) {
        r.dieselConsumedLitres = (next && next.dieselBefore != null) ? round2(pctToLitres(r.dieselAfter - next.dieselBefore)) : null;
      } else if (next && r.dieselBefore != null && next.dieselBefore != null) {
        r.dieselConsumedLitres = round2(pctToLitres(r.dieselBefore - next.dieselBefore));
      } else {
        r.dieselConsumedLitres = null;
      }
      if (typeof r.dieselConsumedLitres === 'number' && r.dieselConsumedLitres < 0) r.dieselConsumedLitres = null;
      if (typeof r.dieselTopUpLitres === 'number' && r.dieselTopUpLitres < 0) r.dieselTopUpLitres = null;
    }

    // A transition "belongs" to the period its STARTING shift falls
    // in — the "next" reading can land just after the period boundary
    // and that's still correctly this period's interval.
    const inPeriodRows = rows.filter(r => inRange(r.timestamp, range));
    const sum = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100 : null;
    const totalHours = sum(inPeriodRows.map(r => r.hoursRun).filter(v => typeof v === 'number'));
    const totalKwh = sum(inPeriodRows.map(r => r.kwhGenerated).filter(v => typeof v === 'number'));
    const totalDiesel = sum(inPeriodRows.map(r => r.dieselConsumedLitres).filter(v => typeof v === 'number'));
    const totalTopUp = sum(inPeriodRows.map(r => r.dieselTopUpLitres).filter(v => typeof v === 'number'));
    const fuelEfficiency = (typeof totalDiesel === 'number' && totalKwh) ? Math.round((totalDiesel / totalKwh) * 1000) / 1000 : null;
    return { totalHours, totalKwh, totalDiesel, totalTopUp, fuelEfficiency, rows: inPeriodRows };
  }

  // ───────────────────────────────────────────────────────────
  // IN/OUT LOG — Sewage/Garbage/Water Tanker/Garden Waste. Grouped
  // by category; a category with nothing logged this period is left
  // out entirely (per the app's convention elsewhere of not showing
  // a category that has no activity to report).
  // ───────────────────────────────────────────────────────────
  async function loadInOutForPeriod(range) {
    const rows = await MVOA.sheetsRead(IN_OUT_TAB);
    const logs = rowsToObjs(rows, IN_OUT_LOG_COLS).filter(l => inRange(l.Timestamp, range));
    return IN_OUT_TYPES.map(type => ({
      type,
      entries: logs.filter(l => l.Type === type).sort((a, b) => (a.Timestamp || '').localeCompare(b.Timestamp || ''))
    })).filter(g => g.entries.length);
  }

  // ───────────────────────────────────────────────────────────
  // RENDER
  // ───────────────────────────────────────────────────────────
  // `key` (optional) makes the tile clickable — it's read back by the
  // click handler wired in loadAndRender() to decide which drill-down
  // list to show. A tile with no key (e.g. Fuel Efficiency, a pure
  // ratio with no underlying list of its own) just isn't clickable.
  function statTile(value, label, color, key) {
    const clickableAttrs = key ? ` data-dash-tile="${key}" tabindex="0" role="button"` : '';
    const clickableStyle = key ? 'cursor:pointer;' : '';
    return `
      <div class="dash-tile" style="flex:1;min-width:110px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);text-align:center;${clickableStyle}"${clickableAttrs}>
        <div style="font-size:1.6rem;font-weight:700;${color ? `color:${color};` : ''}">${value === null || value === undefined ? '—' : escapeHtml(String(value))}</div>
        <div class="muted" style="font-size:0.75rem;margin-top:2px;">${escapeHtml(label)}${key ? ' ›' : ''}</div>
      </div>
    `;
  }

  async function mount(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:6px;">
        <h2 style="margin:0;color:var(--mvoa-blue);">📊 Dashboard for Operations</h2>
        <div>
          <label class="muted" style="margin:0;">Showing:
            <select id="dash-period">
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
        </div>
      </div>
      <p class="muted" id="dash-period-label" style="margin:0 0 16px;"></p>
      <div id="dash-body"><p class="muted">Loading…</p></div>
    `;
    const select = container.querySelector('#dash-period');
    select.value = currentPeriod;
    select.addEventListener('change', () => {
      currentPeriod = select.value;
      loadAndRender(container);
    });
    loadAndRender(container);
  }

  async function loadAndRender(container) {
    const bodyEl = container.querySelector('#dash-body');
    const labelEl = container.querySelector('#dash-period-label');
    bodyEl.innerHTML = '<p class="muted">Loading…</p>';
    const range = periodRange(currentPeriod);
    labelEl.textContent = range.label;

    let tasks, assigneeOptions, dg, inOut;
    try {
      [tasks, assigneeOptions, dg, inOut] = await Promise.all([
        loadOpsTasks(),
        MVOA.loadAssigneeOptions(),
        loadDgPeriodMetrics(range),
        loadInOutForPeriod(range)
      ]);
    } catch (e) {
      bodyEl.innerHTML = `<p class="error-text">Could not load dashboard: ${escapeHtml(e.message)}</p>`;
      return;
    }

    const opsStats = computeDailyOpsStats(tasks, range, assigneeOptions);
    const prTaskStats = computePlantRoundsTaskStats(tasks, range);

    // Stashed so tile/row click handlers (wired below) can build each
    // drill-down list without re-fetching anything.
    lastLoaded = { tasks, range, assigneeOptions, dgRows: dg.rows || [] };

    bodyEl.innerHTML = `
      <div class="card" style="max-width:900px;margin:0 0 18px 0;">
        <h3 style="margin:0 0 12px;color:var(--mvoa-blue);">Daily Operations</h3>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
          ${statTile(opsStats.newTickets, 'New Tickets', null, 'newTickets')}
          ${statTile(opsStats.openDailyOps, 'Open — Daily Operations', null, 'openDailyOps')}
          ${statTile(opsStats.openFailedTasks, 'Open — Failed Tasks (Plant Rounds)', opsStats.openFailedTasks ? '#b3261e' : null, 'openFailedTasks')}
        </div>
        <p style="margin:0 0 6px;font-weight:600;">By Assignee (top 3, open this period)</p>
        ${opsStats.assigneeRows.length ? `
          <div style="overflow-x:auto;max-width:520px;">
            <table class="mvoa-table" style="width:100%;table-layout:fixed;">
              <colgroup><col style="width:52%;"><col style="width:18%;"><col style="width:30%;"></colgroup>
              <thead><tr><th>Assignee</th><th>Open</th><th style="white-space:normal;">Avg Days Open</th></tr></thead>
              <tbody>
                ${opsStats.assigneeRows.map(r => `<tr class="dash-assignee-row" data-assignee-key="${escapeHtml(r.key)}" data-assignee-label="${escapeHtml(r.label)}" style="cursor:pointer;"><td style="white-space:normal;overflow-wrap:break-word;">${escapeHtml(r.label)} ›</td><td>${r.count}</td><td>${r.avgDays}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : '<p class="muted">No open tickets this period.</p>'}
      </div>

      <div class="card" style="max-width:900px;margin:0;">
        <h3 style="margin:0 0 12px;color:var(--mvoa-blue);">Plant Rounds &amp; Compliance</h3>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
          ${statTile(prTaskStats.totalFailedTasks, 'Total Failed Tasks', prTaskStats.totalFailedTasks ? '#b3261e' : null, 'totalFailedTasks')}
          ${statTile(prTaskStats.notPerformed, 'Total Tasks Not Performed', prTaskStats.notPerformed ? '#b3261e' : null, 'totalNotPerformed')}
        </div>

        <p style="margin:0 0 6px;font-weight:600;">DG Set Operations</p>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
          ${statTile(dg.totalHours ?? '—', 'Run Hours', null, 'dgDetail')}
          ${statTile(dg.totalKwh ?? '—', 'Units Generated (kWh)', null, 'dgDetail')}
          ${statTile(dg.totalDiesel ?? '—', 'Diesel Consumed (L)', null, 'dgDetail')}
          ${statTile(dg.totalTopUp ?? '—', 'Diesel Top Up (L)', null, 'dgDetail')}
          ${statTile(dg.fuelEfficiency ?? '—', 'Fuel Efficiency (L/kWh)', null, 'dgDetail')}
        </div>

        <p style="margin:0 0 6px;font-weight:600;">In/Out Log</p>
        ${inOut.length ? inOut.map(g => `
          <div style="margin-bottom:10px;">
            <span style="font-weight:600;">${escapeHtml(g.type)}</span>
            <div class="muted" style="font-size:0.8rem;margin-top:2px;">
              ${g.entries.map(e => `${e.Direction === 'IN' ? '🟢 IN' : '🔴 OUT'} ${new Date(e.Timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${currentPeriod !== 'day' ? ' (' + new Date(e.Timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ')' : ''}`).join(' &nbsp;·&nbsp; ')}
            </div>
          </div>
        `).join('') : '<p class="muted">No Sewage/Garbage/Water Tanker/Garden Waste activity logged this period.</p>'}
      </div>
    `;

    // Wire drill-down clicks — each stat tile with a data-dash-tile key,
    // plus each By Assignee row.
    bodyEl.querySelectorAll('[data-dash-tile]').forEach(el => {
      el.addEventListener('click', () => showDetail(container, el.dataset.dashTile));
    });
    bodyEl.querySelectorAll('.dash-assignee-row').forEach(el => {
      el.addEventListener('click', () => showAssigneeDetail(container, el.dataset.assigneeKey, el.dataset.assigneeLabel));
    });
  }

  // ───────────────────────────────────────────────────────────
  // DRILL-DOWN — clicking a stat tile or By Assignee row swaps the
  // WHOLE module container over to a full-screen list (same "replace
  // container, wire a back button" pattern module-hs.js uses for its
  // own sub-screens), rather than expanding in place. "← Back to
  // Dashboard" re-mounts the summary from scratch, which also picks up
  // any data that changed while the list was open. Everything drawn
  // here reads from `lastLoaded` — the exact snapshot the summary tile
  // was computed from, so counts and list contents always agree.
  // ───────────────────────────────────────────────────────────
  function detailShell(container, title, bodyHtml) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="dash-detail-back" class="btn-secondary">← Back to Dashboard</button>
        <strong>${escapeHtml(title)}</strong>
      </div>
      ${bodyHtml}
    `;
    container.querySelector('#dash-detail-back').addEventListener('click', () => mount(container));
  }

  function taskListHtml(list, assigneeOptions) {
    if (!list.length) return '<p class="muted">Nothing here.</p>';
    const sorted = list.slice().sort((a, b) => (b.CreatedDate || '').localeCompare(a.CreatedDate || ''));
    return `
      <div class="card" style="max-width:700px;margin:0;">
        ${sorted.map(t => `
          <div class="mvoa-list-item" style="padding:8px 0;border-bottom:1px solid var(--border);">
            <div class="mvoa-row">
              <span style="font-weight:600;">${escapeHtml(t.Title || '(untitled)')}</span>
              <span class="muted" style="font-size:0.8rem;">${escapeHtml(t.Status || '')}</span>
            </div>
            <p class="muted" style="margin:2px 0;font-size:0.8rem;">
              ${escapeHtml(t.AssignedTo ? MVOA.assigneeLabel(t.AssignedTo, assigneeOptions) : 'Unassigned')} · Created ${escapeHtml(formatDateShort(t.CreatedDate))}${t.Priority ? ' · ' + escapeHtml(t.Priority) : ''}${t.AssetName ? ' · ' + escapeHtml(t.AssetName) : ''}
            </p>
          </div>
        `).join('')}
      </div>
    `;
  }

  function dgDetailHtml(rows) {
    if (!rows.length) return '<p class="muted">No DG Set Operations readings in this period.</p>';
    const sorted = rows.slice().sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    return `
      <div class="card" style="max-width:700px;margin:0;overflow-x:auto;">
        <table class="mvoa-table">
          <thead><tr><th>Date</th><th>Shift</th><th>Run Hours</th><th>kWh</th><th>Diesel Consumed (L)</th><th>Diesel Top Up (L)</th></tr></thead>
          <tbody>
            ${sorted.map(r => `
              <tr>
                <td>${escapeHtml(formatDateShort(r.timestamp))}</td>
                <td>${escapeHtml(DG_SHIFT_LABEL[r.shift] || r.shift || '')}</td>
                <td>${r.hoursRun ?? '—'}</td>
                <td>${r.kwhGenerated ?? '—'}</td>
                <td>${r.dieselConsumedLitres ?? '—'}</td>
                <td>${r.dieselTopUpLitres ?? '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function showDetail(container, key) {
    if (!lastLoaded) return;
    const { tasks, range, assigneeOptions, dgRows } = lastLoaded;
    const openTasks = tasks.filter(t => t.Status === 'Open');

    if (key === 'newTickets') {
      const list = tasks.filter(t => inRange(t.CreatedDate, range));
      detailShell(container, `New Tickets — ${range.label}`, taskListHtml(list, assigneeOptions));
      return;
    }
    if (key === 'openDailyOps') {
      const list = openTasks.filter(t => !isPlantRoundsTask(t));
      detailShell(container, 'Open — Daily Operations', taskListHtml(list, assigneeOptions));
      return;
    }
    if (key === 'openFailedTasks') {
      const list = openTasks.filter(isPlantRoundsTask);
      detailShell(container, 'Open — Failed Tasks (Plant Rounds)', taskListHtml(list, assigneeOptions));
      return;
    }
    if (key === 'totalFailedTasks') {
      const list = tasks.filter(t => isPlantRoundsTask(t) && inRange(t.CreatedDate, range) && !isNotPerformedTask(t));
      detailShell(container, `Total Failed Tasks — ${range.label}`, taskListHtml(list, assigneeOptions));
      return;
    }
    if (key === 'totalNotPerformed') {
      const list = tasks.filter(t => inRange(t.CreatedDate, range) && isNotPerformedTask(t));
      detailShell(container, `Total Tasks Not Performed — ${range.label}`, taskListHtml(list, assigneeOptions));
      return;
    }
    if (key === 'dgDetail') {
      detailShell(container, `DG Set Operations — ${range.label}`, dgDetailHtml(dgRows));
      return;
    }
  }

  function showAssigneeDetail(container, rawKey, label) {
    if (!lastLoaded) return;
    const { tasks, assigneeOptions } = lastLoaded;
    const list = tasks.filter(t => t.Status === 'Open' && (t.AssignedTo || '') === rawKey);
    detailShell(container, `Open Tickets — ${label}`, taskListHtml(list, assigneeOptions));
  }

  return { mount };
})();
