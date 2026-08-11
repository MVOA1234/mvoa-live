// ═══════════════════════════════════════════════════════════════
// MODULE: Plant Rounds & Compliance
// Columns:
//   HSCategories: CategoryKey | Label | QRMatchKeyword | FailTaskCategory | Icon | Active
//     CategoryKey is the internal key used as HSChecklistTemplates.QRTarget
//     (kept that column name for backward compat even though it's now a
//     general category key, not just "which QR target"). QRMatchKeyword
//     is matched case-insensitively against the scanned asset's
//     Category/AssetName/AssetID to figure out which category a scan
//     belongs to. FailTaskCategory is which Daily Ops category an
//     auto-flagged Fail task should land in.
//   HSChecklistTemplates: TemplateID | Name | QRTarget | Frequency | Active
//     QRTarget: a CategoryKey from HSCategories. Frequency: 'Daily'|'Weekly'|'Monthly'|'BiMonthly'
//   HSChecklistItems: ItemID | TemplateID | SeqNo | CheckItem | Requirement |
//     InputType | ShiftApplicability | Active | Unit | FailThreshold | FailDirection
//     InputType: 'PassFail' | 'Text' | 'Dropdown' | 'Numeric'
//     ShiftApplicability (Daily only): '1st' | '2nd' | '3rd' | 'Both' (legacy '2nd3rd' still read)
//     Numeric: if FailThreshold is set, auto-evaluates Pass/Fail against
//     it (FailDirection 'above'/'below'); if blank, just records the
//     value with no pass/fail meaning (e.g. a running-hours meter).
//   HSChecklistItemOptions: ItemID | OptionValue | OptionOrder   (Dropdown items only)
//   HSChecklistLog: LogID | TemplateID | PerformedBy | Timestamp | Shift | Status | Notes
//     Status: 'Submitted' | 'Flagged'
//   HSChecklistItemResults: ResultID | LogID | ItemID | Result | Remarks
//
// QR SCANNING: reuses the same MVOA.parseAssetQR() format/scanner as
// Daily Ops asset scanning. Which category a scan belongs to is looked
// up from HSCategories' QRMatchKeyword — adding a new category is a
// pure data change (a new HSCategories row + templates/items), no code
// change needed.
//
// AUTO-FLAGGING: a Fail (PassFail, or Numeric crossing its threshold)
// automatically creates a Daily Ops task assigned to Facility Manager,
// in whichever Daily Ops category that HSCategories row specifies.
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('hs', {
  label: 'Plant Rounds & Compliance',
  icon: '🛟',
  roles: ['ALL'], // TESTING: opened to all roles temporarily — revert once roles are finalized
  init: function (container) {
    HSModule.mount(container);
  }
});

const HSModule = (function () {
  const FREQUENCY_ORDER = ['Daily', 'Weekly', 'Monthly', 'BiMonthly'];
  const FREQUENCY_LABEL = { Daily: 'Daily', Weekly: 'Weekly', Monthly: 'Monthly', BiMonthly: 'Bi-Monthly' };

  const CATEGORY_COLS = ['CategoryKey', 'Label', 'QRMatchKeyword', 'FailTaskCategory', 'Icon', 'Active', 'RequiresScan', 'Group', 'LayoutImage'];
  const TEMPLATE_COLS = ['TemplateID', 'Name', 'QRTarget', 'Frequency', 'Active', 'ShiftBased', 'RequireOverallNotes', 'WindowStartDay', 'WindowEndDay', 'ShowZoneOfDay', 'FailTaskCategory', 'RoundBased', 'CustomScreen'];
  const ITEM_COLS = ['ItemID', 'TemplateID', 'SeqNo', 'CheckItem', 'Requirement', 'InputType', 'ShiftApplicability', 'Active', 'Unit', 'FailThreshold', 'FailDirection', 'Required', 'AssetPrefix', 'TypicalValue', 'DayApplicability'];
  const OPTION_COLS = ['ItemID', 'OptionValue', 'OptionOrder'];
  const LOG_COLS = ['LogID', 'TemplateID', 'PerformedBy', 'Timestamp', 'Shift', 'Status', 'Notes', 'AssetID', 'AssetName'];
  const RESULT_COLS = ['ResultID', 'LogID', 'ItemID', 'Result', 'Remarks'];
  const CATEGORY_ASSET_COLS = ['CategoryKey', 'AssetID', 'AssetLabel', 'Active'];
  const ROUND_WINDOW_COLS = ['RoundKey', 'Label', 'StartHour', 'StartMinute', 'EndHour', 'EndMinute', 'Active'];

  let categoriesCache = [];
  let templatesCache = [];
  let itemsCache = [];
  let itemOptionsCache = [];
  let logsCache = [];
  let categoryAssetsCache = []; // per-asset master list — CategoryKey|AssetID|AssetLabel|Active
  let roundWindowsCache = []; // sheet-driven Security round windows — see loadAll's fail-open fallback
                                 // (e.g. all 18 Distribution Panels), so Due Status can show a
                                 // unit that's never been scanned yet, not just ones with a log

  let currentScan = null;    // { assetId, assetName, category, qrTarget }
  let currentTemplate = null;
  let currentShift = '';     // '1st' | '2nd' | '3rd' — Daily only
  let pendingResults = {};   // ItemID -> { result, remarks }
  let pendingPerformedBy = ''; // editable "who's filling this in" — defaults to logged-in user, but
                                // editable since a technician sometimes enters on behalf of the AMC vendor
  let historyFilter = 'all'; // 'all' | a CategoryKey

  function categoryByKey(key) { return categoriesCache.find(c => c.CategoryKey === key); }
  function categoryLabel(key) { const c = categoryByKey(key); return c ? c.Label : key; }
  function failTaskCategoryFor(key) { const c = categoryByKey(key); return c ? c.FailTaskCategory : ''; }
  // Housekeeping needs its two templates to route Fails to two
  // DIFFERENT Daily Ops categories (Zone Rotation → Landscape & Garden;
  // Building Cleaning → Housekeeping) even though both live under the
  // same Plant Rounds "Housekeeping" category — a per-template override
  // on top of the existing per-category default, blank falls back to
  // the category's own FailTaskCategory exactly as before for every
  // template that doesn't set one.
  function effectiveFailTaskCategory(template, qrTarget) {
    return (template && template.FailTaskCategory) || failTaskCategoryFor(qrTarget);
  }
  // Day-of-week gating for items whose real-world schedule is locked to
  // specific weekdays (e.g. "Sweeping Mon/Wed/Fri") — a comma list of
  // 3-letter day names in DayApplicability; blank means every day, same
  // as always. On a non-matching day the item is treated the same way
  // Required=FALSE items already are (shown, optional, never counted as
  // a Fail if left blank) — this is a SOFT gate layered on top of
  // Required, not a replacement for it: a day-gated item can still have
  // Required=TRUE (it genuinely must be done — just only on its days).
  const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function isItemDueToday(item, now) {
    if (!item.DayApplicability || !item.DayApplicability.trim()) return true;
    // 'WeeklyOnce' — no fixed day, just needs to happen once during the
    // week (e.g. Cob Web Removal). Always "due" so it never shows the
    // day-locked items' "not scheduled today" treatment; its own weekly
    // check (evaluateWeeklyItemCompliance) handles Fail/task-creation on
    // Sunday instead, same shape as the In/Out Log's weekly evaluation.
    if (item.DayApplicability === 'WeeklyOnce') return true;
    const today = WEEKDAY_ABBR[(now || new Date()).getDay()];
    return item.DayApplicability.split(',').map(s => s.trim()).includes(today);
  }
  // Which landscape zone is due today, for the Zone Rotation template's
  // banner (ShowZoneOfDay=TRUE) — Mon=Zone1..Fri=Zone5, Sat/Sun=catch-up
  // for whatever zone didn't get finished that week. Purely a display
  // label; the checklist items themselves are the same 7 activities
  // regardless of which zone they're being applied to that day.
  function landscapeZoneForToday(now) {
    const day = (now || new Date()).getDay(); // 0=Sun..6=Sat
    const zoneByDay = { 1: 'Zone 1', 2: 'Zone 2', 3: 'Zone 3', 4: 'Zone 4', 5: 'Zone 5' };
    return zoneByDay[day] || 'Catch-up / Pending Work';
  }

  function rowsToObjs(rows, cols) {
    return rows.slice(1).map((r, i) => {
      const o = { rowNumber: i + 2 };
      cols.forEach((c, ci) => o[c] = r[ci] !== undefined ? r[ci] : '');
      return o;
    }).filter(o => o[cols[0]]);
  }

  async function mount(container) {
    container.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      await loadAll();
    } catch (e) {
      container.innerHTML = `<p class="error-text">Could not load Plant Rounds: ${e.message}</p>`;
      return;
    }
    currentScan = null;
    renderHome(container);
  }

  async function loadAll(force) {
    const [categories, templates, items, options, logs] = await Promise.all([
      MVOA.sheetsRead(MVOA.TABS.hsCategories),
      MVOA.sheetsRead(MVOA.TABS.hsTemplates),
      MVOA.sheetsRead(MVOA.TABS.hsItems),
      MVOA.sheetsRead(MVOA.TABS.hsItemOptions),
      MVOA.sheetsRead(MVOA.TABS.hsLog),
      MVOA.loadPlantRoundsPermissionsMatrix(force)
    ]);
    categoriesCache = rowsToObjs(categories, CATEGORY_COLS).filter(c => c.Active === 'TRUE' || c.Active === 'true' || c.Active === true || c.Active === '1');
    templatesCache = rowsToObjs(templates, TEMPLATE_COLS).filter(t => t.Active === 'TRUE' || t.Active === 'true' || t.Active === true || t.Active === '1');
    itemsCache = rowsToObjs(items, ITEM_COLS).filter(i => i.Active === 'TRUE' || i.Active === 'true' || i.Active === true || i.Active === '1');
    itemOptionsCache = rowsToObjs(options, OPTION_COLS);
    logsCache = rowsToObjs(logs, LOG_COLS);
    // Optional tab — a per-asset master list (e.g. all 18 Distribution
    // Panels) so Due Status can show a unit that's never been scanned
    // yet. Read separately and fail open: until this tab exists, or for
    // an installation that never needs it, Plant Rounds works exactly
    // as before — this only adds pre-registered rows, never required.
    try {
      const categoryAssets = await MVOA.sheetsRead(MVOA.TABS.hsCategoryAssets);
      categoryAssetsCache = rowsToObjs(categoryAssets, CATEGORY_ASSET_COLS).filter(a => a.Active === 'TRUE' || a.Active === 'true' || a.Active === true || a.Active === '1');
    } catch (e) {
      categoryAssetsCache = [];
    }
    // Optional tab — Security's Daily Rounds windows (RoundKey, Label,
    // StartHour, StartMinute, EndHour, EndMinute, Active), sheet-driven
    // so a round can be added, relabeled, retimed, or disabled without
    // a code deploy. Fails open to today's exact Round1/Round2 setup if
    // the tab doesn't exist yet, so nothing changes until it's created.
    try {
      const roundWindows = await MVOA.sheetsRead(MVOA.TABS.hsRoundWindows);
      roundWindowsCache = rowsToObjs(roundWindows, ROUND_WINDOW_COLS).filter(r => r.Active === 'TRUE' || r.Active === 'true' || r.Active === true || r.Active === '1');
    } catch (e) {
      roundWindowsCache = [
        { RoundKey: 'Round1', Label: 'Round 1', StartHour: '2', StartMinute: '0', EndHour: '3', EndMinute: '0' },
        { RoundKey: 'Round2', Label: 'Round 2', StartHour: '16', StartMinute: '0', EndHour: '17', EndMinute: '0' }
      ];
    }
  }

  // ───────────────────────────────────────────────────────────
  // HOME — scan entry point + recent activity
  // ───────────────────────────────────────────────────────────
  function renderHome(container) {
    const user = MVOA.getUser();
    const recent = logsCache.slice().sort((a, b) => (b.Timestamp || '').localeCompare(a.Timestamp || '')).slice(0, 5);
    const visibleCategories = categoriesCache.filter(c => MVOA.canViewPlantRoundsSection(c.CategoryKey, user));
    const ungrouped = visibleCategories.filter(c => !c.Group);
    // Categories can optionally belong to a named Group (e.g. "Monthly
    // Inspections") — each distinct Group gets its own labeled box below
    // the main equipment row, so unrelated categories (a DG Set vs. a
    // Server Room housekeeping check) aren't visually mixed together.
    // Grouping is purely presentational — a data change (fill in the
    // Group column), no code change, same as adding a category at all.
    const groupNames = [...new Set(visibleCategories.filter(c => c.Group).map(c => c.Group))];
    container.innerHTML = `
      <div class="card" style="max-width:520px;margin:0 0 16px 0;">
        <p class="muted" style="margin:0 0 10px;">Choose which equipment/area you're logging.</p>
        <div id="hs-category-tabs" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
      </div>
      ${groupNames.map(g => `
      <div class="card" style="max-width:520px;margin:0 0 16px 0;">
        <p class="muted" style="margin:0 0 10px;font-weight:700;">${escapeHtml(g)}</p>
        <div class="hs-group-tabs" data-group="${escapeHtml(g)}" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
      </div>`).join('')}
      <div style="margin-bottom:16px;display:flex;flex-wrap:wrap;gap:8px;">
        <button id="hs-due-dashboard-btn" class="btn-secondary">📊 Due Status</button>
        <button id="hs-history-btn" class="btn-secondary">📅 Full History</button>
        <button id="hs-reports-btn" class="btn-secondary">📈 More Reports</button>
        <button id="hs-eos-btn" class="btn-secondary">📝 End of Shift Report</button>
        <button id="hs-shiftduty-btn" class="btn-secondary">🗓️ Shift Duty</button>
        <button id="hs-amc-btn" class="btn-secondary">📋 AMC &amp; Compliance</button>
      </div>
      <p class="muted" style="margin:0 0 8px;">Recent activity</p>
      <div id="hs-recent"></div>
    `;
    const tabsEl = container.querySelector('#hs-category-tabs');
    tabsEl.innerHTML = ungrouped.length
      ? ungrouped.map(c => `<button class="btn-secondary hs-category-tab" data-category="${c.CategoryKey}" style="flex:1;min-width:120px;">${c.Icon || ''} ${escapeHtml(c.Label)}</button>`).join('')
      : '<p class="muted">You don\'t have access to any Plant Rounds categories yet.</p>';
    tabsEl.querySelectorAll('.hs-category-tab').forEach(btn => {
      btn.addEventListener('click', () => handleCategoryTabClick(btn.dataset.category, container));
    });
    groupNames.forEach(g => {
      const groupEl = container.querySelector(`.hs-group-tabs[data-group="${escapeHtml(g)}"]`);
      const groupCats = visibleCategories.filter(c => c.Group === g);
      groupEl.innerHTML = groupCats.map(c => `<button class="btn-secondary hs-category-tab" data-category="${c.CategoryKey}" style="flex:1;min-width:120px;">${c.Icon || ''} ${escapeHtml(c.Label)}</button>`).join('');
      groupEl.querySelectorAll('.hs-category-tab').forEach(btn => {
        btn.addEventListener('click', () => handleCategoryTabClick(btn.dataset.category, container));
      });
    });

    const recentEl = container.querySelector('#hs-recent');
    recentEl.innerHTML = recent.length ? recent.map(l => logCardHtml(l)).join('') : '<p class="muted">No checklist rounds logged yet.</p>';
    wireLogCardDrilldowns(recentEl);
    container.querySelector('#hs-history-btn').addEventListener('click', () => renderHistory(container));
    container.querySelector('#hs-due-dashboard-btn').addEventListener('click', () => renderDueDashboard(container));
    container.querySelector('#hs-reports-btn').addEventListener('click', () => renderReportsMenu(container));
    container.querySelector('#hs-eos-btn').addEventListener('click', () => renderEndOfShiftPicker(container));
    container.querySelector('#hs-shiftduty-btn').addEventListener('click', () => renderShiftDuty(container));
    container.querySelector('#hs-amc-btn').addEventListener('click', () => renderAmcCompliance(container));
  }

  // Called when a category tab on Home is tapped. RequiresScan=FALSE
  // categories (e.g. a future "Security" with no physical QR-scannable
  // equipment) skip the scanner entirely and go straight to the
  // checklist list. Everything else opens the scanner already knowing
  // which category was expected, so a mismatch (scanning the wrong
  // equipment for the tab you picked) can be caught and flagged.
  function handleCategoryTabClick(categoryKey, container) {
    const cat = categoryByKey(categoryKey);
    if (!cat) return;
    const requiresScan = !(cat.RequiresScan === 'FALSE' || cat.RequiresScan === 'false');
    if (!requiresScan) {
      currentScan = { assetId: '', assetName: '', category: cat.Label, qrTarget: categoryKey };
      renderScanResult(container);
      return;
    }
    openQrScanner(container, categoryKey);
  }

  // ───────────────────────────────────────────────────────────
  // END OF SHIFT REPORT — a separate, later step from the checklist
  // itself. The checklist is filled at the START of a shift; this
  // lets the technician come back at the END of their shift to note
  // any event, on whichever of TODAY's already-submitted shifts they
  // pick. Only shows shifts that actually have a log today — you
  // can't report on a shift that was never submitted.
  // ───────────────────────────────────────────────────────────
  function renderEndOfShiftPicker(container) {
    const user = MVOA.getUser();
    const dailyTemplates = templatesCache.filter(t => t.Frequency === 'Daily' && (t.ShiftBased === 'TRUE' || t.ShiftBased === 'true') && MVOA.canEditPlantRoundsSection(t.QRTarget, user));
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
        <strong>📝 End of Shift Report</strong>
      </div>
      <p class="muted" style="margin:0 0 12px;">Pick which of today's submitted shifts you're reporting on.</p>
      <div id="hs-eos-list"></div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));

    const listEl = container.querySelector('#hs-eos-list');
    const rows = [];
    dailyTemplates.forEach(t => {
      ['1st', '2nd', '3rd'].forEach(shift => {
        const log = todaysLogFor(t.TemplateID, shift);
        if (log) rows.push({ template: t, shift, log });
      });
    });
    if (!rows.length) {
      listEl.innerHTML = '<p class="muted">No shifts have been submitted yet today.</p>';
      return;
    }
    listEl.innerHTML = rows.map((r, i) => `
      <div class="mvoa-list-item">
        <strong>${escapeHtml(categoryLabel(r.template.QRTarget))} — ${shiftLabel(r.shift)} Shift</strong>
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">Submitted by ${escapeHtml(r.log.PerformedBy)} · ${formatDate(r.log.Timestamp)}</p>
        <textarea class="hs-eos-notes" data-idx="${i}" rows="3" placeholder="Report any event during this shift…" style="width:100%;box-sizing:border-box;">${escapeHtml(r.log.Notes || '')}</textarea>
        <button class="btn-primary hs-eos-save" data-idx="${i}" style="width:100%;margin-top:6px;">Save</button>
        <p class="error-text hs-eos-error" data-idx="${i}" style="min-height:1em;margin-top:4px;"></p>
      </div>
    `).join('');
    listEl.querySelectorAll('.hs-eos-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = btn.dataset.idx;
        const row = rows[idx];
        const textarea = listEl.querySelector(`.hs-eos-notes[data-idx="${idx}"]`);
        const errEl = listEl.querySelector(`.hs-eos-error[data-idx="${idx}"]`);
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
          const updated = Object.assign({}, row.log, { Notes: textarea.value.trim() });
          await MVOA.sheetsUpdateRow(MVOA.TABS.hsLog, row.log.rowNumber, LOG_COLS.map(c => updated[c] !== undefined ? updated[c] : ''));
          row.log.Notes = updated.Notes; // keep local cache in sync
          errEl.textContent = '';
          btn.textContent = '✓ Saved';
          setTimeout(() => { btn.disabled = false; btn.textContent = 'Save'; }, 1500);
        } catch (e) {
          errEl.textContent = 'Could not save: ' + e.message;
          btn.disabled = false;
          btn.textContent = 'Save';
        }
      });
    });
  }

  // ───────────────────────────────────────────────────────────
  // SHIFT DUTY — one shared weekly roster (not per category/equipment).
  // HSShiftDuty columns: Date (YYYY-MM-DD) | Shift | Name.
  // Only today and the remaining days of the CURRENT week are editable
  // — past days in the week are shown locked, since rewriting history
  // isn't the point (readjustment is for upcoming coverage, e.g. leave).
  // ───────────────────────────────────────────────────────────
  const SHIFT_DUTY_COLS = ['Date', 'Shift', 'Name'];
  function mondayOfWeek(d) {
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? 6 : day - 1;
    const m = new Date(d);
    m.setDate(m.getDate() - diff);
    m.setHours(0, 0, 0, 0);
    return m;
  }
  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  async function renderShiftDuty(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
        <strong>🗓️ Shift Duty — This Week</strong>
      </div>
      <div id="hs-shiftduty-body"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));

    const bodyEl = container.querySelector('#hs-shiftduty-body');
    let rows;
    try {
      rows = await MVOA.sheetsRead(MVOA.TABS.hsShiftDuty);
    } catch (e) {
      bodyEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const duty = rowsToObjs(rows, SHIFT_DUTY_COLS); // rowNumber tracked for in-place updates

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monday = mondayOfWeek(today);
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return d; });
    const shifts = ['1st', '2nd', '3rd'];
    const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    function entryFor(dateStr, shift) {
      return duty.find(r => r.Date === dateStr && r.Shift === shift) || null;
    }

    const cellsHtml = shifts.map(shift => `
      <tr>
        <td style="font-weight:600;">${shift}</td>
        ${days.map((d, i) => {
          const dateStr = isoDate(d);
          const editable = d.getTime() >= today.getTime();
          const entry = entryFor(dateStr, shift);
          const currentName = entry ? entry.Name : '';
          if (!editable) {
            return `<td class="muted">${escapeHtml(currentName || '—')}</td>`;
          }
          return `<td>
            <input type="text" class="hs-duty-input" data-date="${dateStr}" data-shift="${shift}" value="${escapeHtml(currentName)}" placeholder="Name" style="width:100%;box-sizing:border-box;font-size:0.8rem;padding:4px 6px;">
          </td>`;
        }).join('')}
      </tr>
    `).join('');

    bodyEl.innerHTML = `
      <p class="muted" style="margin:0 0 10px;">Past days this week are locked. Today and the rest of the week can be adjusted (e.g. for leave/readjustment).</p>
      <div class="card" style="max-width:100%;margin:0;overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table class="mvoa-table">
          <thead><tr><th>Shift</th>${days.map((d, i) => `<th>${dayLabels[i]}<br><span class="muted" style="font-weight:400;">${d.toLocaleDateString()}</span></th>`).join('')}</tr></thead>
          <tbody>${cellsHtml}</tbody>
        </table>
      </div>
      <button id="hs-duty-save" class="btn-primary" style="margin-top:12px;">Save Roster</button>
      <p class="error-text" id="hs-duty-error"></p>
      <p class="muted" id="hs-duty-saved"></p>
    `;

    bodyEl.querySelector('#hs-duty-save').addEventListener('click', async () => {
      const errEl = bodyEl.querySelector('#hs-duty-error');
      const savedEl = bodyEl.querySelector('#hs-duty-saved');
      const btn = bodyEl.querySelector('#hs-duty-save');
      errEl.textContent = ''; savedEl.textContent = '';
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const toUpdate = []; // { rowNumber, row }
        const toAppend = []; // row
        bodyEl.querySelectorAll('.hs-duty-input').forEach(input => {
          const dateStr = input.dataset.date;
          const shift = input.dataset.shift;
          const newName = input.value.trim();
          const existing = entryFor(dateStr, shift);
          const originalName = existing ? existing.Name : '';
          if (newName === originalName) return; // unchanged
          if (existing) {
            toUpdate.push({ rowNumber: existing.rowNumber, row: [dateStr, shift, newName] });
          } else if (newName) {
            toAppend.push([dateStr, shift, newName]);
          }
        });
        for (const u of toUpdate) {
          await MVOA.sheetsUpdateRow(MVOA.TABS.hsShiftDuty, u.rowNumber, u.row);
        }
        if (toAppend.length) await MVOA.sheetsAppendMany(MVOA.TABS.hsShiftDuty, toAppend);
        if (!toUpdate.length && !toAppend.length) {
          savedEl.textContent = 'No changes to save.';
        } else {
          savedEl.textContent = `✓ Saved ${toUpdate.length + toAppend.length} change(s).`;
          renderShiftDuty(container); // refresh so row numbers stay correct for further edits
        }
      } catch (e) {
        errEl.textContent = 'Could not save: ' + e.message;
      }
      btn.disabled = false;
      btn.textContent = 'Save Roster';
    });
  }

  // ───────────────────────────────────────────────────────────
  // AMC & COMPLIANCE — HSAMCAssets columns: AssetID | AssetName |
  // AssetCode | Nature | LastDone | FrequencyMonths | ReminderLeadDays
  // | Active. NextDue and the reminder trigger are always COMPUTED
  // from LastDone+FrequencyMonths (not stored), so they can never go
  // stale. HSAMCLog (AssetID | CompletedDate | CompletedBy |
  // ReportURL) keeps a full history of completions with their
  // attached report, while the asset row's own LastDone always
  // reflects just the most recent one (matching the original sheet's
  // simple flat-table shape).
  // ───────────────────────────────────────────────────────────
  const AMC_COLS = ['AssetID', 'AssetName', 'AssetCode', 'Nature', 'LastDone', 'FrequencyMonths', 'ReminderLeadDays', 'Active', 'ContractStartDate', 'ContractEndDate'];
  const AMC_LOG_COLS = ['LogID', 'AssetID', 'CompletedDate', 'CompletedBy', 'ReportURL'];

  function addMonths(date, months) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + parseInt(months, 10) || 0);
    return d;
  }
  function amcNextDue(asset) {
    const last = new Date(asset.LastDone);
    if (isNaN(last)) return null;
    return addMonths(last, asset.FrequencyMonths);
  }
  function amcDaysUntilDue(asset) {
    const due = amcNextDue(asset);
    if (!due) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((due - today) / (1000 * 60 * 60 * 24));
  }
  const CONTRACT_END_LEAD_DAYS = 14; // fixed lead for contract-expiry flagging, separate from each asset's own ReminderLeadDays (which is for the AMC-due reminder)
  function amcDaysUntilContractEnd(asset) {
    if (!asset.ContractEndDate) return null;
    const end = new Date(asset.ContractEndDate);
    if (isNaN(end)) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((end - today) / (1000 * 60 * 60 * 24));
  }

  async function renderAmcCompliance(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
        <strong>📋 AMC &amp; Compliance</strong>
      </div>
      <div id="hs-amc-body"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));

    const bodyEl = container.querySelector('#hs-amc-body');
    let rows;
    try {
      rows = await MVOA.sheetsRead(MVOA.TABS.hsAmcAssets);
    } catch (e) {
      bodyEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const assets = rowsToObjs(rows, AMC_COLS).filter(a => a.Active === 'TRUE' || a.Active === 'true');

    const dueSoon = assets.filter(a => {
      const days = amcDaysUntilDue(a);
      return days !== null && days <= (parseInt(a.ReminderLeadDays, 10) || 0);
    }).sort((a, b) => amcDaysUntilDue(a) - amcDaysUntilDue(b));

    const contractsExpiringSoon = assets.filter(a => {
      const days = amcDaysUntilContractEnd(a);
      return days !== null && days <= CONTRACT_END_LEAD_DAYS;
    }).sort((a, b) => amcDaysUntilContractEnd(a) - amcDaysUntilContractEnd(b));

    bodyEl.innerHTML = `
      ${dueSoon.length ? `
        <div class="card" style="max-width:100%;margin:0 0 16px 0;border:2px solid #b3261e;">
          <h3 style="margin:0 0 8px;color:#b3261e;">⚠️ Due Soon / Overdue</h3>
          ${dueSoon.map(a => {
            const days = amcDaysUntilDue(a);
            return `<p style="margin:4px 0;">${escapeHtml(a.AssetName)} (${escapeHtml(a.AssetCode)}) — ${days < 0 ? `<strong style="color:#b3261e;">Overdue by ${-days} day(s)</strong>` : `due in ${days} day(s)`}</p>`;
          }).join('')}
        </div>
      ` : ''}
      ${contractsExpiringSoon.length ? `
        <div class="card" style="max-width:100%;margin:0 0 16px 0;border:2px solid #b3261e;">
          <h3 style="margin:0 0 8px;color:#b3261e;">📄 Contract Expiring Soon</h3>
          ${contractsExpiringSoon.map(a => {
            const days = amcDaysUntilContractEnd(a);
            return `<p style="margin:4px 0;">${escapeHtml(a.AssetName)} (${escapeHtml(a.AssetCode)}) — ${days < 0 ? `<strong style="color:#b3261e;">Expired ${-days} day(s) ago</strong>` : `expires in ${days} day(s)`}</p>`;
          }).join('')}
        </div>
      ` : ''}
      <div class="mvoa-row" style="margin-bottom:10px;">
        <p class="muted" style="margin:0;">${assets.length} asset(s) tracked</p>
        <button id="hs-amc-add-btn" class="btn-secondary">+ Add New Asset</button>
      </div>
      <div id="hs-amc-add-form"></div>
      <div class="card" style="max-width:100%;margin:0;overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table class="mvoa-table">
          <thead><tr><th>Asset Name</th><th>Asset Code</th><th>Nature</th><th>Last Done</th><th>Next Due</th><th>Status</th><th>Contract End</th><th></th></tr></thead>
          <tbody>
            ${assets.map(a => {
              const due = amcNextDue(a);
              const days = amcDaysUntilDue(a);
              const statusHtml = days === null ? '<span class="muted">—</span>'
                : days < 0 ? `<span style="color:#b3261e;font-weight:700;">Overdue ${-days}d</span>`
                : days <= (parseInt(a.ReminderLeadDays, 10) || 0) ? `<span style="color:#b3261e;font-weight:700;">Due in ${days}d</span>`
                : `<span style="color:green;">OK (${days}d)</span>`;
              const contractDays = amcDaysUntilContractEnd(a);
              const contractHtml = !a.ContractEndDate ? '<span class="muted">—</span>'
                : contractDays < 0 ? `<span style="color:#b3261e;font-weight:700;">Expired</span>`
                : contractDays <= CONTRACT_END_LEAD_DAYS ? `<span style="color:#b3261e;font-weight:700;">${new Date(a.ContractEndDate).toLocaleDateString()} (${contractDays}d)</span>`
                : new Date(a.ContractEndDate).toLocaleDateString();
              return `<tr>
                <td>${escapeHtml(a.AssetName)}</td>
                <td>${escapeHtml(a.AssetCode)}</td>
                <td>${escapeHtml(a.Nature)}</td>
                <td>${a.LastDone ? new Date(a.LastDone).toLocaleDateString() : '—'}</td>
                <td>${due ? due.toLocaleDateString() : '—'}</td>
                <td>${statusHtml}</td>
                <td>${contractHtml}</td>
                <td>
                  <button class="btn-primary hs-amc-done-btn" data-asset-id="${a.AssetID}" style="font-size:0.8rem;padding:4px 10px;margin:0 0 4px 0;">✓ Mark Done</button>
                  <button class="btn-secondary hs-amc-history-btn" data-asset-id="${a.AssetID}" style="font-size:0.8rem;padding:4px 10px;margin:0 0 4px 0;">🕘 History</button>
                  <button class="btn-secondary hs-amc-edit-btn" data-asset-id="${a.AssetID}" style="font-size:0.8rem;padding:4px 10px;margin:0;">✏️ Edit</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    bodyEl.querySelector('#hs-amc-add-btn').addEventListener('click', () => renderAmcAddForm(bodyEl.querySelector('#hs-amc-add-form'), container));
    bodyEl.querySelectorAll('.hs-amc-done-btn').forEach(btn => {
      btn.addEventListener('click', () => openAmcMarkDoneDialog(btn.dataset.assetId, assets, container));
    });
    bodyEl.querySelectorAll('.hs-amc-history-btn').forEach(btn => {
      btn.addEventListener('click', () => openAmcHistoryDialog(btn.dataset.assetId, assets));
    });
    bodyEl.querySelectorAll('.hs-amc-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openAmcEditDialog(btn.dataset.assetId, assets, container));
    });
  }

  // History modal — every past completion for one asset, newest first,
  // pulled straight from HSAMCLog (never overwritten; Mark Done always
  // appends there, only HSAMCAssets.LastDone gets updated in place).
  // Read-only — this is the "how do I see an old report" gap the app
  // previously had no answer for.
  async function openAmcHistoryDialog(assetId, assets) {
    const asset = assets.find(a => a.AssetID === assetId);
    if (!asset) return;
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box" style="text-align:left;">
        <h3>History: ${escapeHtml(asset.AssetName)}</h3>
        <div id="hs-amc-history-body"><p class="muted">Loading…</p></div>
        <button id="hs-amc-history-close" class="btn-secondary" style="margin-top:10px;">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#hs-amc-history-close').addEventListener('click', () => modal.remove());

    const bodyEl = modal.querySelector('#hs-amc-history-body');
    try {
      const logRows = await MVOA.sheetsRead(MVOA.TABS.hsAmcLog);
      const entries = rowsToObjs(logRows, AMC_LOG_COLS)
        .filter(l => l.AssetID === assetId)
        .sort((a, b) => b.CompletedDate.localeCompare(a.CompletedDate));
      bodyEl.innerHTML = entries.length
        ? entries.map(l => {
            const attachments = parseReportUrls(l.ReportURL);
            const links = attachments.length
              ? attachments.map(a => `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${a.kind === 'PHOTO' ? '📷' : a.kind === 'DOC' ? '📄' : '📎'} View ${a.kind === 'PHOTO' ? 'photo' : a.kind === 'DOC' ? 'document' : 'report'}</a>`).join(' &nbsp; ')
              : '<span class="muted">No report attached</span>';
            return `
            <p style="margin:6px 0;padding-bottom:6px;border-bottom:1px solid #eee;">
              ${new Date(l.CompletedDate).toLocaleDateString()} — ${escapeHtml(l.CompletedBy)}<br>
              ${links}
            </p>
          `;
          }).join('')
        : '<p class="muted">No completions logged yet.</p>';
    } catch (e) {
      bodyEl.innerHTML = `<p class="error-text">Could not load history: ${e.message}</p>`;
    }
  }

  function openAmcEditDialog(assetId, assets, container) {
    const asset = assets.find(a => a.AssetID === assetId);
    if (!asset) return;
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box" style="text-align:left;">
        <h3>Edit Asset: ${escapeHtml(asset.AssetName)}</h3>
        <label>Asset Name <input type="text" id="hs-amc-edit-name" value="${escapeHtml(asset.AssetName)}"></label>
        <label>Asset Code <input type="text" id="hs-amc-edit-code" value="${escapeHtml(asset.AssetCode)}"></label>
        <label>Nature (e.g. AMC, Fitness Check) <input type="text" id="hs-amc-edit-nature" value="${escapeHtml(asset.Nature)}"></label>
        <label>Frequency (months) <input type="number" id="hs-amc-edit-freq" value="${escapeHtml(asset.FrequencyMonths)}"></label>
        <label>Reminder Lead (days) <input type="number" id="hs-amc-edit-lead" value="${escapeHtml(asset.ReminderLeadDays)}"></label>
        <label>Contract Start Date <input type="date" id="hs-amc-edit-cstart" value="${asset.ContractStartDate ? isoDate(new Date(asset.ContractStartDate)) : ''}"></label>
        <label>Contract End Date <input type="date" id="hs-amc-edit-cend" value="${asset.ContractEndDate ? isoDate(new Date(asset.ContractEndDate)) : ''}"></label>
        <button id="hs-amc-edit-save" class="btn-primary" style="margin-top:10px;">Save</button>
        <button id="hs-amc-edit-cancel" class="btn-secondary">Cancel</button>
        <p class="error-text" id="hs-amc-edit-error"></p>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#hs-amc-edit-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#hs-amc-edit-save').addEventListener('click', async () => {
      const errEl = modal.querySelector('#hs-amc-edit-error');
      const name = modal.querySelector('#hs-amc-edit-name').value.trim();
      const code = modal.querySelector('#hs-amc-edit-code').value.trim();
      const nature = modal.querySelector('#hs-amc-edit-nature').value.trim();
      const freq = modal.querySelector('#hs-amc-edit-freq').value;
      const lead = modal.querySelector('#hs-amc-edit-lead').value;
      const cstart = modal.querySelector('#hs-amc-edit-cstart').value;
      const cend = modal.querySelector('#hs-amc-edit-cend').value;
      if (!name || !code || !freq) {
        errEl.textContent = 'Please fill in at least Name, Code, and Frequency.';
        return;
      }
      const saveBtn = modal.querySelector('#hs-amc-edit-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const updated = Object.assign({}, asset, {
          AssetName: name,
          AssetCode: code,
          Nature: nature,
          FrequencyMonths: freq,
          ReminderLeadDays: lead,
          ContractStartDate: cstart,
          ContractEndDate: cend
        });
        await MVOA.sheetsUpdateRow(MVOA.TABS.hsAmcAssets, asset.rowNumber, AMC_COLS.map(c => updated[c] !== undefined ? updated[c] : ''));
        modal.remove();
        renderAmcCompliance(container);
      } catch (e) {
        errEl.textContent = 'Could not save: ' + e.message;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
  }

  function renderAmcAddForm(formEl, container) {
    formEl.innerHTML = `
      <div class="card" style="max-width:420px;margin:0 0 16px 0;">
        <label>Asset Name <input type="text" id="hs-amc-new-name"></label>
        <label>Asset Code <input type="text" id="hs-amc-new-code"></label>
        <label>Nature (e.g. AMC, Fitness Check) <input type="text" id="hs-amc-new-nature"></label>
        <label>Last Done <input type="date" id="hs-amc-new-lastdone"></label>
        <label>Frequency (months) <input type="number" id="hs-amc-new-freq" value="2"></label>
        <label>Reminder Lead (days) <input type="number" id="hs-amc-new-lead" value="14"></label>
        <label>Contract Start Date (optional) <input type="date" id="hs-amc-new-cstart"></label>
        <label>Contract End Date (optional) <input type="date" id="hs-amc-new-cend"></label>
        <button id="hs-amc-new-save" class="btn-primary" style="width:100%;margin-top:8px;">Add Asset</button>
        <p class="error-text" id="hs-amc-new-error"></p>
      </div>
    `;
    formEl.querySelector('#hs-amc-new-save').addEventListener('click', async () => {
      const errEl = formEl.querySelector('#hs-amc-new-error');
      const name = formEl.querySelector('#hs-amc-new-name').value.trim();
      const code = formEl.querySelector('#hs-amc-new-code').value.trim();
      const nature = formEl.querySelector('#hs-amc-new-nature').value.trim();
      const lastDone = formEl.querySelector('#hs-amc-new-lastdone').value;
      const freq = formEl.querySelector('#hs-amc-new-freq').value;
      const lead = formEl.querySelector('#hs-amc-new-lead').value;
      const cstart = formEl.querySelector('#hs-amc-new-cstart').value;
      const cend = formEl.querySelector('#hs-amc-new-cend').value;
      if (!name || !code || !lastDone || !freq) {
        errEl.textContent = 'Please fill in at least Name, Code, Last Done, and Frequency.';
        return;
      }
      try {
        const existingRows = await MVOA.sheetsRead(MVOA.TABS.hsAmcAssets);
        const existingIds = existingRows.slice(1).map(r => r[0]).filter(Boolean);
        const assetId = MVOA.nextId('AMC', existingIds);
        await MVOA.sheetsAppend(MVOA.TABS.hsAmcAssets, [assetId, name, code, nature, lastDone, freq, lead, 'TRUE', cstart, cend]);
        formEl.innerHTML = '';
        renderAmcCompliance(container);
      } catch (e) {
        errEl.textContent = 'Could not save: ' + e.message;
      }
    });
  }

  function openAmcMarkDoneDialog(assetId, assets, container) {
    const asset = assets.find(a => a.AssetID === assetId);
    if (!asset) return;
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box" style="text-align:left;">
        <h3>Mark Done: ${escapeHtml(asset.AssetName)}</h3>
        <label>Completed Date
          <input type="date" id="hs-amc-done-date" value="${isoDate(new Date())}">
        </label>
        <div id="hs-amc-done-docs-list" style="margin-top:10px;"></div>
        <button id="hs-amc-done-doc-btn" class="btn-secondary" style="width:100%;">📄 Attach Document (up to 3)</button>
        <div id="hs-amc-done-photos-list" style="margin-top:10px;"></div>
        <button id="hs-amc-done-photo-btn" class="btn-secondary" style="width:100%;margin-top:6px;">📷 Attach Photo (up to 3)</button>
        <button id="hs-amc-done-save" class="btn-primary" style="margin-top:10px;">Save</button>
        <button id="hs-amc-done-cancel" class="btn-secondary">Cancel</button>
        <p class="error-text" id="hs-amc-done-error"></p>
      </div>
    `;
    document.body.appendChild(modal);
    // Up to 3 of each kind — stored together as a single "|"-joined
    // ReportURL string, each entry tagged "DOC::url" / "PHOTO::url" so
    // the History modal can label and icon them correctly. Older
    // single-attachment log rows (no "::" tag) still render fine —
    // parseReportUrls falls back to a generic link for those.
    let docs = [], photos = [];

    function renderAttachLists() {
      modal.querySelector('#hs-amc-done-docs-list').innerHTML = docs.map((d, i) =>
        `<p class="muted" style="margin:2px 0;">📄 ${escapeHtml(d.name)} <a href="#" class="hs-amc-remove-doc" data-idx="${i}">✕</a></p>`).join('');
      modal.querySelector('#hs-amc-done-photos-list').innerHTML = photos.map((p, i) =>
        `<p class="muted" style="margin:2px 0;">📷 ${escapeHtml(p.name)} <a href="#" class="hs-amc-remove-photo" data-idx="${i}">✕</a></p>`).join('');
      modal.querySelector('#hs-amc-done-doc-btn').disabled = docs.length >= 3;
      modal.querySelector('#hs-amc-done-photo-btn').disabled = photos.length >= 3;
      modal.querySelectorAll('.hs-amc-remove-doc').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); docs.splice(+el.dataset.idx, 1); renderAttachLists(); }));
      modal.querySelectorAll('.hs-amc-remove-photo').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); photos.splice(+el.dataset.idx, 1); renderAttachLists(); }));
    }

    modal.querySelector('#hs-amc-done-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#hs-amc-done-doc-btn').addEventListener('click', async () => {
      if (docs.length >= 3) return;
      const a = await MVOA.pickAttachment({ photoOnly: false, useCamera: false });
      if (a) { docs.push(a); renderAttachLists(); }
    });
    modal.querySelector('#hs-amc-done-photo-btn').addEventListener('click', async () => {
      if (photos.length >= 3) return;
      const a = await MVOA.pickAttachment({ photoOnly: true, useCamera: false });
      if (a) { photos.push(a); renderAttachLists(); }
    });
    modal.querySelector('#hs-amc-done-save').addEventListener('click', async () => {
      const errEl = modal.querySelector('#hs-amc-done-error');
      const dateVal = modal.querySelector('#hs-amc-done-date').value;
      if (!dateVal) { errEl.textContent = 'Please pick a date.'; return; }
      const saveBtn = modal.querySelector('#hs-amc-done-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const urlParts = [];
        for (let i = 0; i < docs.length; i++) {
          saveBtn.textContent = `Uploading document ${i + 1}/${docs.length}…`;
          const url = await MVOA.uploadPhotoToDrive(docs[i].file, `AMC_${asset.AssetCode}_${dateVal}_doc${i + 1}_${docs[i].name}`);
          urlParts.push(`DOC::${url}`);
        }
        for (let i = 0; i < photos.length; i++) {
          saveBtn.textContent = `Uploading photo ${i + 1}/${photos.length}…`;
          const url = await MVOA.uploadPhotoToDrive(photos[i].file, `AMC_${asset.AssetCode}_${dateVal}_photo${i + 1}_${photos[i].name}`);
          urlParts.push(`PHOTO::${url}`);
        }
        const reportUrl = urlParts.join('|');
        const updated = Object.assign({}, asset, { LastDone: dateVal });
        await MVOA.sheetsUpdateRow(MVOA.TABS.hsAmcAssets, asset.rowNumber, AMC_COLS.map(c => updated[c] !== undefined ? updated[c] : ''));
        const existingLogRows = await MVOA.sheetsRead(MVOA.TABS.hsAmcLog);
        const existingLogIds = existingLogRows.slice(1).map(r => r[0]).filter(Boolean);
        const logId = MVOA.nextId('AMCLOG', existingLogIds);
        const user = MVOA.getUser();
        await MVOA.sheetsAppend(MVOA.TABS.hsAmcLog, [logId, asset.AssetID, dateVal, user.name, reportUrl]);
        modal.remove();
        renderAmcCompliance(container);
      } catch (e) {
        errEl.textContent = 'Could not save: ' + e.message;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });
    renderAttachLists();
  }

  // Parses a ReportURL cell into individual (kind, url) entries. Handles
  // the new "DOC::url|PHOTO::url|..." multi-attachment format as well as
  // older single-attachment rows that have no "::" tag at all.
  function parseReportUrls(reportUrl) {
    if (!reportUrl) return [];
    return reportUrl.split('|').filter(Boolean).map(part => {
      const idx = part.indexOf('::');
      if (idx === -1) return { kind: 'REPORT', url: part };
      return { kind: part.slice(0, idx), url: part.slice(idx + 2) };
    });
  }

  // ───────────────────────────────────────────────────────────
  // IN / OUT LOG — Sewage/Garbage/Water Tanker/Garden Waste. Doesn't fit
  // the generic scan→checklist shape at all: multiple IN/OUT entries can
  // happen per day (a vehicle could come and go more than once), and
  // Sewage/Garbage additionally need a WEEKLY rollup evaluated only on
  // Sunday (≥2 visits for Sewage, ≥3 for Garbage, Mon-Sun) — genuinely
  // different from "one submission per day/shift" everything else here
  // assumes, so this is its own dedicated screen + sheet (HSInOutLog)
  // rather than forced through HSChecklistLog/Items. Referenced by its
  // raw tab name rather than through MVOA.TABS, since that lookup lives
  // in shared.js and adding an entry there wasn't available this
  // session — functionally identical either way.
  // ───────────────────────────────────────────────────────────
  const TAB_HS_INOUT_LOG = 'HSInOutLog';
  const INOUT_LOG_COLS = ['LogID', 'Type', 'Direction', 'Timestamp', 'PhotoURL', 'LoggedBy'];
  // weeklyMin: null means "frequency not defined" per the spec — no
  // Fail concept at all for that type, logging only.
  const IN_OUT_TYPES = [
    { key: 'Sewage Disposal', needsPhoto: true, weeklyMin: 2 },
    { key: 'Garbage Disposal', needsPhoto: false, weeklyMin: 3 },
    { key: 'Water Tanker', needsPhoto: true, weeklyMin: null },
    { key: 'Garden Waste Disposal', needsPhoto: false, weeklyMin: null }
  ];

  async function renderInOutLog(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-scan" class="btn-secondary">← Back</button>
        <strong>🚚 In / Out Log — ${escapeHtml(categoryLabel(currentScan.qrTarget))}</strong>
      </div>
      <div id="hs-inout-body"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-scan').addEventListener('click', () => renderScanResult(container));

    const bodyEl = container.querySelector('#hs-inout-body');
    let logs;
    try {
      const rows = await MVOA.sheetsRead(TAB_HS_INOUT_LOG);
      logs = rowsToObjs(rows, INOUT_LOG_COLS);
    } catch (e) {
      bodyEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const monday = mondayOfWeek(today);

    // Sunday-only weekly evaluation — see evaluateWeeklyInOutCompliance.
    // Deliberately client-triggered (no reliable background trigger
    // exists in this app yet) rather than skipped: whoever opens this
    // screen on a Sunday causes the check to run, with its own dedup so
    // opening it repeatedly that day never creates duplicate tasks.
    if (today.getDay() === 0) {
      await evaluateWeeklyInOutCompliance(logs, monday, today);
    }

    function countThisWeek(typeKey, direction) {
      return logs.filter(l => l.Type === typeKey && l.Direction === direction &&
        new Date(l.Timestamp) >= monday && new Date(l.Timestamp) <= new Date(today.getTime() + 86400000)).length;
    }
    function todaysEntries(typeKey) {
      return logs.filter(l => l.Type === typeKey && new Date(l.Timestamp).toDateString() === today.toDateString())
        .sort((a, b) => a.Timestamp.localeCompare(b.Timestamp));
    }

    bodyEl.innerHTML = IN_OUT_TYPES.map(t => {
      const weekCount = countThisWeek(t.key, 'IN');
      const entries = todaysEntries(t.key);
      const isSunday = today.getDay() === 0;
      const weeklyStatusHtml = t.weeklyMin
        ? `<p class="muted" style="margin:0 0 8px;">This week: ${weekCount} visit(s)${isSunday
            ? (weekCount < t.weeklyMin ? ` <span style="color:#b3261e;font-weight:700;">— below the minimum of ${t.weeklyMin}</span>` : ` <span style="color:green;font-weight:700;">— meets the minimum</span>`)
            : ` (minimum ${t.weeklyMin} by Sunday)`}</p>`
        : '';
      // Which direction is actually loggable next — not just "today's"
      // entries, since a vehicle could log IN before midnight and OUT
      // after. Looks at the most recent entry of ANY day for this type;
      // no entries yet, or the last one was OUT, means IN is next; last
      // one was IN means OUT is next. This is what was missing before —
      // nothing stopped "Log IN" being pressed twice in a row with no
      // OUT in between, which is what looked like duplicate entries.
      const lastEntry = logs.filter(l => l.Type === t.key).sort((a, b) => a.Timestamp.localeCompare(b.Timestamp)).pop();
      const currentlyIn = lastEntry && lastEntry.Direction === 'IN';
      return `
        <div class="card" style="max-width:520px;margin:0 0 16px 0;">
          <h3 style="margin:0 0 8px;color:var(--mvoa-blue);">${escapeHtml(t.key)}</h3>
          ${weeklyStatusHtml}
          <div style="display:flex;gap:8px;margin-bottom:8px;">
            <button class="btn-primary hs-inout-btn" data-type="${escapeHtml(t.key)}" data-direction="IN" data-photo="${t.needsPhoto}" style="flex:1;" ${currentlyIn ? 'disabled' : ''}>Log IN</button>
            <button class="btn-secondary hs-inout-btn" data-type="${escapeHtml(t.key)}" data-direction="OUT" data-photo="${t.needsPhoto}" style="flex:1;" ${!currentlyIn ? 'disabled' : ''}>Log OUT</button>
          </div>
          ${currentlyIn ? `<p class="muted" style="margin:0 0 8px;font-size:0.8rem;">Currently IN — log OUT before logging IN again.</p>` : ''}
          <p class="muted" style="margin:0 0 4px;font-size:0.8rem;font-weight:600;">Today:</p>
          ${entries.length ? entries.map(e => `<p class="muted" style="margin:2px 0;font-size:0.85rem;">${e.Direction} — ${formatDate(e.Timestamp)}${e.PhotoURL ? ` · <a href="${e.PhotoURL}" target="_blank" rel="noopener">📷</a>` : ''}</p>`).join('') : '<p class="muted" style="font-size:0.85rem;">No entries today yet.</p>'}
        </div>
      `;
    }).join('');

    bodyEl.querySelectorAll('.hs-inout-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Disable every log button the instant one is tapped — the
        // isLoggingInOut flag already blocks a re-entrant save, but
        // there was no visual feedback before the screen re-rendered,
        // so an impatient double-tap (or a slow network) could look
        // like nothing happened and invite a second real tap.
        bodyEl.querySelectorAll('.hs-inout-btn').forEach(b => b.disabled = true);
        logInOutEntry(btn.dataset.type, btn.dataset.direction, btn.dataset.photo === 'true', container);
      });
    });
  }

  let isLoggingInOut = false;
  async function logInOutEntry(typeKey, direction, needsPhoto, container) {
    if (isLoggingInOut) return;
    let photoFile = null, photoName = '';
    if (needsPhoto) {
      // Forces the actual camera — the timestamped photo IS the record
      // that the vehicle was there, same reasoning as Security's Rounds.
      const a = await MVOA.pickAttachment({ photoOnly: true, useCamera: true });
      if (!a) {
        // Cancelled — the calling click handler disabled every log
        // button before this ran, so re-enable them here since we're
        // returning without the re-render that would normally do it.
        container.querySelectorAll('.hs-inout-btn').forEach(b => b.disabled = false);
        return;
      }
      photoFile = a.file; photoName = a.name;
    }
    isLoggingInOut = true;
    try {
      const existingRows = await MVOA.sheetsRead(TAB_HS_INOUT_LOG);
      const existingIds = existingRows.slice(1).map(r => r[0]).filter(Boolean);
      // Authoritative re-check, not just trusting the disabled button —
      // guards against a stale screen or two people logging the same
      // gate at once. Re-reads the actual last entry right before
      // writing, same reasoning as hasSubmittedToday's submit-time check.
      const allLogs = rowsToObjs(existingRows, INOUT_LOG_COLS);
      const lastEntry = allLogs.filter(l => l.Type === typeKey).sort((a, b) => a.Timestamp.localeCompare(b.Timestamp)).pop();
      const currentlyIn = lastEntry && lastEntry.Direction === 'IN';
      if (direction === 'IN' && currentlyIn) {
        alert(`Already logged IN for ${typeKey} — log OUT first.`);
        isLoggingInOut = false;
        await renderInOutLog(container);
        return;
      }
      if (direction === 'OUT' && !currentlyIn) {
        alert(`${typeKey} isn't currently logged IN.`);
        isLoggingInOut = false;
        await renderInOutLog(container);
        return;
      }
      const logId = MVOA.nextId('IOLOG', existingIds);
      let photoUrl = '';
      if (photoFile) photoUrl = await MVOA.uploadPhotoToDrive(photoFile, `${logId}_${photoName}`);
      const user = MVOA.getUser();
      const row = INOUT_LOG_COLS.map(c => ({
        LogID: logId, Type: typeKey, Direction: direction, Timestamp: new Date().toISOString(),
        PhotoURL: photoUrl, LoggedBy: user.name
      })[c]);
      await MVOA.sheetsAppend(TAB_HS_INOUT_LOG, row);
      await renderInOutLog(container); // fresh render creates its own enabled buttons
    } catch (e) {
      alert('Could not save entry: ' + e.message);
      container.querySelectorAll('.hs-inout-btn').forEach(b => b.disabled = false); // no re-render on this path, so re-enable manually
    }
    isLoggingInOut = false;
  }

  // Runs only when opened on a Sunday — evaluates Mon-Sun visit counts
  // for whichever IN_OUT_TYPES entries define a weeklyMin (Sewage,
  // Garbage; Water Tanker/Garden Waste have none per the spec, so never
  // evaluated here), and creates ONE task per shortfall per week.
  // Dedup is by exact task title (embeds the week's Monday date) rather
  // than "any open task", since a closed task from an earlier week
  // shouldn't prevent detecting a NEW shortfall this week, but this
  // exact week's task should never be created twice regardless of
  // whether it's since been closed.
  async function evaluateWeeklyInOutCompliance(logs, monday, today) {
    for (const t of IN_OUT_TYPES) {
      if (!t.weeklyMin) continue;
      const count = logs.filter(l => l.Type === t.key && l.Direction === 'IN' &&
        new Date(l.Timestamp) >= monday && new Date(l.Timestamp) <= new Date(today.getTime() + 86400000)).length;
      if (count >= t.weeklyMin) continue;
      const title = `Plant Rounds: ${t.key} — only ${count} visit(s) this week (week of ${isoDate(monday)})`;
      try {
        const opsTaskRows = await MVOA.sheetsRead(MVOA.TABS.opsTasks);
        const alreadyExists = opsTaskRows.slice(1).some(r => (r[OPS_TASK_COL_IDX.Title] || '') === title);
        if (alreadyExists) continue;
        await MVOA.createOpsTask({
          categoryName: 'Security',
          title,
          description: `Weekly minimum for ${t.key} is ${t.weeklyMin} visits (Monday–Sunday) — only ${count} recorded this week.`,
          assigneeTitle: 'Facility Manager',
          priority: 'Urgent',
          createdBy: 'System (Plant Rounds — weekly In/Out check)'
        });
      } catch (e) {
        // Best-effort — this runs passively on page load; don't block
        // the screen over it, worst case the check just runs again
        // next time someone opens this screen today.
      }
    }
  }

  // WEEKLY-ONLY ITEMS (DayApplicability === 'WeeklyOnce') — e.g. Cob Web
  // Removal, DG/EB/Server/WTP Room Cleaning. No fixed day; just needs to
  // happen once Monday–Sunday. Evaluated only on Sunday, same shape as
  // evaluateWeeklyInOutCompliance: for every WeeklyOnce item on every
  // template belonging to this category, check whether any log for that
  // template this week recorded a Pass for it; if not, create one Ops
  // task. Dedup by exact title (embeds the week's Monday date) so
  // opening the screen repeatedly on Sunday never double-creates, but a
  // closed task from an earlier week never blocks detecting a new
  // shortfall this week.
  async function evaluateWeeklyItemCompliance(qrTarget) {
    const now = new Date();
    if (now.getDay() !== 0) return; // Sunday only
    const monday = mondayOfWeek(now);
    const relevantTemplates = templatesCache.filter(t => t.QRTarget === qrTarget);
    for (const template of relevantTemplates) {
      const weeklyItems = itemsCache.filter(i => i.TemplateID === template.TemplateID && i.DayApplicability === 'WeeklyOnce');
      if (!weeklyItems.length) continue;
      let logIdsThisWeek, results;
      try {
        const logRows = await MVOA.sheetsRead(MVOA.TABS.hsLog);
        logIdsThisWeek = new Set(
          rowsToObjs(logRows, LOG_COLS)
            .filter(l => l.TemplateID === template.TemplateID &&
              new Date(l.Timestamp) >= monday && new Date(l.Timestamp) <= new Date(now.getTime() + 86400000))
            .map(l => l.LogID)
        );
        const resultRows = await MVOA.sheetsRead(MVOA.TABS.hsItemResults);
        results = rowsToObjs(resultRows, RESULT_COLS);
      } catch (e) {
        return; // best-effort — passive check, just retries next time this screen opens
      }
      for (const item of weeklyItems) {
        const donePass = results.some(r => r.ItemID === item.ItemID && logIdsThisWeek.has(r.LogID) && r.Result === 'Pass');
        if (donePass) continue;
        const title = `Plant Rounds: ${item.CheckItem} not done this week — ${categoryLabel(qrTarget)} (week of ${isoDate(monday)})`;
        try {
          const opsTaskRows = await MVOA.sheetsRead(MVOA.TABS.opsTasks);
          const alreadyExists = opsTaskRows.slice(1).some(r => (r[OPS_TASK_COL_IDX.Title] || '') === title);
          if (alreadyExists) continue;
          await MVOA.createOpsTask({
            categoryName: effectiveFailTaskCategory(template, qrTarget),
            title,
            description: `${item.CheckItem} (${template.Name}) has no Pass recorded Monday–Sunday this week.`,
            assigneeTitle: 'Facility Manager',
            priority: 'Medium',
            createdBy: 'System (Plant Rounds — weekly item check)'
          });
        } catch (e) {
          // best-effort — same reasoning as above
        }
      }
    }
  }

  function renderReportsMenu(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
        <strong>📈 Reports</strong>
      </div>
      <div class="card" style="max-width:420px;margin:0;">
        <button id="hs-report-failed" class="btn-secondary" style="width:100%;margin-bottom:8px;">❌ Failed Items Log</button>
        <button id="hs-report-tasks" class="btn-secondary" style="width:100%;margin-bottom:8px;">🔗 Auto-Flagged Task Resolution</button>
        <button id="hs-report-shift" class="btn-secondary" style="width:100%;margin-bottom:8px;">🕐 Shift Coverage (Daily)</button>
        <button id="hs-report-hours" class="btn-secondary" style="width:100%;margin-bottom:8px;">⏱️ DG Running Hours</button>
        <button id="hs-report-monthly" class="btn-secondary" style="width:100%;margin-bottom:8px;">📅 Monthly Report</button>
        <button id="hs-report-rounds-monthly" class="btn-secondary" style="width:100%;margin-bottom:8px;">🗓️ Rounds Monthly Report (Security)</button>
        <button id="hs-report-inout-monthly" class="btn-secondary" style="width:100%;margin-bottom:8px;">🚚 In/Out Monthly Report</button>
        <button id="hs-report-schedule" class="btn-secondary" style="width:100%;">🗂️ Inspection Schedule</button>
      </div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));
    container.querySelector('#hs-report-failed').addEventListener('click', () => renderFailedItemsReport(container));
    container.querySelector('#hs-report-tasks').addEventListener('click', () => renderTaskResolutionReport(container));
    container.querySelector('#hs-report-shift').addEventListener('click', () => renderShiftCoverageReport(container));
    container.querySelector('#hs-report-hours').addEventListener('click', () => renderRunningHoursReport(container));
    container.querySelector('#hs-report-monthly').addEventListener('click', () => renderMonthlyReport(container));
    container.querySelector('#hs-report-rounds-monthly').addEventListener('click', () => renderRoundsMonthlyReport(container));
    container.querySelector('#hs-report-inout-monthly').addEventListener('click', () => renderInOutMonthlyReport(container));
    container.querySelector('#hs-report-schedule').addEventListener('click', () => renderInspectionSchedule(container));
  }

  // ───────────────────────────────────────────────────────────
  // ROUNDS MONTHLY REPORT — Security's Daily Rounds Photos as a full
  // month at a glance: one row per day, one column-group per active
  // round (from HSRoundWindows), one sub-column per item (Main Gate /
  // Location 2 / Location 3), each cell a clickable photo link (or ✕
  // if that round was logged but this item's photo is missing, or —
  // if the round wasn't logged that day at all). Picking a month
  // always shows just that month — nothing to reset explicitly, a
  // month picker naturally does this, same as the other monthly
  // reports.
  // ───────────────────────────────────────────────────────────
  let roundsMonthlyMonth = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; })();

  function renderRoundsMonthlyReport(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>🗓️ Rounds Monthly Report — Security</strong>
      </div>
      <div class="mvoa-row" style="margin-bottom:12px;gap:8px;">
        <label class="muted">Month: <input id="hs-rounds-month" type="month" value="${roundsMonthlyMonth}"></label>
      </div>
      <div id="hs-rounds-monthly-body" style="overflow-x:auto;-webkit-overflow-scrolling:touch;"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));
    container.querySelector('#hs-rounds-month').addEventListener('change', (e) => {
      roundsMonthlyMonth = e.target.value;
      loadRoundsMonthlyBody(container);
    });
    loadRoundsMonthlyBody(container);
  }

  async function loadRoundsMonthlyBody(container) {
    const bodyEl = container.querySelector('#hs-rounds-monthly-body');
    if (!bodyEl) return;
    const template = templatesCache.find(t => t.QRTarget === 'Security' && (t.RoundBased === 'TRUE' || t.RoundBased === 'true'));
    if (!template) { bodyEl.innerHTML = `<p class="muted">Daily Rounds Photos template not found.</p>`; return; }
    const items = itemsCache.filter(i => i.TemplateID === template.TemplateID).sort((a, b) => (parseInt(a.SeqNo, 10) || 0) - (parseInt(b.SeqNo, 10) || 0));
    const rounds = activeRoundKeys();
    let logs, results;
    try {
      const logRows = await MVOA.sheetsRead(MVOA.TABS.hsLog);
      logs = rowsToObjs(logRows, LOG_COLS).filter(l => l.TemplateID === template.TemplateID && (l.Timestamp || '').startsWith(roundsMonthlyMonth));
      const resultRows = await MVOA.sheetsRead(MVOA.TABS.hsItemResults);
      results = rowsToObjs(resultRows, RESULT_COLS);
    } catch (e) {
      bodyEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const [y, mo] = roundsMonthlyMonth.split('-').map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();

    const DIVIDER = 'border-right:2px solid #999;';
    const ROW_H = 'height:58px;vertical-align:middle;';

    const headerGroupCells = rounds.map((r, gi) => `<th colspan="${items.length}" style="padding:4px 6px;text-align:center;border-bottom:1px solid #ccc;${gi < rounds.length - 1 ? DIVIDER : ''}">${escapeHtml(shiftLabel(r))}</th>`).join('');
    const headerItemCells = rounds.map((r, gi) => items.map((i, ii) => `<th style="padding:4px 6px;font-size:0.75rem;white-space:nowrap;${ii === items.length - 1 && gi < rounds.length - 1 ? DIVIDER : ''}">${escapeHtml(i.CheckItem)}</th>`).join('')).join('');

    const bodyRows = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${roundsMonthlyMonth}-${String(day).padStart(2, '0')}`;
      const dayLogs = logs.filter(l => (l.Timestamp || '').startsWith(dateStr));
      const cells = rounds.map((round, gi) => {
        const log = dayLogs.find(l => l.Shift === round);
        return items.map((item, ii) => {
          const divider = (ii === items.length - 1 && gi < rounds.length - 1) ? DIVIDER : '';
          if (!log) return `<td style="padding:4px 6px;text-align:center;color:#ccc;${ROW_H}${divider}">—</td>`;
          const r = results.find(rr => rr.LogID === log.LogID && rr.ItemID === item.ItemID);
          const remarks = r ? r.Remarks : '';
          const photoUrl = photoUrlFromRemarks(remarks);
          const loc = locationFromRemarks(remarks); // only set for PhotoLocation items (Location 2 / Location 3) — Main Gate has none
          // Time only shown alongside an actual photo — an item with no
          // photo (✕) has nothing that timestamp would even describe.
          const timeStr = photoUrl ? new Date(log.Timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          return `<td style="padding:4px 6px;text-align:center;${ROW_H}${divider}">
            <div>${photoUrl ? `<a href="${escapeHtml(photoUrl)}" target="_blank" rel="noopener">📷</a>` : '<span style="color:#b3261e;">✕</span>'}</div>
            <div class="muted" style="font-size:0.7rem;white-space:nowrap;min-height:1em;">${loc ? escapeHtml(loc) : ''}</div>
            <div class="muted" style="font-size:0.65rem;white-space:nowrap;min-height:1em;">${timeStr}</div>
          </td>`;
        }).join('');
      }).join('');
      bodyRows.push(`<tr><td style="padding:4px 6px;font-weight:600;white-space:nowrap;position:sticky;left:0;background:#fff;${ROW_H}">${day}</td>${cells}</tr>`);
    }

    bodyEl.innerHTML = `
      <table class="mvoa-table" style="border-collapse:collapse;">
        <thead>
          <tr><th rowspan="2" style="padding:4px 6px;position:sticky;left:0;background:#fff;">Date</th>${headerGroupCells}</tr>
          <tr>${headerItemCells}</tr>
        </thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table>
    `;
  }

  // ───────────────────────────────────────────────────────────
  // WEEKLY ROUNDS REPORT — Security's Daily Rounds Photos (Round1/
  // Round2), one week at a time, day by day, with a link to every
  // photo taken. Built as its own report (rather than folding into
  // the generic Monthly Report matrix) because the whole point of
  // this checklist is the photo itself — a Pass/Fail cell tells you
  // nothing here. Photo URLs are pulled from each item result's
  // Remarks text ("Photo: <url>" / "Location: <text> | Photo: <url>"),
  // the same convention renderChecklistForm already writes on submit.
  // ───────────────────────────────────────────────────────────
  let weeklyRoundsWeekStart = mondayOfWeek(new Date());

  function renderWeeklyRoundsReport(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>📷 Weekly Rounds Report — Security</strong>
      </div>
      <div class="mvoa-row" style="margin-bottom:12px;gap:8px;">
        <button id="hs-week-prev" class="btn-secondary">← Prev Week</button>
        <span class="muted">Week of ${weeklyRoundsWeekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        <button id="hs-week-next" class="btn-secondary">Next Week →</button>
      </div>
      <div id="hs-weekly-rounds-body"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));
    container.querySelector('#hs-week-prev').addEventListener('click', () => {
      weeklyRoundsWeekStart = new Date(weeklyRoundsWeekStart.getTime() - 7 * 86400000);
      renderWeeklyRoundsReport(container);
    });
    container.querySelector('#hs-week-next').addEventListener('click', () => {
      weeklyRoundsWeekStart = new Date(weeklyRoundsWeekStart.getTime() + 7 * 86400000);
      renderWeeklyRoundsReport(container);
    });
    loadWeeklyRoundsBody(container);
  }

  function photoUrlFromRemarks(remarks) {
    const m = (remarks || '').match(/Photo:\s*(\S+)/);
    return m ? m[1] : '';
  }
  function locationFromRemarks(remarks) {
    const m = (remarks || '').match(/Location:\s*([^|]+)\s*\|/);
    return m ? m[1].trim() : '';
  }

  async function loadWeeklyRoundsBody(container) {
    const bodyEl = container.querySelector('#hs-weekly-rounds-body');
    if (!bodyEl) return; // user navigated away before this resolved
    const template = templatesCache.find(t => t.QRTarget === 'Security' && (t.RoundBased === 'TRUE' || t.RoundBased === 'true'));
    if (!template) { bodyEl.innerHTML = `<p class="muted">Daily Rounds Photos template not found — check HSChecklistTemplates has a Security row with RoundBased=TRUE.</p>`; return; }
    const items = itemsCache.filter(i => i.TemplateID === template.TemplateID).sort((a, b) => (parseInt(a.SeqNo, 10) || 0) - (parseInt(b.SeqNo, 10) || 0));
    let logs, results;
    try {
      const logRows = await MVOA.sheetsRead(MVOA.TABS.hsLog);
      logs = rowsToObjs(logRows, LOG_COLS).filter(l => l.TemplateID === template.TemplateID);
      const resultRows = await MVOA.sheetsRead(MVOA.TABS.hsItemResults);
      results = rowsToObjs(resultRows, RESULT_COLS);
    } catch (e) {
      bodyEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const days = [];
    for (let i = 0; i < 7; i++) days.push(new Date(weeklyRoundsWeekStart.getTime() + i * 86400000));
    bodyEl.innerHTML = days.map(d => {
      const dayLogs = logs.filter(l => new Date(l.Timestamp).toDateString() === d.toDateString());
      const roundsHtml = activeRoundKeys().map(round => {
        const log = dayLogs.find(l => l.Shift === round);
        const roundLabel = shiftLabel(round);
        if (!log) return `<div style="margin:6px 0;"><strong>${roundLabel}:</strong> <span class="muted">Not logged</span></div>`;
        const itemsHtml = items.map(item => {
          const r = results.find(rr => rr.LogID === log.LogID && rr.ItemID === item.ItemID);
          const remarks = r ? r.Remarks : '';
          const photoUrl = photoUrlFromRemarks(remarks);
          const loc = locationFromRemarks(remarks);
          return `<div style="margin:2px 0 2px 12px;font-size:0.85rem;">${escapeHtml(item.CheckItem)}${loc ? ' — ' + escapeHtml(loc) : ''}: ${photoUrl ? `<a href="${escapeHtml(photoUrl)}" target="_blank" rel="noopener">📷 View photo</a>` : '<span style="color:#b3261e;">No photo — Fail</span>'}</div>`;
        }).join('');
        return `<div style="margin:6px 0;"><strong>${roundLabel}</strong> <span class="muted">— ${escapeHtml(log.PerformedBy)}</span>${itemsHtml}</div>`;
      }).join('');
      return `
        <div class="card" style="margin:0 0 12px;">
          <h4 style="margin:0 0 6px;color:var(--mvoa-blue);">${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</h4>
          ${roundsHtml}
        </div>
      `;
    }).join('');
  }

  // ───────────────────────────────────────────────────────────
  // IN/OUT MONTHLY REPORT — a richer view than the generic Monthly
  // Report matrix (which can't show CustomScreen data at all, since
  // In/Out Log doesn't write to HSChecklistLog/HSChecklistItemResults —
  // it has its own dedicated HSInOutLog sheet). One section per type
  // (Sewage/Garbage/Water Tanker/Garden Waste), every entry for the
  // chosen month with its time and a link to the photo where one was
  // taken (Sewage/Water Tanker require one; Garbage/Garden Waste don't).
  // ───────────────────────────────────────────────────────────
  let inOutMonthlyMonth = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; })();

  function renderInOutMonthlyReport(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>🚚 In/Out Monthly Report</strong>
      </div>
      <div class="mvoa-row" style="margin-bottom:12px;gap:8px;">
        <label class="muted">Month: <input id="hs-inout-month" type="month" value="${inOutMonthlyMonth}"></label>
      </div>
      <div id="hs-inout-monthly-body" style="overflow-x:auto;-webkit-overflow-scrolling:touch;"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));
    container.querySelector('#hs-inout-month').addEventListener('change', (e) => {
      inOutMonthlyMonth = e.target.value;
      loadInOutMonthlyBody(container);
    });
    loadInOutMonthlyBody(container);
  }

  // Same matrix shape as the Rounds Monthly Report — one row per day,
  // one column-group per Type (Sewage/Garbage/Water Tanker/Garden
  // Waste), 2 sub-columns per group (In/Out). Photo-required types
  // (Sewage, Water Tanker — see IN_OUT_TYPES.needsPhoto) show a photo
  // link + time per entry; the other two show time only, since they
  // never have a photo to show. A cell can hold more than one entry a
  // day (e.g. two IN/OUT cycles), stacked — unlike Rounds, which is
  // capped at one submission per round per day.
  async function loadInOutMonthlyBody(container) {
    const bodyEl = container.querySelector('#hs-inout-monthly-body');
    if (!bodyEl) return;
    let logs;
    try {
      const rows = await MVOA.sheetsRead(TAB_HS_INOUT_LOG);
      logs = rowsToObjs(rows, INOUT_LOG_COLS).filter(l => (l.Timestamp || '').startsWith(inOutMonthlyMonth));
    } catch (e) {
      bodyEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const [y, mo] = inOutMonthlyMonth.split('-').map(Number);
    const daysInMonth = new Date(y, mo, 0).getDate();
    const DIVIDER = 'border-right:2px solid #999;';
    const DIRECTIONS = ['IN', 'OUT'];

    const headerGroupCells = IN_OUT_TYPES.map((t, gi) => `<th colspan="2" style="padding:4px 6px;text-align:center;border-bottom:1px solid #ccc;${gi < IN_OUT_TYPES.length - 1 ? DIVIDER : ''}">${escapeHtml(t.key)}</th>`).join('');
    const headerDirCells = IN_OUT_TYPES.map((t, gi) => DIRECTIONS.map((d, di) => `<th style="padding:4px 6px;font-size:0.75rem;text-align:center;${di === 1 && gi < IN_OUT_TYPES.length - 1 ? DIVIDER : ''}">${d}</th>`).join('')).join('');

    const bodyRows = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${inOutMonthlyMonth}-${String(day).padStart(2, '0')}`;
      const dayLogs = logs.filter(l => (l.Timestamp || '').startsWith(dateStr));
      const cells = IN_OUT_TYPES.map((t, gi) => DIRECTIONS.map((dir, di) => {
        const divider = (di === 1 && gi < IN_OUT_TYPES.length - 1) ? DIVIDER : '';
        const entries = dayLogs.filter(l => l.Type === t.key && l.Direction === dir).sort((a, b) => a.Timestamp.localeCompare(b.Timestamp));
        if (!entries.length) return `<td style="padding:4px 6px;text-align:center;color:#ccc;${divider}">—</td>`;
        const linesHtml = entries.map(e => {
          const timeStr = new Date(e.Timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          // No photo icon at all for non-photo types — showing a ✕ would
          // wrongly read as a Fail when a photo was never required here.
          return t.needsPhoto
            ? `<div>${e.PhotoURL ? `<a href="${escapeHtml(e.PhotoURL)}" target="_blank" rel="noopener">📷</a>` : '<span style="color:#b3261e;">✕</span>'} <span class="muted" style="font-size:0.7rem;">${timeStr}</span></div>`
            : `<div class="muted" style="font-size:0.75rem;">${timeStr}</div>`;
        }).join('');
        return `<td style="padding:4px 6px;text-align:center;${divider}">${linesHtml}</td>`;
      }).join('')).join('');
      bodyRows.push(`<tr><td style="padding:4px 6px;font-weight:600;white-space:nowrap;position:sticky;left:0;background:#fff;">${day}</td>${cells}</tr>`);
    }

    bodyEl.innerHTML = `
      <table class="mvoa-table" style="border-collapse:collapse;">
        <thead>
          <tr><th rowspan="2" style="padding:4px 6px;position:sticky;left:0;background:#fff;">Date</th>${headerGroupCells}</tr>
          <tr>${headerDirCells}</tr>
        </thead>
        <tbody>${bodyRows.join('')}</tbody>
      </table>
    `;
  }

  // ───────────────────────────────────────────────────────────
  // INSPECTION SCHEDULE — a pure overview: which frequencies apply to
  // which category, with no item-level detail at all. Derived entirely
  // from existing HSCategories/HSChecklistTemplates — adding, removing,
  // or re-timing a template automatically updates this, no separate
  // data to maintain.
  // ───────────────────────────────────────────────────────────
  function renderInspectionSchedule(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>🗂️ Inspection Schedule</strong>
        <button id="hs-schedule-pdf" class="btn-secondary">🖨 Print to PDF</button>
      </div>
      <p class="muted" style="margin:0 0 12px;">Which frequency applies to each equipment/category — no item-level detail, just the cadence.</p>
      <div style="overflow-x:auto;">
        <table class="mvoa-table" style="table-layout:fixed;width:100%;">
          <thead><tr>
            <th style="width:220px;text-align:left;">Equipment / Category</th>
            <th style="text-align:center;">Daily</th><th style="text-align:center;">Weekly</th><th style="text-align:center;">Monthly</th><th style="text-align:center;">Bi-Monthly</th>
          </tr></thead>
          <tbody id="hs-schedule-body"></tbody>
        </table>
      </div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));

    const rows = categoriesCache.map(c => {
      const cellFor = (freq) => {
        const t = templatesCache.find(t => t.QRTarget === c.CategoryKey && t.Frequency === freq);
        return t ? frequencyRuleText(t) || '✓' : '';
      };
      return { label: c.Label, group: c.Group || '', Daily: cellFor('Daily'), Weekly: cellFor('Weekly'), Monthly: cellFor('Monthly'), BiMonthly: cellFor('BiMonthly') };
    });

    const cellHtml = (val) => val ? `<span style="color:green;font-weight:700;">✓</span><br><span class="muted" style="font-size:0.72rem;">${escapeHtml(val === '✓' ? '' : val)}</span>` : '<span class="muted">—</span>';
    container.querySelector('#hs-schedule-body').innerHTML = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.label)}${r.group ? `<br><span class="muted" style="font-size:0.72rem;">${escapeHtml(r.group)}</span>` : ''}</td>
        <td style="text-align:center;">${cellHtml(r.Daily)}</td>
        <td style="text-align:center;">${cellHtml(r.Weekly)}</td>
        <td style="text-align:center;">${cellHtml(r.Monthly)}</td>
        <td style="text-align:center;">${cellHtml(r.BiMonthly)}</td>
      </tr>
    `).join('');

    container.querySelector('#hs-schedule-pdf').addEventListener('click', () => {
      const pdfRows = rows.map(r => ({
        Category: r.label + (r.group ? ` (${r.group})` : ''),
        Daily: r.Daily ? '✓' : '—', Weekly: r.Weekly || '—', Monthly: r.Monthly || '—', BiMonthly: r.BiMonthly || '—'
      }));
      printTablePdf('Inspection Schedule', ['Category', 'Daily', 'Weekly', 'Monthly', 'BiMonthly'], pdfRows);
    });
  }

  // ───────────────────────────────────────────────────────────
  // DG RUNNING HOURS — the meter reading logged each shift is
  // cumulative, not "hours run this shift". This computes actual
  // hours run per shift as the difference to the NEXT chronological
  // reading (so Shift 1's hours = Shift 2's reading minus Shift 1's;
  // Shift 3's hours = the following day's Shift 1 reading minus
  // today's Shift 3 reading) — same logic regardless of which shift,
  // since it's just "next reading minus this one" in time order.
  // ───────────────────────────────────────────────────────────
  async function renderRunningHoursReport(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>⏱️ DG Running Hours</strong>
        <button id="hs-hours-pdf" class="btn-secondary">🖨 Print to PDF</button>
      </div>
      <div id="hs-hours-list"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));

    const listEl = container.querySelector('#hs-hours-list');
    const item = itemsCache.find(i => /running hours/i.test(i.CheckItem));
    if (!item) {
      listEl.innerHTML = '<p class="muted">No running-hours meter item is configured yet.</p>';
      return;
    }
    let results;
    try {
      results = await loadItemResults();
    } catch (e) {
      listEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const readings = results
      .filter(r => r.ItemID === item.ItemID)
      .map(r => {
        const log = logsCache.find(l => l.LogID === r.LogID);
        return log ? { value: parseFloat(r.Result), timestamp: log.Timestamp, shift: log.Shift, performedBy: log.PerformedBy } : null;
      })
      .filter(x => x && !isNaN(x.value))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (!readings.length) {
      listEl.innerHTML = '<p class="muted">No readings logged yet.</p>';
      return;
    }
    const rows = readings.map((r, i) => {
      const next = readings[i + 1];
      const hoursRun = next ? Math.round((next.value - r.value) * 100) / 100 : null;
      return Object.assign({}, r, { hoursRun });
    }).reverse(); // most recent first

    listEl.innerHTML = `
      <div class="card" style="max-width:600px;margin:0;overflow-x:auto;">
        <table class="mvoa-table">
          <thead><tr><th>Date</th><th>Shift</th><th>Reading</th><th>Hours Run</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${formatDate(r.timestamp)}</td>
                <td>${shiftLabel(r.shift)}</td>
                <td>${r.value}</td>
                <td>${r.hoursRun !== null ? r.hoursRun : '<span class="muted">— (awaiting next reading)</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    container.querySelector('#hs-hours-pdf').addEventListener('click', () => {
      const pdfRows = rows.map(r => ({
        Date: formatDate(r.timestamp), Shift: shiftLabel(r.shift), Reading: r.value,
        HoursRun: r.hoursRun !== null ? r.hoursRun : 'awaiting next reading'
      }));
      printTablePdf('DG Running Hours', ['Date', 'Shift', 'Reading', 'HoursRun'], pdfRows);
    });
  }

  // ───────────────────────────────────────────────────────────
  // MONTHLY REPORT — pick a Category, then a Frequency (only the ones
  // that category actually has — e.g. Weekly/Monthly are separate
  // reports from Daily, not combined), then a Month. Shows a full
  // item × date matrix — dates across the top, checklist items down
  // the side (grouped into 1st/2nd/3rd shift sections for shift-based
  // Daily templates, matching what "View Details" shows per round,
  // just laid out across a whole month instead of one round at a time).
  // ───────────────────────────────────────────────────────────
  let monthlyReportCategory = '';
  let monthlyReportTemplateId = '';
  let monthlyReportMonth = ''; // 'YYYY-MM', defaults to current month on first render

  function renderMonthlyReport(container) {
    if (!monthlyReportMonth) {
      const now = new Date();
      monthlyReportMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>📅 Monthly Report</strong>
      </div>
      <div class="card" style="max-width:600px;margin:0 0 12px 0;">
        <label>Category
          <select id="hs-monthly-category">
            <option value="">— Select —</option>
            ${categoriesCache.map(c => `<option value="${c.CategoryKey}" ${monthlyReportCategory===c.CategoryKey?'selected':''}>${escapeHtml(c.Label)}</option>`).join('')}
          </select>
        </label>
        <label>Checklist
          <select id="hs-monthly-template"><option value="">— Select a category first —</option></select>
        </label>
        <label>Month
          <input type="month" id="hs-monthly-picker" value="${monthlyReportMonth}">
        </label>
      </div>
      <div id="hs-monthly-table"></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));

    const templateSelect = container.querySelector('#hs-monthly-template');
    function populateTemplateOptions() {
      const available = templatesCache.filter(t => t.QRTarget === monthlyReportCategory && !t.CustomScreen).sort((a, b) => FREQUENCY_ORDER.indexOf(a.Frequency) - FREQUENCY_ORDER.indexOf(b.Frequency));
      if (!available.length) {
        templateSelect.innerHTML = '<option value="">No templates for this category</option>';
        monthlyReportTemplateId = '';
        return;
      }
      templateSelect.innerHTML = available.map(t => `<option value="${t.TemplateID}" ${monthlyReportTemplateId===t.TemplateID?'selected':''}>${escapeHtml(t.Name)}</option>`).join('');
      if (!available.some(t => t.TemplateID === monthlyReportTemplateId)) monthlyReportTemplateId = available[0].TemplateID;
      templateSelect.value = monthlyReportTemplateId;
    }
    if (monthlyReportCategory) populateTemplateOptions();

    container.querySelector('#hs-monthly-category').addEventListener('change', (e) => {
      monthlyReportCategory = e.target.value;
      monthlyReportTemplateId = '';
      populateTemplateOptions();
      renderMonthlyMatrix(container.querySelector('#hs-monthly-table'));
    });
    templateSelect.addEventListener('change', (e) => {
      monthlyReportTemplateId = e.target.value;
      renderMonthlyMatrix(container.querySelector('#hs-monthly-table'));
    });
    container.querySelector('#hs-monthly-picker').addEventListener('change', (e) => {
      monthlyReportMonth = e.target.value;
      renderMonthlyMatrix(container.querySelector('#hs-monthly-table'));
    });
    renderMonthlyMatrix(container.querySelector('#hs-monthly-table'));
  }

  async function renderMonthlyMatrix(tableEl) {
    if (!monthlyReportCategory || !monthlyReportTemplateId) {
      tableEl.innerHTML = '<p class="muted">Choose a category and checklist to see its monthly matrix.</p>';
      return;
    }
    const template = templateById(monthlyReportTemplateId);
    if (!template) {
      tableEl.innerHTML = '<p class="muted">No template found for this category/checklist.</p>';
      return;
    }
    tableEl.innerHTML = '<p class="muted">Loading…</p>';
    let results;
    try {
      results = await loadItemResults();
    } catch (e) {
      tableEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }

    const [year, month] = monthlyReportMonth.split('-').map(Number); // month is 1-based
    const daysInMonth = new Date(year, month, 0).getDate();
    const isShiftBased = template.ShiftBased === 'TRUE' || template.ShiftBased === 'true';
    const isRoundBased = template.RoundBased === 'TRUE' || template.RoundBased === 'true';
    // Without this, a RoundBased template would fall into the [null]
    // case below and cellFor() would silently grab whichever of
    // Round1/Round2 happened to match first for a given date, hiding
    // the other round's data entirely — Round1/Round2 work as drop-in
    // values everywhere else (cellFor/performedByFor just compare
    // l.Shift === shift generically), so grouping by them here is a
    // one-line fix, not a deeper change.
    const shifts = isShiftBased ? ['1st', '2nd', '3rd'] : isRoundBased ? activeRoundKeys() : [null];
    const items = itemsCache.filter(i => i.TemplateID === template.TemplateID).sort((a, b) => (parseInt(a.SeqNo, 10) || 0) - (parseInt(b.SeqNo, 10) || 0));

    function cellFor(itemId, day, shift) {
      const dateStr = new Date(year, month - 1, day).toDateString();
      const log = logsCache.find(l => l.TemplateID === template.TemplateID &&
        new Date(l.Timestamp).toDateString() === dateStr &&
        (!shift || l.Shift === shift || (l.Shift === '2nd3rd' && (shift === '2nd' || shift === '3rd'))));
      if (!log) return null;
      const result = results.find(r => r.LogID === log.LogID && r.ItemID === itemId) || null;
      if (!result) return null;
      // Carry the log's Overall Notes along with the result — used by
      // AssetList cells so an empty "nothing to report" entry (e.g. all
      // street lights working) can still show what the technician wrote
      // ("All OK") instead of a bare dash.
      return Object.assign({}, result, { _logNotes: log.Notes || '' });
    }
    // Numeric items store the auto-evaluated Pass/Fail as Result, with
    // the actual entered number embedded in Remarks ("Entered: 87% (fails
    // if below 40%)" or "Recorded: 5.5hrs" for threshold-less fields) —
    // extract that number so the real reading shows in the report, not
    // just a bare Pass/Fail.
    function numericDisplayValue(item, resultObj) {
      const match = (resultObj.Remarks || '').match(/[-\d.]+/);
      return match ? match[0] + (item.Unit || '') : (resultObj.Result || '');
    }
    function cellHtml(item, resultObj) {
      if (!resultObj) return '<span class="muted">—</span>';
      if (item.InputType === 'Numeric') {
        const hasThreshold = item.FailThreshold !== '' && item.FailThreshold !== undefined;
        const displayVal = numericDisplayValue(item, resultObj);
        const isRecheck = (resultObj.Remarks || '').includes('[RECHECK-CONFIRMED]');
        if (isRecheck) {
          // Confirmed-outlier — deliberately its own amber styling, distinct
          // from both Pass (green) and Fail (red): this value wasn't a
          // functional failure, but the technician had to confirm it past
          // a ±20% plausibility warning, so it still needs a second look.
          return `<span style="white-space:nowrap;font-size:0.72rem;color:#b8860b;font-weight:700;">⚠️ ${escapeHtml(displayVal)}</span>`;
        }
        if (!hasThreshold) return `<span style="white-space:nowrap;font-size:0.72rem;">${escapeHtml(displayVal)}</span>`; // plain data log — no pass/fail meaning, no coloring
        const isFail = resultObj.Result === 'Fail';
        return `<span style="white-space:nowrap;font-size:0.72rem;color:${isFail ? '#b3261e' : 'green'};font-weight:700;">${escapeHtml(displayVal)}</span>`;
      }
      if (item.InputType === 'AssetList') {
        // Each asset code (e.g. "MVOA-EL-SL-001-68") must stay on one line;
        // multiple entries stack as separate lines within the same cell
        // rather than wrapping mid-code.
        const entries = String(resultObj.Result || '').split(';').map(s => s.trim()).filter(Boolean);
        if (!entries.length) {
          // Nothing reported — show the technician's Overall Notes for
          // that shift/day if they wrote one (e.g. "All OK"), so an
          // all-clear day isn't indistinguishable from "not checked".
          const notes = (resultObj._logNotes || '').trim();
          return notes ? `<span class="muted" style="font-size:0.68rem;white-space:normal;">${escapeHtml(notes)}</span>` : '<span class="muted">—</span>';
        }
        return entries.map(e => `<span style="display:block;white-space:nowrap;font-size:0.62rem;line-height:1.3;">${escapeHtml(e)}</span>`).join('');
      }
      if (resultObj.Result === 'Fail') return '<span style="color:#b3261e;font-weight:700;">✕</span>';
      if (resultObj.Result === 'Pass') return '<span style="color:green;font-weight:700;">✓</span>';
      return escapeHtml(String(resultObj.Result)); // Text/Dropdown
    }
    function cellPdfValue(item, resultObj) {
      if (!resultObj) return '';
      if (item.InputType === 'Numeric') {
        const isRecheck = (resultObj.Remarks || '').includes('[RECHECK-CONFIRMED]');
        return (isRecheck ? '⚠️ RECHECK ' : '') + numericDisplayValue(item, resultObj);
      }
      if (item.InputType === 'AssetList' && !String(resultObj.Result || '').trim()) return resultObj._logNotes || '';
      return resultObj.Result || '';
    }
    function performedByFor(day, shift) {
      const dateStr = new Date(year, month - 1, day).toDateString();
      const log = logsCache.find(l => l.TemplateID === template.TemplateID &&
        new Date(l.Timestamp).toDateString() === dateStr &&
        (!shift || l.Shift === shift || (l.Shift === '2nd3rd' && (shift === '2nd' || shift === '3rd'))));
      return log ? log.PerformedBy : '';
    }
    function notesFor(day, shift) {
      const dateStr = new Date(year, month - 1, day).toDateString();
      const log = logsCache.find(l => l.TemplateID === template.TemplateID &&
        new Date(l.Timestamp).toDateString() === dateStr &&
        (!shift || l.Shift === shift || (l.Shift === '2nd3rd' && (shift === '2nd' || shift === '3rd'))));
      return log ? (log.Notes || '') : '';
    }

    const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => i + 1);
    let bodyHtml = '';
    const pdfRows = [];
    shifts.forEach(shift => {
      if (shift) {
        bodyHtml += `<tr><td colspan="${daysInMonth + 1}" style="background:var(--card-bg);font-weight:700;">${shiftLabel(shift)} Shift</td></tr>`;
        const sectionRow = { Item: '— ' + shiftLabel(shift) + ' Shift —' };
        dayHeaders.forEach(d => sectionRow[String(d)] = '');
        pdfRows.push(sectionRow);
      }
      const performedByCells = dayHeaders.map(d => performedByFor(d, shift));
      bodyHtml += `<tr><td style="font-style:italic;white-space:normal;word-wrap:break-word;">Performed By</td>${performedByCells.map(v => `<td class="muted" style="font-size:0.8rem;word-wrap:break-word;white-space:normal;">${v ? escapeHtml(v) : '—'}</td>`).join('')}</tr>`;
      const performedByRow = { Item: 'Performed By' };
      dayHeaders.forEach((d, i) => performedByRow[String(d)] = performedByCells[i] || '');
      pdfRows.push(performedByRow);

      items.forEach(item => {
        const cells = dayHeaders.map(d => cellFor(item.ItemID, d, shift));
        bodyHtml += `<tr><td style="white-space:normal;word-wrap:break-word;">${escapeHtml(item.CheckItem)}</td>${cells.map(v => `<td style="word-wrap:break-word;white-space:normal;">${cellHtml(item, v)}</td>`).join('')}</tr>`;
        const pdfRow = { Item: item.CheckItem };
        dayHeaders.forEach((d, i) => pdfRow[String(d)] = cellPdfValue(item, cells[i]));
        pdfRows.push(pdfRow);
      });

      // Overall Notes — free text entered on submission, one per
      // log/day/shift, not tied to any single item. Shown as its own
      // row under every category's matrix here (same lookup shape as
      // Performed By, just reading Notes instead) — previously this
      // only surfaced in Full History's per-entry drill-down.
      const notesCells = dayHeaders.map(d => notesFor(d, shift));
      bodyHtml += `<tr><td style="font-style:italic;white-space:normal;word-wrap:break-word;">Overall Notes</td>${notesCells.map(v => `<td class="muted" style="font-size:0.72rem;word-wrap:break-word;white-space:normal;">${v ? escapeHtml(v) : '—'}</td>`).join('')}</tr>`;
      const notesRow = { Item: 'Overall Notes' };
      dayHeaders.forEach((d, i) => notesRow[String(d)] = notesCells[i] || '');
      pdfRows.push(notesRow);
    });

    tableEl.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:8px;">
        <p class="muted" style="margin:0;">${escapeHtml(categoryLabel(monthlyReportCategory))} — ${escapeHtml(template.Name)}</p>
        <button id="hs-monthly-pdf" class="btn-secondary">🖨 Print to PDF</button>
      </div>
      <div class="card" style="max-width:100%;margin:0;overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table class="mvoa-table" style="table-layout:fixed;">
          <thead><tr><th style="width:160px;word-wrap:break-word;">Item</th>${dayHeaders.map(d => `<th style="width:100px;word-wrap:break-word;white-space:normal;">${d}</th>`).join('')}</tr></thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>
    `;
    tableEl.querySelector('#hs-monthly-pdf').addEventListener('click', () => {
      const pdfColumns = ['Item', ...dayHeaders.map(String)];
      const title = `Monthly Report — ${categoryLabel(monthlyReportCategory)} — ${template.Name} — ${monthlyReportMonth}`;
      printTablePdf(title, pdfColumns, pdfRows);
    });
  }

  // ───────────────────────────────────────────────────────────
  // DUE STATUS DASHBOARD — every template's status at a glance,
  // without needing to scan first. Informational only: tapping a
  // card here does NOT open the entry form, since actual logging is
  // meant to happen at the equipment (verified via QR scan) — this
  // is just for checking what needs attention from anywhere.
  // ───────────────────────────────────────────────────────────
  function renderDueDashboard(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
        <strong>📊 Due Status</strong>
      </div>
      <div class="mvoa-row" style="margin-bottom:10px;">
        <p class="muted" style="margin:0;">Overdue items are listed first. Scan the equipment QR to actually log a checklist.</p>
        <button id="hs-due-pdf" class="btn-secondary">🖨 Print to PDF</button>
      </div>
      <div id="hs-due-groups"></div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));

    const groupsEl = container.querySelector('#hs-due-groups');
    const user = MVOA.getUser();
    const groups = categoriesCache.map(c => c.CategoryKey)
      .filter(target => MVOA.canViewPlantRoundsSection(target, user))
      .map(target => {
        const rows = templatesCache
          .filter(t => t.QRTarget === target)
          .flatMap(t => {
            // CustomScreen templates (e.g. In/Out Log) don't write to HSLog
            // at all, so dueInfo() would show "Never logged"/"Due" forever
            // regardless of real activity — same reasoning as the checklist
            // picker screen's identical special-case. Shown as an ongoing
            // log here too, consistent with that screen.
            if (t.CustomScreen) return [{ template: t, due: { overdue: false, text: 'Ongoing log — see In/Out Monthly Report for activity' }, assetLabel: '' }];
            // Per-asset expansion — a template shared by multiple physical
            // units (e.g. 18 Distribution Panels, each scanned separately)
            // shows one row per unit rather than one row for the whole
            // template. Combines the pre-registered master list (HSCategoryAssets,
            // if present — so a never-scanned unit still shows up as overdue)
            // with any AssetID actually seen in the logs (covers a unit
            // scanned before it was added to the master list, if ever).
            const registeredIds = categoryAssetsCache.filter(a => a.CategoryKey === t.QRTarget).map(a => a.AssetID);
            const loggedIds = [...new Set(logsCache.filter(l => l.TemplateID === t.TemplateID && l.AssetID).map(l => l.AssetID))];
            const assetIds = [...new Set([...registeredIds, ...loggedIds])];
            if (!assetIds.length) return [{ template: t, due: dueInfo(t), assetLabel: '' }];
            return assetIds.map(aid => {
              const registered = categoryAssetsCache.find(a => a.CategoryKey === t.QRTarget && a.AssetID === aid);
              const sample = logsCache.find(l => l.TemplateID === t.TemplateID && l.AssetID === aid);
              const label = (registered && registered.AssetLabel) || (sample && sample.AssetName) || aid;
              return { template: t, due: dueInfo(t, aid), assetLabel: label };
            });
          })
          .sort((a, b) => {
            if (a.due.overdue !== b.due.overdue) return a.due.overdue ? -1 : 1;
            return FREQUENCY_ORDER.indexOf(a.template.Frequency) - FREQUENCY_ORDER.indexOf(b.template.Frequency);
          });
        return { target, rows };
      });
    if (!groups.length) {
      groupsEl.innerHTML = '<p class="muted">You don\'t have access to any Plant Rounds categories yet.</p>';
      return;
    }
    container.querySelector('#hs-due-pdf').addEventListener('click', () => {
      const pdfRows = [];
      groups.forEach(g => g.rows.forEach(r => pdfRows.push({
        Category: categoryLabel(g.target), Template: r.template.Name + (r.assetLabel ? ` (${r.assetLabel})` : ''), Frequency: FREQUENCY_LABEL[r.template.Frequency],
        Status: r.due.overdue ? 'Due' : 'Up to date', Detail: r.due.text
      })));
      printTablePdf('Due Status', ['Category', 'Template', 'Frequency', 'Status', 'Detail'], pdfRows);
    });

    groupsEl.innerHTML = groups.map(g => `
      <div class="card" style="max-width:600px;margin:0 0 16px 0;">
        <h3 style="margin:0 0 10px;color:var(--mvoa-blue);">${escapeHtml(categoryLabel(g.target))}</h3>
        ${g.rows.map(r => `
          <div class="mvoa-row" style="padding:6px 0;border-bottom:1px solid var(--border);">
            <span>${escapeHtml(r.template.Name)}${r.assetLabel ? `<br><span class="muted" style="font-size:0.75rem;">${escapeHtml(r.assetLabel)}</span>` : ''}</span>
            <span style="text-align:right;">
              ${r.due.overdue ? '<span style="color:#b3261e;font-weight:700;font-size:0.85rem;">⚠️ Due</span>' : '<span class="muted" style="font-size:0.85rem;">Up to date</span>'}
              <br><span class="muted" style="font-size:0.75rem;">${escapeHtml(r.due.text)}</span>
            </span>
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  function templateById(id) { return templatesCache.find(t => t.TemplateID === id); }

  function logCardHtml(l) {
    const t = templateById(l.TemplateID);
    const flagged = l.Status === 'Flagged';
    return `
      <div class="mvoa-list-item" data-log-id="${l.LogID}">
        <div class="mvoa-row">
          <strong>${escapeHtml(t ? categoryLabel(t.QRTarget) + ' — ' + FREQUENCY_LABEL[t.Frequency] : l.TemplateID)}</strong>
          ${flagged ? MVOA.statusBadgeHtml('Critical') : MVOA.statusBadgeHtml('Approved')}
        </div>
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">By ${escapeHtml(l.PerformedBy)} · ${formatDate(l.Timestamp)}${l.Shift ? ' · Shift: ' + shiftLabel(l.Shift) : ''}</p>
        ${l.Notes ? `<p class="muted" style="margin:4px 0;font-size:0.85rem;">${escapeHtml(l.Notes)}</p>` : ''}
        <button class="hs-logcard-toggle btn-secondary" data-log-id="${l.LogID}" style="font-size:0.8rem;padding:4px 10px;margin-top:4px;">▸ View Details</button>
        <div class="hs-logcard-details hidden" data-log-id="${l.LogID}"></div>
      </div>
    `;
  }

  async function renderLogDetails(detailsEl, logId) {
    detailsEl.innerHTML = '<p class="muted" style="font-size:0.8rem;padding-top:6px;">Loading…</p>';
    let results;
    try {
      results = await loadItemResults();
    } catch (e) {
      detailsEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const rows = results.filter(r => r.LogID === logId);
    detailsEl.innerHTML = rows.length ? rows.map(r => {
      const item = itemsCache.find(i => i.ItemID === r.ItemID);
      const resultHtml = r.Result === 'Fail' ? '<span style="color:#b3261e;font-weight:700;">✕ Fail</span>'
        : r.Result === 'Pass' ? '<span style="color:green;font-weight:700;">✓ Pass</span>'
        : escapeHtml(r.Result);
      return `
        <div style="padding:5px 0;border-top:1px solid var(--border);">
          <div class="mvoa-row"><span style="font-size:0.9rem;">${escapeHtml(item ? item.CheckItem : r.ItemID)}</span><span style="font-size:0.85rem;">${resultHtml}</span></div>
          ${r.Remarks ? `<p class="muted" style="font-size:0.8rem;margin:2px 0;">${escapeHtml(r.Remarks)}</p>` : ''}
        </div>
      `;
    }).join('') : '<p class="muted" style="font-size:0.8rem;padding-top:6px;">No item results found for this round.</p>';
  }

  function wireLogCardDrilldowns(scope) {
    scope.querySelectorAll('.hs-logcard-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const logId = btn.dataset.logId;
        const details = scope.querySelector(`.hs-logcard-details[data-log-id="${logId}"]`);
        const isHidden = details.classList.contains('hidden');
        if (!isHidden) { details.classList.add('hidden'); btn.textContent = '▸ View Details'; return; }
        details.classList.remove('hidden');
        btn.textContent = '▾ Hide Details';
        renderLogDetails(details, logId);
      });
    });
  }

  function shiftLabel(s) {
    if (s === '2nd3rd') return '2nd & 3rd'; // kept for reading old log entries only — no longer written
    const win = roundWindowsCache.find(r => r.RoundKey === s);
    if (win) return `${win.Label || s} (${roundWindowLabel(s)})`;
    return s;
  }

  // ───────────────────────────────────────────────────────────
  // QR SCANNER — same jsQR-based approach as Daily Ops, decoded via
  // the shared MVOA.parseAssetQR(). The category is looked up from
  // HSCategories.QRMatchKeyword (case-insensitive substring match
  // against the scanned Category/AssetName/AssetID) — adding a new
  // category is a pure data change, no code change needed. Returns
  // null if nothing matches, rather than guessing a default — an
  // unrecognized scan should say so, not silently open the wrong
  // equipment's checklist.
  // ───────────────────────────────────────────────────────────
  function inferQrTarget(parsed) {
    const haystack = ((parsed.category || '') + ' ' + (parsed.assetName || '') + ' ' + (parsed.assetId || '')).toLowerCase();
    const match = categoriesCache.find(c => c.QRMatchKeyword && haystack.indexOf(c.QRMatchKeyword.toLowerCase()) !== -1);
    return match ? match.CategoryKey : null;
  }

  // Standalone scanner used only by AssetList entries to grab a single
  // asset ID (e.g. a specific street light's QR) — unlike openQrScanner,
  // this doesn't try to match against any category, it just returns
  // whatever asset ID was scanned (or null if cancelled).
  function scanAssetIdOnly() {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'ops-qr-modal';
      modal.innerHTML = `
        <div class="ops-qr-box">
          <video id="hs-al-qr-video" autoplay playsinline muted></video>
          <canvas id="hs-al-qr-canvas" style="display:none;"></canvas>
          <p class="muted" id="hs-al-qr-status">Point camera at the light's QR label…</p>
          <button id="hs-al-qr-cancel" class="btn-secondary">Cancel</button>
        </div>
      `;
      document.body.appendChild(modal);
      const video = modal.querySelector('#hs-al-qr-video');
      const canvas = modal.querySelector('#hs-al-qr-canvas');
      const statusEl = modal.querySelector('#hs-al-qr-status');
      let stream, raf;
      function stop(result) {
        if (raf) cancelAnimationFrame(raf);
        if (stream) stream.getTracks().forEach(t => t.stop());
        modal.remove();
        resolve(result);
      }
      modal.querySelector('#hs-al-qr-cancel').addEventListener('click', () => stop(null));
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(s => { stream = s; video.srcObject = s; tick(); })
        .catch(e => { statusEl.textContent = 'Camera access failed: ' + e.message; });
      function tick() {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = typeof jsQR === 'function' ? jsQR(img.data, img.width, img.height) : null;
          if (code) {
            const parsed = MVOA.parseAssetQR(code.data);
            if (parsed && parsed.assetId) { stop(parsed.assetId); return; }
            statusEl.innerHTML = `Scanned, but not a recognised MVOA format.<br>Keep trying or cancel.`;
          }
        }
        raf = requestAnimationFrame(tick);
      }
    });
  }

  function openQrScanner(container, expectedCategory) {
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    const expectedLabel = expectedCategory ? categoryLabel(expectedCategory) : null;
    modal.innerHTML = `
      <div class="ops-qr-box">
        <video id="hs-qr-video" autoplay playsinline muted></video>
        <canvas id="hs-qr-canvas" style="display:none;"></canvas>
        <p class="muted" id="hs-qr-status">${expectedLabel ? `Point camera at the ${escapeHtml(expectedLabel)} QR label…` : 'Point camera at the equipment QR label…'}</p>
        <button id="hs-qr-cancel" class="btn-secondary">Cancel</button>
      </div>
    `;
    document.body.appendChild(modal);

    const video = modal.querySelector('#hs-qr-video');
    const canvas = modal.querySelector('#hs-qr-canvas');
    const statusEl = modal.querySelector('#hs-qr-status');
    let stream, raf;

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(t => t.stop());
      modal.remove();
    }
    modal.querySelector('#hs-qr-cancel').addEventListener('click', stop);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(s => { stream = s; video.srcObject = s; tick(); })
      .catch(e => { statusEl.textContent = 'Camera access failed: ' + e.message; });

    function tick() {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = typeof jsQR === 'function' ? jsQR(img.data, img.width, img.height) : null;
        if (code) {
          const parsed = MVOA.parseAssetQR(code.data);
          if (parsed) {
            const qrTarget = inferQrTarget(parsed);
            if (!qrTarget) {
              statusEl.innerHTML = `Scanned "${escapeHtml(parsed.assetName || parsed.assetId)}", but it's not set up for Plant Rounds yet.<br>Keep trying a different label or cancel.`;
            } else if (expectedCategory && qrTarget !== expectedCategory) {
              statusEl.innerHTML = `This is the <strong>${escapeHtml(categoryLabel(qrTarget))}</strong> label, but you selected <strong>${escapeHtml(expectedLabel)}</strong>.<br>Scan the ${escapeHtml(expectedLabel)} label instead, or cancel and pick the right tab.`;
            } else {
              currentScan = Object.assign({}, parsed, { qrTarget });
              stop();
              renderScanResult(container);
              return;
            }
          } else {
            statusEl.innerHTML = `Scanned, but not a recognised MVOA format.<br><span style="font-size:0.75rem;word-break:break-all;">Raw: ${escapeHtml(code.data)}</span><br>Keep trying or cancel.`;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
  }

  // ───────────────────────────────────────────────────────────
  // SCAN RESULT — shows the 4 frequency templates for whichever
  // equipment was scanned, each with a due/last-completed indicator.
  //
  // Due logic is calendar-anchored, not a simple day-count:
  //   Daily    — due if nothing logged yet today.
  //   Weekly   — done every Monday; shows overdue from Tuesday onward
  //              if that week's Monday has no log yet.
  //   Monthly  — done in the last week of the month; overdue starts
  //              showing from the 1st week of the FOLLOWING month if
  //              that window closed with nothing logged. While still
  //              inside the current month's own last week, it shows
  //              as "Due this week" rather than overdue — there's
  //              still time left in the window.
  //   BiMonthly— same shape as Monthly, but the cycle only lands on
  //              odd months starting from July (Jul/Sep/Nov/Jan/Mar/May),
  //              matching the AMC vendor's actual visit schedule.
  // ───────────────────────────────────────────────────────────
  function daysInMonth(y, m0) { return new Date(y, m0 + 1, 0).getDate(); }
  function lastWeekStart(y, m0) { return new Date(y, m0, daysInMonth(y, m0) - 6, 0, 0, 0, 0); }
  function isCycleMonth(m0, interval, anchor0) {
    const diff = m0 - anchor0;
    return (((diff % interval) + interval) % interval) === 0;
  }
  // Walks back from now to find the most recent cycle-month whose
  // last-week window has started (interval=1 for Monthly, every month
  // qualifies; interval=2/anchor0=6(July) for BiMonthly, only
  // odd months qualify).
  function currentOrLastCycleWindow(now, interval, anchor0) {
    let y = now.getFullYear(), m0 = now.getMonth();
    for (let i = 0; i < interval * 14; i++) {
      if (isCycleMonth(m0, interval, anchor0)) {
        const lw = lastWeekStart(y, m0);
        if (lw <= now) return { start: lw, isCurrentMonth: (y === now.getFullYear() && m0 === now.getMonth()) };
      }
      m0--; if (m0 < 0) { m0 = 11; y--; }
    }
    return null;
  }
  function mostRecentMonday(now) {
    const d = new Date(now);
    const day = d.getDay(); // 0=Sun..6=Sat
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function lastLogForTemplate(templateId, assetId) {
    const matches = logsCache.filter(l => l.TemplateID === templateId && (!assetId || l.AssetID === assetId)).sort((a, b) => (b.Timestamp || '').localeCompare(a.Timestamp || ''));
    return matches[0] || null;
  }
  function hasLogSince(templateId, sinceDate, assetId) {
    return logsCache.some(l => l.TemplateID === templateId && (!assetId || l.AssetID === assetId) && new Date(l.Timestamp) >= sinceDate);
  }

  function dueInfo(template, assetId) {
    const last = lastLogForTemplate(template.TemplateID, assetId);
    const lastText = last ? `Last: ${formatDate(last.Timestamp)}` : 'Never logged';
    const now = new Date();

    if (template.Frequency === 'Daily') {
      const doneToday = last && new Date(last.Timestamp).toDateString() === now.toDateString();
      return { text: lastText, overdue: !doneToday };
    }

    if (template.Frequency === 'Weekly') {
      const monday = mostRecentMonday(now);
      const done = hasLogSince(template.TemplateID, monday, assetId);
      if (done) return { text: lastText, overdue: false };
      const isMonday = now.getDay() === 1;
      return isMonday ? { text: 'Due today (Monday)', overdue: false } : { text: `Not done since ${formatDate(monday)}`, overdue: true };
    }

    // Fixed day-of-month window (WindowStartDay/WindowEndDay set on the
    // template) — a generic replacement for the one-off "first week of
    // month" rule: any day range works (Club House: 1–7, this batch:
    // 8–14, etc.) via pure data, no code change per new window shape.
    // Only applies to Monthly; a fresh window starts the moment a new
    // month begins, no need to look back at a previous month at all.
    const winStart = parseInt(template.WindowStartDay, 10);
    const winEnd = parseInt(template.WindowEndDay, 10);
    if (template.Frequency === 'Monthly' && winStart && winEnd) {
      const y = now.getFullYear(), m0 = now.getMonth();
      const windowStart = new Date(y, m0, winStart); windowStart.setHours(0, 0, 0, 0);
      const windowEnd = new Date(y, m0, winEnd); windowEnd.setHours(23, 59, 59, 999);
      const monthStart = new Date(y, m0, 1); monthStart.setHours(0, 0, 0, 0);
      const done = hasLogSince(template.TemplateID, monthStart, assetId);
      if (done) return { text: lastText, overdue: false };
      if (now <= windowEnd) return { text: `Due this week (days ${winStart}-${winEnd} of month)`, overdue: false };
      return { text: `Overdue since ${formatDate(new Date(y, m0, winEnd + 1))}`, overdue: true };
    }

    // Monthly and BiMonthly share the same "last week of a cycle month" shape
    const interval = template.Frequency === 'BiMonthly' ? 2 : 1;
    const anchor0 = 6; // July, 0-based — only relevant when interval=2
    const win = currentOrLastCycleWindow(now, interval, anchor0);
    if (!win) return { text: lastText, overdue: true };
    const done = hasLogSince(template.TemplateID, win.start, assetId);
    if (done) return { text: lastText, overdue: false };
    if (win.isCurrentMonth) return { text: 'Due this week', overdue: false };
    return { text: `Overdue since ${formatDate(win.start)}`, overdue: true };
  }

  function frequencyRuleText(template) {
    if (template.Frequency === 'Weekly') return 'Due every Monday';
    const winStart = parseInt(template.WindowStartDay, 10);
    const winEnd = parseInt(template.WindowEndDay, 10);
    if (template.Frequency === 'Monthly' && winStart && winEnd) return `Due days ${winStart}-${winEnd} of the month`;
    if (template.Frequency === 'Monthly') return 'Due last week of the month';
    if (template.Frequency === 'BiMonthly') return 'Due last week of Jul / Sep / Nov / Jan / Mar / May';
    return ''; // Daily has no interval to state — it's due every day
  }

  function renderScanResult(container) {
    const user = MVOA.getUser();
    const canView = MVOA.canViewPlantRoundsSection(currentScan.qrTarget, user);
    const canEdit = MVOA.canEditPlantRoundsSection(currentScan.qrTarget, user);

    if (!canView) {
      container.innerHTML = `
        <div class="mvoa-row" style="margin-bottom:10px;">
          <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
          <strong>${escapeHtml(categoryLabel(currentScan.qrTarget))}</strong>
        </div>
        <p class="muted">You don't have access to ${escapeHtml(categoryLabel(currentScan.qrTarget))}.</p>
      `;
      container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));
      return;
    }

    // Passive Sunday check for this category's WeeklyOnce items — not
    // awaited, same reasoning as the In/Out Log's weekly check: runs in
    // the background whenever someone opens this category on a Sunday,
    // never blocks rendering the screen itself.
    evaluateWeeklyItemCompliance(currentScan.qrTarget);

    const targetTemplates = templatesCache
      .filter(t => t.QRTarget === currentScan.qrTarget)
      .sort((a, b) => FREQUENCY_ORDER.indexOf(a.Frequency) - FREQUENCY_ORDER.indexOf(b.Frequency));

    const cat = categoryByKey(currentScan.qrTarget);
    const layoutImageHtml = cat && cat.LayoutImage
      ? `<img src="${escapeHtml(cat.LayoutImage)}" alt="${escapeHtml(cat.Label)} layout" style="width:100%;max-width:900px;border-radius:8px;margin-bottom:12px;display:block;">`
      : '';

    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
        <strong>${escapeHtml(categoryLabel(currentScan.qrTarget))}${currentScan.assetName ? ' — ' + escapeHtml(currentScan.assetName) : ''}</strong>
      </div>
      ${layoutImageHtml}
      <p class="muted" style="margin:0 0 12px;">${canEdit ? 'Choose which checklist to log.' : "View only — you don't have edit access here."}</p>
      <div id="hs-template-cards"></div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));

    const cardsEl = container.querySelector('#hs-template-cards');
    if (!targetTemplates.length) {
      cardsEl.innerHTML = `<p class="muted">No checklist templates set up yet for ${escapeHtml(categoryLabel(currentScan.qrTarget))}.</p>`;
      return;
    }
    cardsEl.innerHTML = targetTemplates.map(t => {
      // CustomScreen templates (e.g. In/Out Log) don't write to HSLog at
      // all, so the normal Due/Overdue calculation would show "Never
      // logged" forever — that's misleading for an ongoing log, so skip
      // it entirely rather than let dueInfo() apply here.
      if (t.CustomScreen) {
        return `
          <div class="mvoa-list-item ${canEdit ? 'hs-template-card' : ''}" data-template-id="${t.TemplateID}" style="${canEdit ? 'cursor:pointer;' : ''}">
            <div class="mvoa-row">
              <span><strong>${escapeHtml(t.Name)}</strong></span>
              <span class="muted" style="font-size:0.85rem;">Ongoing log</span>
            </div>
          </div>
        `;
      }
      const due = dueInfo(t);
      const rule = frequencyRuleText(t);
      return `
        <div class="mvoa-list-item ${canEdit ? 'hs-template-card' : ''}" data-template-id="${t.TemplateID}" style="${canEdit ? 'cursor:pointer;' : ''}">
          <div class="mvoa-row">
            <span><strong>${escapeHtml(t.Name)}</strong>${rule ? ` <span class="muted" style="font-size:0.8rem;">(${rule})</span>` : ''}</span>
            ${due.overdue ? '<span style="color:#b3261e;font-weight:700;font-size:0.85rem;">⚠️ Due</span>' : '<span class="muted" style="font-size:0.85rem;">Up to date</span>'}
          </div>
          <p class="muted" style="margin:4px 0;font-size:0.8rem;">${due.text}</p>
        </div>
      `;
    }).join('');
    if (!canEdit) return; // view-only — nothing further to wire up
    cardsEl.querySelectorAll('.hs-template-card').forEach(card => {
      card.addEventListener('click', () => {
        const t = templateById(card.dataset.templateId);
        // A handful of templates don't fit the generic scan→checklist
        // shape at all (e.g. the In/Out Log's continuous multi-entry-
        // per-day log with a weekly rollup) — CustomScreen routes those
        // to their own dedicated render function instead, while still
        // appearing in this same template-card list for discoverability.
        if (t && t.CustomScreen === 'InOutLog') { renderInOutLog(container); return; }
        currentTemplate = t;
        currentShift = '';
        pendingResults = {};
        pendingPerformedBy = MVOA.getUser().name;
        renderChecklistForm(container);
      });
    });
  }

  // ───────────────────────────────────────────────────────────
  // CHECKLIST FILL FORM
  // ───────────────────────────────────────────────────────────
  function hasSubmittedToday(templateId, shift) {
    const today = new Date().toDateString();
    return logsCache.some(l => {
      if (l.TemplateID !== templateId) return false;
      if (new Date(l.Timestamp).toDateString() !== today) return false;
      if (!shift) return true; // non-Daily: no shift concept, just "any log today"
      return l.Shift === shift || (l.Shift === '2nd3rd' && (shift === '2nd' || shift === '3rd'));
    });
  }
  function todaysLogFor(templateId, shift) {
    const today = new Date().toDateString();
    return logsCache.find(l =>
      l.TemplateID === templateId &&
      new Date(l.Timestamp).toDateString() === today &&
      (l.Shift === shift || (l.Shift === '2nd3rd' && (shift === '2nd' || shift === '3rd')))
    ) || null;
  }
  // Shift time windows: 1st 7am-2pm, 2nd 2pm-9pm, 3rd 9pm-7am (wraps
  // past midnight). Entries are only allowed within the matching
  // shift's actual clock window — e.g. 3rd shift can't be logged
  // during the day.
  function isWithinShiftWindow(shift, now) {
    const h = now.getHours() + now.getMinutes() / 60;
    if (shift === '1st') return h >= 7 && h < 14;
    if (shift === '2nd') return h >= 14 && h < 21;
    if (shift === '3rd') return h >= 21 || h < 7;
    return true;
  }
  function shiftWindowLabel(shift) {
    if (shift === '1st') return '7 AM – 2 PM';
    if (shift === '2nd') return '2 PM – 9 PM';
    if (shift === '3rd') return '9 PM – 7 AM';
    return '';
  }
  // Security's "Daily Rounds Photos" doesn't fit the 1st/2nd/3rd shift
  // system at all — two fixed windows, deliberately kept as its own
  // separate mechanic rather than overloading "shift" terminology.
  // Piggybacks on the same Shift column/hasSubmittedToday/todaysLogFor
  // machinery though, since those already just compare arbitrary string
  // values — 'Round1'/'Round2' work as drop-in Shift values with zero
  // changes needed to that generic matching logic.
  function activeRoundKeys() {
    return roundWindowsCache
      .slice()
      .sort((a, b) => (parseInt(a.StartHour, 10) || 0) - (parseInt(b.StartHour, 10) || 0))
      .map(r => r.RoundKey);
  }
  function formatRoundHour(h, m) {
    h = parseInt(h, 10) || 0; m = parseInt(m, 10) || 0;
    const period = h >= 12 ? 'PM' : 'AM';
    let h12 = h % 12; if (h12 === 0) h12 = 12;
    return m ? `${h12}:${String(m).padStart(2, '0')} ${period}` : `${h12} ${period}`;
  }
  function isWithinRoundWindow(round, now) {
    const win = roundWindowsCache.find(r => r.RoundKey === round);
    if (!win) return false; // unknown/disabled round — safe default, matches "not allowed" rather than silently open
    const h = now.getHours() + now.getMinutes() / 60;
    const start = (parseInt(win.StartHour, 10) || 0) + (parseInt(win.StartMinute, 10) || 0) / 60;
    const end = (parseInt(win.EndHour, 10) || 0) + (parseInt(win.EndMinute, 10) || 0) / 60;
    return h >= start && h < end;
  }
  function roundWindowLabel(round) {
    const win = roundWindowsCache.find(r => r.RoundKey === round);
    if (!win) return '';
    return `${formatRoundHour(win.StartHour, win.StartMinute)} – ${formatRoundHour(win.EndHour, win.EndMinute)}`;
  }

  // ───────────────────────────────────────────────────────────
  // Running-hours meter guard — a cumulative meter can never go
  // backwards, so a new reading lower than the last one logged is
  // almost certainly a typo (e.g. 1886.17 instead of 1886.83). This
  // caches the most recent reading per item so it can be checked live
  // as the technician types, before the entry is ever accepted —
  // rather than only surfacing as a confusing negative "Hours Run" in
  // the report afterwards.
  // ───────────────────────────────────────────────────────────
  const lastReadingCache = {}; // itemId -> {value, timestamp} | null
  async function loadLastReadingFor(itemId) {
    if (lastReadingCache[itemId] !== undefined) return lastReadingCache[itemId];
    try {
      const results = await loadItemResults();
      const matches = results.filter(r => r.ItemID === itemId)
        .map(r => { const log = logsCache.find(l => l.LogID === r.LogID); return log ? { value: parseFloat(r.Result), timestamp: log.Timestamp } : null; })
        .filter(x => x && !isNaN(x.value))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      lastReadingCache[itemId] = matches.length ? matches[matches.length - 1] : null;
    } catch (e) {
      lastReadingCache[itemId] = null; // fail open — non-critical, worst case the guard just doesn't fire this time
    }
    return lastReadingCache[itemId];
  }

  async function renderChecklistForm(container) {
    const isDaily = currentTemplate.Frequency === 'Daily';
    const isShiftBased = currentTemplate.ShiftBased === 'TRUE' || currentTemplate.ShiftBased === 'true';
    const isRoundBased = currentTemplate.RoundBased === 'TRUE' || currentTemplate.RoundBased === 'true';
    if (isDaily && isShiftBased && !currentShift) {
      const now = new Date();
      const shiftDone = { '1st': hasSubmittedToday(currentTemplate.TemplateID, '1st'),
        '2nd': hasSubmittedToday(currentTemplate.TemplateID, '2nd'),
        '3rd': hasSubmittedToday(currentTemplate.TemplateID, '3rd') };
      const shiftBtn = (shift, label) => {
        if (shiftDone[shift]) {
          return `<button class="btn-secondary" disabled style="width:100%;margin-bottom:8px;opacity:0.5;cursor:not-allowed;">${label} — Already submitted today</button>`;
        }
        if (!isWithinShiftWindow(shift, now)) {
          return `<button class="btn-secondary" disabled style="width:100%;margin-bottom:8px;opacity:0.5;cursor:not-allowed;">${label} — Only allowed ${shiftWindowLabel(shift)}</button>`;
        }
        return `<button class="btn-${shift === '1st' ? 'primary' : 'secondary'} hs-shift-btn" data-shift="${shift}" style="width:100%;margin-bottom:8px;">${label}</button>`;
      };
      container.innerHTML = `
        <div class="mvoa-row" style="margin-bottom:10px;">
          <button id="hs-back-scan" class="btn-secondary">← Back</button>
          <strong>${FREQUENCY_LABEL[currentTemplate.Frequency]} — ${escapeHtml(categoryLabel(currentScan.qrTarget))}</strong>
        </div>
        <div class="card" style="max-width:420px;margin:0 0 12px 0;">
          <label>Performed By
            <input type="text" id="hs-performed-by" value="${escapeHtml(pendingPerformedBy)}">
          </label>
        </div>
        <div class="card" style="max-width:420px;margin:0;">
          <p class="muted" style="margin:0 0 10px;">Which shift is this for?</p>
          ${shiftBtn('1st', '1st Shift')}
          ${shiftBtn('2nd', '2nd Shift')}
          ${shiftBtn('3rd', '3rd Shift')}
        </div>
      `;
      container.querySelector('#hs-performed-by').addEventListener('input', (e) => { pendingPerformedBy = e.target.value; });
      container.querySelector('#hs-back-scan').addEventListener('click', () => renderScanResult(container));
      container.querySelectorAll('.hs-shift-btn').forEach(btn => {
        btn.addEventListener('click', () => { currentShift = btn.dataset.shift; renderChecklistForm(container); });
      });
      return;
    }

    if (isDaily && isRoundBased && !currentShift) {
      const now = new Date();
      const roundKeys = activeRoundKeys();
      const roundDone = {};
      roundKeys.forEach(k => { roundDone[k] = hasSubmittedToday(currentTemplate.TemplateID, k); });
      const roundBtn = (round, idx) => {
        const label = shiftLabel(round);
        if (roundDone[round]) {
          return `<button class="btn-secondary" disabled style="width:100%;margin-bottom:8px;opacity:0.5;cursor:not-allowed;">${label} — Already submitted today</button>`;
        }
        if (!isWithinRoundWindow(round, now)) {
          return `<button class="btn-secondary" disabled style="width:100%;margin-bottom:8px;opacity:0.5;cursor:not-allowed;">${label} — Only allowed ${roundWindowLabel(round)}</button>`;
        }
        return `<button class="btn-${idx === 0 ? 'primary' : 'secondary'} hs-round-btn" data-round="${round}" style="width:100%;margin-bottom:8px;">${label}</button>`;
      };
      container.innerHTML = `
        <div class="mvoa-row" style="margin-bottom:10px;">
          <button id="hs-back-scan" class="btn-secondary">← Back</button>
          <strong>${FREQUENCY_LABEL[currentTemplate.Frequency]} — ${escapeHtml(categoryLabel(currentScan.qrTarget))}</strong>
        </div>
        <div class="card" style="max-width:420px;margin:0 0 12px 0;">
          <label>Performed By (ASO)
            <input type="text" id="hs-performed-by" value="${escapeHtml(pendingPerformedBy)}">
          </label>
        </div>
        <div class="card" style="max-width:420px;margin:0;">
          <p class="muted" style="margin:0 0 10px;">Which round is this for?</p>
          ${roundKeys.length ? roundKeys.map((k, i) => roundBtn(k, i)).join('') : '<p class="muted">No round windows configured — check HSRoundWindows.</p>'}
        </div>
      `;
      container.querySelector('#hs-performed-by').addEventListener('input', (e) => { pendingPerformedBy = e.target.value; });
      container.querySelector('#hs-back-scan').addEventListener('click', () => renderScanResult(container));
      container.querySelectorAll('.hs-round-btn').forEach(btn => {
        btn.addEventListener('click', () => { currentShift = btn.dataset.round; renderChecklistForm(container); });
      });
      return;
    }

    if (isDaily && !isShiftBased && !isRoundBased && hasSubmittedToday(currentTemplate.TemplateID, null)) {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
      container.innerHTML = `
        <div class="mvoa-row" style="margin-bottom:10px;">
          <button id="hs-back-scan" class="btn-secondary">← Back</button>
          <strong>${FREQUENCY_LABEL[currentTemplate.Frequency]} — ${escapeHtml(categoryLabel(currentScan.qrTarget))}</strong>
        </div>
        <div class="card" style="max-width:420px;margin:0;">
          <p class="muted" style="margin:0;">Already submitted today. Next entry allowed from ${tomorrow.toLocaleDateString()}.</p>
        </div>
      `;
      container.querySelector('#hs-back-scan').addEventListener('click', () => renderScanResult(container));
      return;
    }

    const items = itemsCache
      .filter(i => i.TemplateID === currentTemplate.TemplateID)
      .filter(i => !isDaily || i.ShiftApplicability === 'Both' || i.ShiftApplicability === currentShift ||
        (i.ShiftApplicability === '2nd3rd' && (currentShift === '2nd' || currentShift === '3rd')))
      .sort((a, b) => (parseInt(a.SeqNo, 10) || 0) - (parseInt(b.SeqNo, 10) || 0));

    // Preload the last recorded reading for any running-hours meter
    // item on this template, so the live guard below has it ready
    // the moment the technician starts typing.
    await Promise.all(items.filter(i => /running hours/i.test(i.CheckItem)).map(i => loadLastReadingFor(i.ItemID)));

    const showZone = currentTemplate.ShowZoneOfDay === 'TRUE' || currentTemplate.ShowZoneOfDay === 'true';
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-scan" class="btn-secondary">← Back</button>
        <strong>${FREQUENCY_LABEL[currentTemplate.Frequency]}${isShiftBased ? ' (' + shiftLabel(currentShift) + ' shift)' : isRoundBased ? ' — ' + shiftLabel(currentShift) : ''} — ${escapeHtml(categoryLabel(currentScan.qrTarget))}</strong>
      </div>
      ${showZone ? `<div class="card" style="max-width:600px;margin:0 0 12px 0;background:#eef6fb;"><p style="margin:0;font-weight:700;color:var(--mvoa-blue);">📍 Today's Zone: ${escapeHtml(landscapeZoneForToday())}</p></div>` : ''}
      <div class="card" style="max-width:600px;margin:0 0 12px 0;">
        <label>Performed By
          <input type="text" id="hs-performed-by" value="${escapeHtml(pendingPerformedBy)}">
        </label>
      </div>
      <div id="hs-items-list"></div>
      <div class="card" style="max-width:600px;margin:12px 0;">
        ${isShiftBased ? `<p class="muted" style="margin:0;">Reporting an event during your shift? Use "📝 End of Shift Report" from Home after submitting this checklist.</p>` : `
        <label>Overall Notes ${currentTemplate.RequireOverallNotes === 'TRUE' || currentTemplate.RequireOverallNotes === 'true' ? '(required)' : '(optional)'}
          <textarea id="hs-overall-notes" rows="2"></textarea>
        </label>`}
        <button id="hs-submit-btn" class="btn-primary" style="width:100%;margin-top:8px;">Submit Checklist</button>
        <p class="error-text" id="hs-form-error"></p>
      </div>
    `;
    container.querySelector('#hs-performed-by').addEventListener('input', (e) => { pendingPerformedBy = e.target.value; });
    container.querySelector('#hs-back-scan').addEventListener('click', () => { currentShift = ''; renderScanResult(container); });

    const listEl = container.querySelector('#hs-items-list');
    if (!items.length) {
      listEl.innerHTML = `<p class="muted">No checklist items set up for this template${isShiftBased ? ' / shift' : ''}.</p>`;
    } else {
      listEl.innerHTML = items.map(item => renderItemRow(item)).join('');
      wireItemInputs(listEl, items);
    }

    container.querySelector('#hs-submit-btn').addEventListener('click', () => submitChecklist(container, items));
  }

  function renderItemRow(item) {
    const current = pendingResults[item.ItemID] || {};
    let inputHtml = '';
    if (item.InputType === 'PassFail') {
      inputHtml = `
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="hs-pf-btn ${current.result === 'Pass' ? 'btn-primary' : 'btn-secondary'}" data-item-id="${item.ItemID}" data-value="Pass" style="flex:1;">✓ Pass</button>
          <button class="hs-pf-btn ${current.result === 'Fail' ? 'btn-primary' : 'btn-secondary'}" data-item-id="${item.ItemID}" data-value="Fail" style="flex:1;background:${current.result === 'Fail' ? '#b3261e' : ''};">✕ Fail</button>
        </div>
        <textarea class="hs-remarks-input ${current.result === 'Fail' ? '' : 'hidden'}" data-item-id="${item.ItemID}" rows="2" placeholder="Remarks (required for Fail)" style="width:100%;margin-top:6px;box-sizing:border-box;">${escapeHtml(current.remarks || '')}</textarea>
      `;
    } else if (item.InputType === 'Numeric') {
      // If FailThreshold is set, auto-evaluates Pass/Fail as the
      // technician types (e.g. Battery Voltage, Fuel Level). If blank,
      // this is a plain data-capture field with no pass/fail meaning
      // (e.g. Running Hours in Shift) — just records the number.
      // Deliberately does NOT replace the row's outerHTML on every
      // keystroke (unlike PassFail/Dropdown) — that would recreate the
      // <input> and steal focus mid-typing. Status updates in place.
      const hasThreshold = item.FailThreshold !== '' && item.FailThreshold !== undefined;
      const statusText = current.remarks
        ? (hasThreshold ? (current.result === 'Fail' ? '✕ Fail — ' : '✓ Pass — ') + current.remarks : current.remarks)
        : '';
      const statusColor = hasThreshold ? (current.result === 'Fail' ? '#b3261e' : current.result === 'Pass' ? 'green' : 'inherit') : 'inherit';
      inputHtml = `
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
          <input type="number" step="any" inputmode="decimal" class="hs-numeric-input" data-item-id="${item.ItemID}" value="${current.numericValue !== undefined ? escapeHtml(String(current.numericValue)) : ''}" placeholder="Enter value" style="flex:1;">
          <span class="muted">${escapeHtml(item.Unit || '')}</span>
        </div>
        <p class="hs-numeric-status" data-item-id="${item.ItemID}" style="margin:4px 0 0;font-size:0.85rem;font-weight:700;color:${statusColor};">${escapeHtml(statusText)}</p>
        <label class="hs-outlier-confirm-wrap ${current.outlierFlag ? '' : 'hidden'}" data-item-id="${item.ItemID}" style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:0.85rem;color:#b3261e;">
          <input type="checkbox" class="hs-outlier-confirm-cb" data-item-id="${item.ItemID}" ${current.outlierConfirmed ? 'checked' : ''}>
          I've rechecked — this reading is correct, submit it anyway
        </label>
      `;
    } else if (item.InputType === 'Dropdown') {
      const opts = itemOptionsCache.filter(o => o.ItemID === item.ItemID).sort((a, b) => (parseInt(a.OptionOrder, 10) || 0) - (parseInt(b.OptionOrder, 10) || 0));
      inputHtml = `
        <select class="hs-dropdown-input" data-item-id="${item.ItemID}" style="margin-top:6px;">
          <option value="">— Select —</option>
          ${opts.map(o => `<option value="${escapeHtml(o.OptionValue)}" ${current.result === o.OptionValue ? 'selected' : ''}>${escapeHtml(o.OptionValue)}</option>`).join('')}
        </select>
      `;
    } else if (item.InputType === 'AssetList') {
      // Zero or more entries, each either typed (pre-filled with the
      // item's AssetPrefix so the technician only fills in the suffix)
      // or scanned (overwrites the whole field with the scanned code).
      // Zero entries is a fully valid "nothing to report" state — this
      // is never required, never blocks submission.
      const entries = current.entries || [];
      const prefix = item.AssetPrefix || '';
      // Button label used to be hardcoded "Light" (only correct for
      // Street Lights). Derived instead from the item's own CheckItem
      // text so any AssetList item (CCTV, future ones) gets a sensible
      // label with no schema change needed — e.g. "CCTV Not Working"
      // -> "+ Add Another CCTV". Falls back to "Entry" if the item
      // doesn't follow that "<noun> Not Working" phrasing.
      const assetNoun = (item.CheckItem || '').replace(/\s*Not Working$/i, '').trim() || 'Entry';
      inputHtml = `
        <div class="hs-assetlist-entries" data-item-id="${item.ItemID}">
          ${entries.map((val, idx) => `
            <div class="mvoa-row" style="gap:6px;margin-top:6px;">
              <input type="text" class="hs-assetlist-input" data-item-id="${item.ItemID}" data-idx="${idx}" value="${escapeHtml(val)}" style="flex:1;">
              <button class="btn-secondary hs-assetlist-scan" data-item-id="${item.ItemID}" data-idx="${idx}" style="padding:6px 10px;margin:0;">📷</button>
              <button class="btn-secondary hs-assetlist-remove" data-item-id="${item.ItemID}" data-idx="${idx}" style="padding:6px 10px;margin:0;">✕</button>
            </div>
          `).join('')}
        </div>
        <button class="btn-secondary hs-assetlist-add" data-item-id="${item.ItemID}" data-prefix="${escapeHtml(prefix)}" style="margin-top:6px;width:100%;">+ Add Another ${escapeHtml(assetNoun)}</button>
      `;
    } else if (item.InputType === 'Photo' || item.InputType === 'PhotoLocation') {
      // Security's Daily Rounds — the photo itself IS the check (Note 3:
      // no photo = Fail), captured live via the camera rather than
      // picked from gallery, since the whole point is proof of presence
      // at the moment of the round. 'PhotoLocation' additionally needs a
      // free-text location name (Locations 2/3 aren't fixed — the ASO
      // says where they went), 'Photo' alone is for the fixed Main Gate
      // location. The actual timestamp compliance-wise comes from this
      // log entry's own Timestamp (recorded at submission, which the
      // round-window check already confirms falls inside 2–3 AM/4–5 PM)
      // rather than pixels burned into the image.
      const hasPhoto = !!current.photoName;
      inputHtml = `
        ${item.InputType === 'PhotoLocation' ? `
          <input type="text" class="hs-photoloc-input" data-item-id="${item.ItemID}" value="${escapeHtml(current.locationText || '')}" placeholder="Which location did you enter?" style="width:100%;margin-top:6px;box-sizing:border-box;">
        ` : ''}
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <button class="btn-secondary hs-photo-capture" data-item-id="${item.ItemID}" style="margin:0;">📷 ${hasPhoto ? 'Retake Photo' : 'Take Photo'}</button>
          ${hasPhoto ? `<span class="muted" style="font-size:0.8rem;">✓ ${escapeHtml(current.photoName)}</span>` : ''}
        </div>
      `;
    } else { // Text
      inputHtml = `<textarea class="hs-text-input" data-item-id="${item.ItemID}" rows="2" style="width:100%;margin-top:6px;box-sizing:border-box;">${escapeHtml(current.result || '')}</textarea>`;
    }
    return `
      <div class="mvoa-list-item" data-item-row="${item.ItemID}">
        <strong>${escapeHtml(item.CheckItem)}</strong>
        ${item.Requirement ? `<p class="muted" style="margin:2px 0;font-size:0.85rem;">${escapeHtml(item.Requirement)}</p>` : ''}
        ${item.DayApplicability === 'WeeklyOnce' ? `<p class="muted" style="margin:2px 0;font-size:0.8rem;">Weekly — log on any day this week</p>` : ''}
        ${(item.DayApplicability && item.DayApplicability !== 'WeeklyOnce' && !isItemDueToday(item)) ? `<p class="muted" style="margin:2px 0;font-size:0.8rem;">Not scheduled today (${escapeHtml(item.DayApplicability)}) — optional</p>` : ''}
        ${(!item.DayApplicability && currentTemplate && currentTemplate.Frequency === 'Daily') ? `<p class="muted" style="margin:2px 0;font-size:0.8rem;">Daily</p>` : ''}
        ${inputHtml}
      </div>
    `;
  }

  // Event delegation on the container itself, wired ONCE — not one
  // listener per button re-attached after every re-render. The
  // previous approach re-queried and re-attached listeners to EVERY
  // button each time any single one was clicked, so a few taps left
  // buttons with several stacked listeners firing per click, which is
  // what caused Pass/Fail to stop responding correctly. Delegation
  // survives a row's outerHTML being replaced, since the listener
  // lives on the parent, not the child being swapped out.
  function wireItemInputs(listEl, items) {
    if (listEl._hsWired) return; // guard: never wire the same container twice
    listEl._hsWired = true;

    listEl.addEventListener('click', (e) => {
      const addBtn = e.target.closest('.hs-assetlist-add');
      if (addBtn) {
        const itemId = addBtn.dataset.itemId;
        const item = items.find(i => i.ItemID === itemId);
        pendingResults[itemId] = pendingResults[itemId] || {};
        pendingResults[itemId].entries = pendingResults[itemId].entries || [];
        pendingResults[itemId].entries.push(addBtn.dataset.prefix || '');
        const row = listEl.querySelector(`[data-item-row="${itemId}"]`);
        if (row && item) row.outerHTML = renderItemRow(item);
        return;
      }
      const removeBtn = e.target.closest('.hs-assetlist-remove');
      if (removeBtn) {
        const itemId = removeBtn.dataset.itemId;
        const idx = parseInt(removeBtn.dataset.idx, 10);
        const item = items.find(i => i.ItemID === itemId);
        if (pendingResults[itemId] && pendingResults[itemId].entries) pendingResults[itemId].entries.splice(idx, 1);
        const row = listEl.querySelector(`[data-item-row="${itemId}"]`);
        if (row && item) row.outerHTML = renderItemRow(item);
        return;
      }
      const scanBtn = e.target.closest('.hs-assetlist-scan');
      if (scanBtn) {
        const itemId = scanBtn.dataset.itemId;
        const idx = parseInt(scanBtn.dataset.idx, 10);
        const item = items.find(i => i.ItemID === itemId);
        scanAssetIdOnly().then(assetId => {
          if (!assetId || !pendingResults[itemId] || !pendingResults[itemId].entries) return; // cancelled
          pendingResults[itemId].entries[idx] = assetId;
          const row = listEl.querySelector(`[data-item-row="${itemId}"]`);
          if (row && item) row.outerHTML = renderItemRow(item);
        });
        return;
      }
      const photoBtn = e.target.closest('.hs-photo-capture');
      if (photoBtn) {
        const itemId = photoBtn.dataset.itemId;
        const item = items.find(i => i.ItemID === itemId);
        // Forces the actual camera (not gallery/file picker) — proof of
        // presence at the moment of the round is the whole point.
        MVOA.pickAttachment({ photoOnly: true, useCamera: true }).then(a => {
          if (!a) return; // cancelled
          pendingResults[itemId] = Object.assign({}, pendingResults[itemId], { photoFile: a.file, photoName: a.name });
          const row = listEl.querySelector(`[data-item-row="${itemId}"]`);
          if (row && item) row.outerHTML = renderItemRow(item);
        });
        return;
      }
      const btn = e.target.closest('.hs-pf-btn');
      if (!btn) return;
      const itemId = btn.dataset.itemId;
      const value = btn.dataset.value;
      pendingResults[itemId] = Object.assign({}, pendingResults[itemId], { result: value });
      const row = listEl.querySelector(`[data-item-row="${itemId}"]`);
      const item = items.find(i => i.ItemID === itemId);
      if (row && item) row.outerHTML = renderItemRow(item);
    });

    listEl.addEventListener('input', (e) => {
      const itemId = e.target.dataset.itemId;
      if (!itemId) return;
      if (e.target.classList.contains('hs-assetlist-input')) {
        const idx = parseInt(e.target.dataset.idx, 10);
        if (pendingResults[itemId] && pendingResults[itemId].entries) pendingResults[itemId].entries[idx] = e.target.value;
        return; // no re-render — would steal focus mid-typing, same reasoning as Numeric
      }
      if (e.target.classList.contains('hs-photoloc-input')) {
        pendingResults[itemId] = Object.assign({}, pendingResults[itemId], { locationText: e.target.value });
        return; // no re-render — would steal focus mid-typing
      }
      if (e.target.classList.contains('hs-remarks-input')) {
        pendingResults[itemId] = Object.assign({}, pendingResults[itemId], { remarks: e.target.value });
      } else if (e.target.classList.contains('hs-text-input')) {
        pendingResults[itemId] = { result: e.target.value };
      } else if (e.target.classList.contains('hs-numeric-input')) {
        const item = items.find(i => i.ItemID === itemId);
        const statusEl = listEl.querySelector(`.hs-numeric-status[data-item-id="${itemId}"]`);
        const val = parseFloat(e.target.value);
        if (!item || isNaN(val)) {
          pendingResults[itemId] = {};
          if (statusEl) { statusEl.textContent = ''; }
          return;
        }
        const unit = item.Unit || '';
        const hasThreshold = item.FailThreshold !== '' && item.FailThreshold !== undefined;
        const confirmWrap = listEl.querySelector(`.hs-outlier-confirm-wrap[data-item-id="${itemId}"]`);
        const confirmCb = confirmWrap ? confirmWrap.querySelector('.hs-outlier-confirm-cb') : null;

        // Outlier guard — independent of Pass/Fail: a value can be
        // technically "Pass" (e.g. 32bar isn't below the 3.2bar fail
        // threshold) yet still be an obvious typo (32 instead of 3.2).
        // TypicalValue (optional, per item) defines a ±20% plausible
        // band; outside it, the entry isn't blocked, but it does need
        // an explicit "yes, I checked, this is right" before it's
        // accepted — and even then it's flagged through to the
        // Monthly Report and a Maintenance task, not silently accepted.
        function applyOutlierGuard(result, remarks) {
          const typical = parseFloat(item.TypicalValue);
          const hasTypical = !isNaN(typical) && typical !== 0;
          const outOfRange = hasTypical && (val < typical * 0.8 || val > typical * 1.2);
          if (!outOfRange) {
            pendingResults[itemId] = { result, remarks, numericValue: val };
            if (confirmWrap) { confirmWrap.classList.add('hidden'); if (confirmCb) confirmCb.checked = false; }
            return false;
          }
          pendingResults[itemId] = { result, remarks, numericValue: val, outlierFlag: true, outlierConfirmed: false };
          if (confirmWrap) { confirmWrap.classList.remove('hidden'); if (confirmCb) confirmCb.checked = false; }
          return true;
        }

        if (!hasThreshold) {
          // Plain data-capture field (e.g. Running Hours in Shift) —
          // no pass/fail meaning, just record the number as-is — EXCEPT
          // for a running-hours meter, which gets a live backwards-
          // reading guard: a cumulative meter can't decrease, so a
          // lower value than last time is flagged before it's ever
          // accepted, not just discovered later in the report.
          if (/running hours/i.test(item.CheckItem)) {
            const last = lastReadingCache[itemId];
            if (last && val < last.value) {
              pendingResults[itemId] = { result: String(val), remarks: `Recorded: ${val}${unit}`, numericValue: val, belowLastReading: true };
              if (statusEl) {
                statusEl.innerHTML = `⚠️ This is LOWER than the last recorded reading (${last.value}${unit} on ${formatDate(last.timestamp)}) — a running-hours meter can't go backwards. Please double-check this value.`;
                statusEl.style.color = '#b3261e';
              }
              return;
            }
          }
          const remarks = `Recorded: ${val}${unit}`;
          const isOutlier = applyOutlierGuard(String(val), remarks);
          if (statusEl) {
            statusEl.textContent = isOutlier ? `⚠️ ${remarks} — this looks far outside the usual range. Please recheck the value.` : remarks;
            statusEl.style.color = isOutlier ? '#b3261e' : 'inherit';
          }
          return;
        }
        const threshold = parseFloat(item.FailThreshold);
        const isFail = item.FailDirection === 'above' ? val > threshold : val < threshold;
        const result = isFail ? 'Fail' : 'Pass';
        const remarks = `Entered: ${val}${unit} (fails if ${item.FailDirection === 'above' ? 'above' : 'below'} ${threshold}${unit})`;
        const isOutlier = applyOutlierGuard(result, remarks);
        if (statusEl) {
          if (isOutlier) {
            statusEl.textContent = `⚠️ ${(isFail ? 'Fail — ' : 'Pass — ') + remarks} — this looks far outside the usual range. Please recheck the value.`;
            statusEl.style.color = '#b3261e';
          } else {
            statusEl.textContent = (isFail ? '✕ Fail — ' : '✓ Pass — ') + remarks;
            statusEl.style.color = isFail ? '#b3261e' : 'green';
          }
        }
      }
    });

    listEl.addEventListener('change', (e) => {
      if (e.target.classList.contains('hs-dropdown-input')) {
        pendingResults[e.target.dataset.itemId] = { result: e.target.value };
      } else if (e.target.classList.contains('hs-outlier-confirm-cb')) {
        const itemId = e.target.dataset.itemId;
        if (pendingResults[itemId]) pendingResults[itemId].outlierConfirmed = e.target.checked;
      }
    });
  }

  // ───────────────────────────────────────────────────────────
  // SUBMIT — writes the Log + ItemResults rows, then auto-creates a
  // Daily Ops task (assigned to Facility Manager) for every Fail.
  // ───────────────────────────────────────────────────────────
  let isSubmittingChecklist = false;
  async function submitChecklist(container, items) {
    if (isSubmittingChecklist) return;
    const errEl = container.querySelector('#hs-form-error');
    const isShiftBased = currentTemplate.ShiftBased === 'TRUE' || currentTemplate.ShiftBased === 'true';
    const isRoundBased = currentTemplate.RoundBased === 'TRUE' || currentTemplate.RoundBased === 'true';
    // Authoritative re-check right before writing — the shift-selection
    // screen already hides an already-done shift, but re-verify here in
    // case of a stale cache or two tabs racing each other.
    if (hasSubmittedToday(currentTemplate.TemplateID, (isShiftBased || isRoundBased) ? currentShift : null)) {
      errEl.textContent = (isShiftBased || isRoundBased)
        ? `${shiftLabel(currentShift)} has already been submitted today for this checklist.`
        : 'This checklist has already been submitted today.';
      return;
    }
    if (isShiftBased && !isWithinShiftWindow(currentShift, new Date())) {
      errEl.textContent = `${shiftLabel(currentShift)} shift can only be logged between ${shiftWindowLabel(currentShift)}.`;
      return;
    }
    if (isRoundBased && !isWithinRoundWindow(currentShift, new Date())) {
      errEl.textContent = `${shiftLabel(currentShift)} can only be logged between ${roundWindowLabel(currentShift)}.`;
      return;
    }
    if (!pendingPerformedBy || !pendingPerformedBy.trim()) {
      errEl.textContent = 'Please enter who performed this checklist.';
      return;
    }
    // Items marked Required=FALSE (e.g. Vacuum Cleaning / Back Wash —
    // shown every day but only actually done every other day) don't
    // block submission when left blank, and a blank answer never
    // counts as a Fail for them.
    const missing = items.filter(i =>
      (i.InputType === 'PassFail' || i.InputType === 'Numeric') &&
      !(i.Required === 'FALSE' || i.Required === 'false') &&
      isItemDueToday(i) &&
      !pendingResults[i.ItemID]?.result
    );
    if (missing.length) {
      errEl.textContent = `Please mark Pass or Fail for: ${missing.map(i => i.CheckItem).join(', ')}`;
      return;
    }
    const failedWithoutRemarks = items.filter(i => pendingResults[i.ItemID]?.result === 'Fail' && !pendingResults[i.ItemID]?.remarks?.trim());
    if (failedWithoutRemarks.length) {
      errEl.textContent = `Please add remarks for the failed item(s): ${failedWithoutRemarks.map(i => i.CheckItem).join(', ')}`;
      return;
    }
    const belowLastReading = items.filter(i => pendingResults[i.ItemID]?.belowLastReading);
    if (belowLastReading.length) {
      errEl.textContent = `${belowLastReading.map(i => i.CheckItem).join(', ')}: entered value is lower than the last recorded reading. Please correct it before submitting.`;
      return;
    }
    const unconfirmedOutliers = items.filter(i => pendingResults[i.ItemID]?.outlierFlag && !pendingResults[i.ItemID]?.outlierConfirmed);
    if (unconfirmedOutliers.length) {
      errEl.textContent = `${unconfirmedOutliers.map(i => i.CheckItem).join(', ')}: this reading looks far outside the usual range. Please recheck the value, or tick "I've rechecked" to confirm and continue.`;
      return;
    }
    const requiresOverallNotes = currentTemplate.RequireOverallNotes === 'TRUE' || currentTemplate.RequireOverallNotes === 'true';
    if (requiresOverallNotes) {
      const notesEl = container.querySelector('#hs-overall-notes');
      if (!notesEl || !notesEl.value.trim()) {
        errEl.textContent = 'Please add Overall Notes for this check.';
        return;
      }
    }
    errEl.textContent = '';
    isSubmittingChecklist = true;
    const submitBtn = container.querySelector('#hs-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const performedBy = pendingPerformedBy.trim();
      const notesEl = container.querySelector('#hs-overall-notes'); // absent for Daily — see End of Shift Report instead
      const notes = notesEl ? notesEl.value.trim() : '';
      const now = new Date().toISOString();

      const existingLogRows = await MVOA.sheetsRead(MVOA.TABS.hsLog);
      const existingLogIds = existingLogRows.slice(1).map(r => r[0]).filter(Boolean);
      const logId = MVOA.nextId('HSLOG', existingLogIds);

      // Photo / PhotoLocation — Security's Daily Rounds. Never blocks
      // submission (a round can genuinely happen without every location
      // reached), but per Note 3 a missing photo IS a Fail, same as any
      // other failed check — uploads happen here, right before the
      // generic result-row serialization below, writing result/remarks
      // in the exact shape that existing generic code already expects,
      // so no special-casing needed downstream.
      for (const item of items) {
        if (item.InputType !== 'Photo' && item.InputType !== 'PhotoLocation') continue;
        const r = pendingResults[item.ItemID] || {};
        const needsLocation = item.InputType === 'PhotoLocation';
        const missingLocation = needsLocation && !(r.locationText || '').trim();
        if (!r.photoFile) {
          pendingResults[item.ItemID] = Object.assign({}, r, { result: 'Fail', remarks: missingLocation ? 'No photo captured and no location entered.' : 'No photo captured.' });
          continue;
        }
        if (missingLocation) {
          pendingResults[item.ItemID] = Object.assign({}, r, { result: 'Fail', remarks: 'Photo captured but no location entered.' });
          continue;
        }
        submitBtn.textContent = 'Uploading photo…';
        const photoUrl = await MVOA.uploadPhotoToDrive(r.photoFile, `${logId}_${item.ItemID}_${r.photoName}`);
        pendingResults[item.ItemID] = Object.assign({}, r, {
          result: 'Pass',
          remarks: needsLocation ? `Location: ${r.locationText.trim()} | Photo: ${photoUrl}` : `Photo: ${photoUrl}`
        });
      }
      submitBtn.textContent = 'Submitting…';

      const anyFail = items.some(i => pendingResults[i.ItemID]?.result === 'Fail') ||
        items.some(i => i.InputType === 'AssetList' && (pendingResults[i.ItemID]?.entries || []).some(v => v && v.trim()));
      const logRow = LOG_COLS.map(c => ({
        LogID: logId, TemplateID: currentTemplate.TemplateID, PerformedBy: performedBy,
        Timestamp: now, Shift: currentShift || '', Status: anyFail ? 'Flagged' : 'Submitted', Notes: notes,
        // Carries which physical instance this log belongs to, for
        // categories with multiple scannable units sharing one template
        // (e.g. 18 Distribution Panels) — blank for single-instance
        // categories (DG Set etc.), same as always.
        AssetID: currentScan.assetId || '', AssetName: currentScan.assetName || ''
      })[c]);
      await MVOA.sheetsAppend(MVOA.TABS.hsLog, logRow);

      const existingResultRows = await MVOA.sheetsRead(MVOA.TABS.hsItemResults);
      const existingResultIds = existingResultRows.slice(1).map(r => r[0]).filter(Boolean);
      let nextResultNum = 1;
      existingResultIds.forEach(id => {
        const m = String(id).match(/^HSRES-(\d+)$/);
        if (m) nextResultNum = Math.max(nextResultNum, parseInt(m[1], 10) + 1);
      });
      const resultRows = items.map((item, i) => {
        const r = pendingResults[item.ItemID] || {};
        const resultId = 'HSRES-' + String(nextResultNum + i).padStart(5, '0');
        let resultValue, remarksValue;
        if (item.InputType === 'AssetList') {
          resultValue = (r.entries || []).filter(v => v && v.trim()).join('; ');
          remarksValue = '';
        } else {
          resultValue = r.result || '';
          remarksValue = r.remarks || '';
          // Confirmed-outlier marker — carried in Remarks so the Monthly
          // Report (and anything else reading this row) can tell a
          // "technician double-checked and it's really this value" entry
          // apart from an ordinary Pass/Fail, without a new results column.
          if (r.outlierFlag && r.outlierConfirmed) remarksValue += ' [RECHECK-CONFIRMED]';
        }
        return RESULT_COLS.map(c => ({ ResultID: resultId, LogID: logId, ItemID: item.ItemID, Result: resultValue, Remarks: remarksValue })[c]);
      });
      if (resultRows.length) await MVOA.sheetsAppendMany(MVOA.TABS.hsItemResults, resultRows);

      // Auto-flag: one Daily Ops task per failed item
      const failedItems = items.filter(i => pendingResults[i.ItemID]?.result === 'Fail');
      for (const item of failedItems) {
        try {
          await MVOA.createOpsTask({
            categoryName: effectiveFailTaskCategory(currentTemplate, currentScan.qrTarget),
            title: `Plant Rounds: ${item.CheckItem} failed — ${categoryLabel(currentScan.qrTarget)}`,
            description: `Requirement: ${item.Requirement || '—'}\nRemarks: ${pendingResults[item.ItemID].remarks}\nLogged by ${performedBy} on ${formatDate(now)} (Plant Rounds log ${logId}).`,
            assigneeTitle: 'Facility Manager',
            priority: 'Urgent',
            createdBy: performedBy
          });
        } catch (e) {
          // Non-critical to the checklist submission itself, but surface it —
          // silently losing a safety-critical auto-flag would be worse than a visible error.
          errEl.textContent = `Checklist saved, but couldn't auto-create a task for "${item.CheckItem}": ${e.message}`;
        }
      }

      // Auto-flag: one Daily Ops task PER CONFIRMED-OUTLIER reading —
      // technician typed a value far outside the usual range and
      // explicitly confirmed it anyway, so it's not a Fail (may not even
      // cross the item's own threshold, e.g. 32bar isn't "below 3.2bar")
      // but still needs a second look. Always routed to Maintenance
      // regardless of the section's normal FailTaskCategory, since this
      // is "please recheck this reading," not a functional failure.
      const outlierItems = items.filter(i => pendingResults[i.ItemID]?.outlierFlag && pendingResults[i.ItemID]?.outlierConfirmed);
      for (const item of outlierItems) {
        try {
          await MVOA.createOpsTask({
            categoryName: 'Maintenance',
            title: `Plant Rounds: ${item.CheckItem} reading needs recheck — ${categoryLabel(currentScan.qrTarget)}`,
            description: `Requirement: ${item.Requirement || '—'}\nRemarks: ${pendingResults[item.ItemID].remarks}\nEntered value was outside the usual ±20% range and confirmed anyway by the technician.\nLogged by ${performedBy} on ${formatDate(now)} (Plant Rounds log ${logId}).`,
            assigneeTitle: 'Facility Manager',
            priority: 'Medium',
            createdBy: performedBy
          });
        } catch (e) {
          errEl.textContent = `Checklist saved, but couldn't auto-create a recheck task for "${item.CheckItem}": ${e.message}`;
        }
      }

      // Auto-flag: one Daily Ops task PER REPORTED LIGHT for AssetList
      // items — not one bundled task, so each light is independently
      // trackable through to closure. But if that light already has an
      // OPEN task from a previous night (repair can take days), don't
      // create a duplicate — the existing task already tracks it. The
      // checklist submission itself (this log entry) is still fully
      // recorded either way, so History/Monthly Report always show
      // every night's report regardless of whether a new task fired.
      const assetListItems = items.filter(i => i.InputType === 'AssetList');
      if (assetListItems.length) {
        const opsTaskRows = await MVOA.sheetsRead(MVOA.TABS.opsTasks);
        const hasOpenTaskFor = (assetCode) => opsTaskRows.slice(1).some(r =>
          (r[OPS_TASK_COL_IDX.Title] || '').indexOf(assetCode) !== -1 && r[OPS_TASK_COL_IDX.Status] === 'Open'
        );
        for (const item of assetListItems) {
          const entries = (pendingResults[item.ItemID]?.entries || []).filter(v => v && v.trim());
          for (const assetCode of entries) {
            if (hasOpenTaskFor(assetCode)) continue; // still-open task from an earlier night already tracks this light
            try {
              await MVOA.createOpsTask({
                categoryName: effectiveFailTaskCategory(currentTemplate, currentScan.qrTarget),
                title: `Plant Rounds: ${item.CheckItem} — ${assetCode}`,
                description: `Reported not working by ${performedBy} on ${formatDate(now)} (Plant Rounds log ${logId}).`,
                assigneeTitle: 'Facility Manager',
                priority: 'Urgent',
                createdBy: performedBy
              });
            } catch (e) {
              errEl.textContent = `Checklist saved, but couldn't auto-create a task for "${assetCode}": ${e.message}`;
            }
          }
        }
      }

      await loadAll(); // refresh due-status cache for the next scan
      currentTemplate = null; currentShift = ''; pendingResults = {};
      renderScanResult(container);
    } catch (e) {
      errEl.textContent = 'Could not submit: ' + e.message;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Checklist';
    }
    isSubmittingChecklist = false;
  }

  // ───────────────────────────────────────────────────────────
  // Shared helpers for the reports below
  // ───────────────────────────────────────────────────────────
  async function loadItemResults() {
    const rows = await MVOA.sheetsRead(MVOA.TABS.hsItemResults);
    return rowsToObjs(rows, RESULT_COLS);
  }

  // OpsTasks column indexes — must match OPS_TASK_COLS in shared.js.
  // Read directly by index rather than pulling in module-ops.js's own
  // column list, since modules don't share internals with each other.
  const OPS_TASK_COL_IDX = { Title: 1, Description: 2, CreatedDate: 7, Status: 9, ClosedDate: 12, ClosedBy: 13 };

  // Both Failed Items Log and Task Resolution are derived from actual
  // AUTO-CREATED TASKS (found via the "(Plant Rounds log LOGID)" marker
  // every createOpsTask call embeds), not from checklist Results
  // directly. This is what makes AssetList items (street lights) show
  // up correctly — their Result is a joined list of codes, never
  // literally "Fail" — and it's also what keeps a still-unresolved
  // light from duplicating across reports on repeat nights: since a
  // repeat night skips creating a new task (handled in
  // submitChecklist), there's simply no new task-event for these
  // reports to pick up, so nothing duplicates. PassFail/Numeric Fails
  // still create one task per Fail per submission, same as always.
  async function loadPlantRoundsFlaggedTasks() {
    const rows = await MVOA.sheetsRead(MVOA.TABS.opsTasks);
    return rows.slice(1).map(r => {
      const desc = r[OPS_TASK_COL_IDX.Description] || '';
      const m = desc.match(/\(Plant Rounds log (HSLOG-\d+)\)/);
      if (!m) return null;
      const logId = m[1];
      const log = logsCache.find(l => l.LogID === logId);
      const template = log ? templateById(log.TemplateID) : null;
      return {
        logId, log, template,
        item: (r[OPS_TASK_COL_IDX.Title] || '').replace(/^Plant Rounds:\s*/, ''),
        status: r[OPS_TASK_COL_IDX.Status] || '',
        createdDate: r[OPS_TASK_COL_IDX.CreatedDate] || '',
        closedBy: r[OPS_TASK_COL_IDX.ClosedBy] || '',
        closedDate: r[OPS_TASK_COL_IDX.ClosedDate] || ''
      };
    }).filter(Boolean);
  }

  // ───────────────────────────────────────────────────────────
  // FAILED ITEMS LOG
  // ───────────────────────────────────────────────────────────
  let failedItemsFilter = 'all';
  async function renderFailedItemsReport(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>❌ Failed Items Log</strong>
        <button id="hs-failed-pdf" class="btn-secondary">🖨 Print to PDF</button>
      </div>
      <div class="ops-tabs" style="margin-bottom:10px;">
        <button data-filter="all" class="ops-tab-btn ${failedItemsFilter==='all'?'active':''}">All</button>
        ${categoriesCache.map(c => `<button data-filter="${c.CategoryKey}" class="ops-tab-btn ${failedItemsFilter===c.CategoryKey?'active':''}">${escapeHtml(c.Label)}</button>`).join('')}
      </div>
      <div id="hs-failed-list"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));
    container.querySelectorAll('.ops-tab-btn[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => { failedItemsFilter = btn.dataset.filter; renderFailedItemsReport(container); });
    });

    const listEl = container.querySelector('#hs-failed-list');
    let flagged;
    try {
      flagged = await loadPlantRoundsFlaggedTasks();
    } catch (e) {
      listEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const fails = flagged
      .filter(x => failedItemsFilter === 'all' || (x.template && x.template.QRTarget === failedItemsFilter))
      .sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));

    listEl.innerHTML = fails.length ? fails.map(x => `
      <div class="mvoa-list-item">
        <div class="mvoa-row">
          <strong>${escapeHtml(x.item)}</strong>
          ${MVOA.statusBadgeHtml('Critical')}
        </div>
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">${x.template ? escapeHtml(categoryLabel(x.template.QRTarget) + ' — ' + FREQUENCY_LABEL[x.template.Frequency]) : ''} · ${x.log ? escapeHtml(x.log.PerformedBy) + ' · ' : ''}${formatDate(x.createdDate)}</p>
      </div>
    `).join('') : '<p class="muted">No failed items found.</p>';
    container.querySelector('#hs-failed-pdf').addEventListener('click', () => {
      const pdfRows = fails.map(x => ({
        Item: x.item,
        Category: x.template ? categoryLabel(x.template.QRTarget) : '', Frequency: x.template ? FREQUENCY_LABEL[x.template.Frequency] : '',
        PerformedBy: x.log ? x.log.PerformedBy : '', Timestamp: formatDate(x.createdDate)
      }));
      printTablePdf('Failed Items Log', ['Item', 'Category', 'Frequency', 'PerformedBy', 'Timestamp'], pdfRows);
    });
  }

  // ───────────────────────────────────────────────────────────
  // AUTO-FLAGGED TASK RESOLUTION
  // ───────────────────────────────────────────────────────────
  let taskResolutionFilter = 'all'; // 'all' | 'Open' | 'Approved'
  async function renderTaskResolutionReport(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>🔗 Auto-Flagged Task Resolution</strong>
        <button id="hs-task-res-pdf" class="btn-secondary">🖨 Print to PDF</button>
      </div>
      <div class="card" style="max-width:260px;margin:0 0 12px 0;">
        <label>Status
          <select id="hs-task-res-filter">
            <option value="all" ${taskResolutionFilter==='all'?'selected':''}>All</option>
            <option value="Open" ${taskResolutionFilter==='Open'?'selected':''}>Open</option>
            <option value="Approved" ${taskResolutionFilter==='Approved'?'selected':''}>Approved</option>
          </select>
        </label>
      </div>
      <div id="hs-task-res-list"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));
    container.querySelector('#hs-task-res-filter').addEventListener('change', (e) => {
      taskResolutionFilter = e.target.value;
      renderTaskResolutionReport(container);
    });

    const listEl = container.querySelector('#hs-task-res-list');
    let flagged;
    try {
      flagged = await loadPlantRoundsFlaggedTasks();
    } catch (e) {
      listEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    flagged = flagged
      .map(x => Object.assign({}, x, { bucket: x.status === 'Closed' ? 'Approved' : 'Open' }))
      .filter(x => taskResolutionFilter === 'all' || x.bucket === taskResolutionFilter)
      .sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));

    listEl.innerHTML = flagged.length ? flagged.map(x => `
        <div class="mvoa-list-item">
          <div class="mvoa-row">
            <strong>${escapeHtml(x.item)}</strong>
            ${x.bucket === 'Approved' ? MVOA.statusBadgeHtml('Approved') : MVOA.statusBadgeHtml('Critical').replace('Critical', 'Open')}
          </div>
          <p class="muted" style="margin:4px 0;font-size:0.8rem;">${formatDate(x.createdDate)}</p>
          ${x.bucket === 'Approved' ? `<p class="muted" style="font-size:0.8rem;">Closed by ${escapeHtml(x.closedBy)} · ${formatDate(x.closedDate)}</p>` : ''}
        </div>
    `).join('') : '<p class="muted">No flagged items found.</p>';
    container.querySelector('#hs-task-res-pdf').addEventListener('click', () => {
      const pdfRows = flagged.map(x => ({
        Item: x.item, LoggedAt: formatDate(x.createdDate), TaskStatus: x.bucket,
        ClosedBy: x.bucket === 'Approved' ? x.closedBy : '', ClosedDate: x.bucket === 'Approved' ? formatDate(x.closedDate) : ''
      }));
      printTablePdf('Auto-Flagged Task Resolution', ['Item', 'LoggedAt', 'TaskStatus', 'ClosedBy', 'ClosedDate'], pdfRows);
    });
  }

  // ───────────────────────────────────────────────────────────
  // SHIFT COVERAGE (Daily templates only)
  // ───────────────────────────────────────────────────────────
  function renderShiftCoverageReport(container) {
    const dailyTemplates = templatesCache.filter(t => t.Frequency === 'Daily' && (t.ShiftBased === 'TRUE' || t.ShiftBased === 'true'));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      days.push(d);
    }
    function loggedShifts(templateId, day) {
      const set = new Set();
      logsCache.filter(l => l.TemplateID === templateId && new Date(l.Timestamp).toDateString() === day.toDateString())
        .forEach(l => {
          if (l.Shift === '2nd3rd') { set.add('2nd'); set.add('3rd'); }
          else if (l.Shift) set.add(l.Shift);
        });
      return set;
    }
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>🕐 Shift Coverage — Last 7 Days</strong>
        <button id="hs-shift-pdf" class="btn-secondary">🖨 Print to PDF</button>
      </div>
      <div id="hs-shift-tables"></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));

    const tablesEl = container.querySelector('#hs-shift-tables');
    tablesEl.innerHTML = dailyTemplates.map(t => `
      <div class="card" style="max-width:600px;margin:0 0 16px 0;">
        <h3 style="margin:0 0 10px;color:var(--mvoa-blue);">${escapeHtml(categoryLabel(t.QRTarget))}</h3>
        <div style="overflow-x:auto;">
          <table class="mvoa-table">
            <thead><tr><th>Date</th><th>1st</th><th>2nd</th><th>3rd</th></tr></thead>
            <tbody>
              ${days.map(d => {
                const shifts = loggedShifts(t.TemplateID, d);
                const cell = (s) => shifts.has(s) ? '<span style="color:green;">✓</span>' : '<span style="color:#b3261e;">✕</span>';
                return `<tr><td>${d.toLocaleDateString()}</td><td>${cell('1st')}</td><td>${cell('2nd')}</td><td>${cell('3rd')}</td></tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `).join('');

    container.querySelector('#hs-shift-pdf').addEventListener('click', () => {
      const pdfRows = [];
      dailyTemplates.forEach(t => {
        days.forEach(d => {
          const shifts = loggedShifts(t.TemplateID, d);
          pdfRows.push({
            Category: categoryLabel(t.QRTarget), Date: d.toLocaleDateString(),
            '1st': shifts.has('1st') ? '✓' : '✕', '2nd': shifts.has('2nd') ? '✓' : '✕', '3rd': shifts.has('3rd') ? '✓' : '✕'
          });
        });
      });
      printTablePdf('Shift Coverage — Last 7 Days', ['Category', 'Date', '1st', '2nd', '3rd'], pdfRows);
    });
  }

  // ───────────────────────────────────────────────────────────
  // HISTORY
  // ───────────────────────────────────────────────────────────
  function renderHistory(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
        <strong>📅 Checklist History</strong>
        <button id="hs-history-pdf" class="btn-secondary">🖨 Print to PDF</button>
      </div>
      <div class="ops-tabs" style="margin-bottom:10px;">
        <button data-filter="all" class="ops-tab-btn ${historyFilter==='all'?'active':''}">All</button>
        ${categoriesCache.map(c => `<button data-filter="${c.CategoryKey}" class="ops-tab-btn ${historyFilter===c.CategoryKey?'active':''}">${escapeHtml(c.Label)}</button>`).join('')}
      </div>
      <div id="hs-history-list"></div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));
    container.querySelectorAll('.ops-tab-btn[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => { historyFilter = btn.dataset.filter; renderHistory(container); });
    });

    const listEl = container.querySelector('#hs-history-list');
    const filtered = logsCache
      .filter(l => historyFilter === 'all' || (templateById(l.TemplateID) || {}).QRTarget === historyFilter)
      .sort((a, b) => (b.Timestamp || '').localeCompare(a.Timestamp || ''));
    listEl.innerHTML = filtered.length ? filtered.map(l => logCardHtml(l)).join('') : '<p class="muted">No checklist rounds found.</p>';
    wireLogCardDrilldowns(listEl);
    container.querySelector('#hs-history-pdf').addEventListener('click', () => {
      const pdfRows = filtered.map(l => {
        const t = templateById(l.TemplateID);
        return {
          Category: t ? categoryLabel(t.QRTarget) : l.TemplateID, Frequency: t ? FREQUENCY_LABEL[t.Frequency] : '',
          PerformedBy: l.PerformedBy, Timestamp: formatDate(l.Timestamp), Shift: l.Shift ? shiftLabel(l.Shift) : '',
          Status: l.Status, Notes: l.Notes
        };
      });
      printTablePdf('Checklist History', ['Category', 'Frequency', 'PerformedBy', 'Timestamp', 'Shift', 'Status', 'Notes'], pdfRows);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ───────────────────────────────────────────────────────────
  // Generic Print-to-PDF, shared by every Plant Rounds report.
  // columns: array of header labels, each also used as the key into
  // each row object (so a wide table like Monthly Report can pass day
  // numbers as string keys: columns=['Item','1','2',...], rows=[{Item:
  // 'Fuel Level', '1':'Pass', '2':'Fail', ...}]).
  // ───────────────────────────────────────────────────────────
  function printTablePdf(title, columns, rows) {
    const win = window.open('', '_blank');
    const tableRows = rows.map(r => `<tr>${columns.map(c => `<td>${escapeHtml(String(r[c] !== undefined && r[c] !== '' && r[c] !== null ? r[c] : '—'))}</td>`).join('')}</tr>`).join('');
    win.document.write(`
      <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: -apple-system, Arial, sans-serif; padding: 24px; color: #1f2937; }
          h1 { color: #1d4e6b; font-size: 1.3rem; margin-bottom: 4px; }
          .muted { color: #6b7280; font-size: 0.85rem; margin-top: 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; }
          th, td { border: 1px solid #dde1e6; padding: 6px 8px; text-align: left; font-size: 0.8rem; white-space: nowrap; }
          th { background: #f5f6f8; }
          .back-btn {
            display: inline-block; margin-bottom: 16px; padding: 10px 18px;
            border-radius: 8px; border: none; background: #1d4e6b; color: white;
            font-size: 0.95rem; font-weight: 600; cursor: pointer;
          }
          @media print { .back-btn { display: none; } }
        </style>
      </head>
      <body>
        <button class="back-btn" id="back-to-app-btn">&larr; Back to App</button>
        <h1>MVOA Plant Rounds — ${escapeHtml(title)}</h1>
        <p class="muted">Generated ${new Date().toLocaleString()}</p>
        <table>
          <thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>${tableRows || `<tr><td colspan="${columns.length}">No data.</td></tr>`}</tbody>
        </table>
        <script>
          window.onload = () => { window.print(); };
          document.getElementById('back-to-app-btn').addEventListener('click', () => {
            window.close();
            setTimeout(() => {
              document.body.innerHTML = '<p style="padding:20px;">You can close this tab/window now and return to the MVOA app in your other tab.</p>';
            }, 300);
          });
        </script>
      </body>
      </html>
    `);
    win.document.close();
  }

  return { mount };
})();
