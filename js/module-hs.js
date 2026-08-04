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

  const CATEGORY_COLS = ['CategoryKey', 'Label', 'QRMatchKeyword', 'FailTaskCategory', 'Icon', 'Active', 'RequiresScan'];
  const TEMPLATE_COLS = ['TemplateID', 'Name', 'QRTarget', 'Frequency', 'Active', 'ShiftBased'];
  const ITEM_COLS = ['ItemID', 'TemplateID', 'SeqNo', 'CheckItem', 'Requirement', 'InputType', 'ShiftApplicability', 'Active', 'Unit', 'FailThreshold', 'FailDirection', 'Required', 'AssetPrefix'];
  const OPTION_COLS = ['ItemID', 'OptionValue', 'OptionOrder'];
  const LOG_COLS = ['LogID', 'TemplateID', 'PerformedBy', 'Timestamp', 'Shift', 'Status', 'Notes'];
  const RESULT_COLS = ['ResultID', 'LogID', 'ItemID', 'Result', 'Remarks'];

  let categoriesCache = [];
  let templatesCache = [];
  let itemsCache = [];
  let itemOptionsCache = [];
  let logsCache = [];

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
  }

  // ───────────────────────────────────────────────────────────
  // HOME — scan entry point + recent activity
  // ───────────────────────────────────────────────────────────
  function renderHome(container) {
    const user = MVOA.getUser();
    const recent = logsCache.slice().sort((a, b) => (b.Timestamp || '').localeCompare(a.Timestamp || '')).slice(0, 5);
    const visibleCategories = categoriesCache.filter(c => MVOA.canViewPlantRoundsSection(c.CategoryKey, user));
    container.innerHTML = `
      <div class="card" style="max-width:520px;margin:0 0 16px 0;">
        <p class="muted" style="margin:0 0 10px;">Choose which equipment/area you're logging.</p>
        <div id="hs-category-tabs" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
      </div>
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
    tabsEl.innerHTML = visibleCategories.length
      ? visibleCategories.map(c => `<button class="btn-secondary hs-category-tab" data-category="${c.CategoryKey}" style="flex:1;min-width:120px;">${c.Icon || ''} ${escapeHtml(c.Label)}</button>`).join('')
      : '<p class="muted">You don\'t have access to any Plant Rounds categories yet.</p>';
    tabsEl.querySelectorAll('.hs-category-tab').forEach(btn => {
      btn.addEventListener('click', () => handleCategoryTabClick(btn.dataset.category, container));
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
    bodyEl.querySelectorAll('.hs-amc-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openAmcEditDialog(btn.dataset.assetId, assets, container));
    });
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
        <div id="hs-amc-done-attach" style="margin-top:10px;"></div>
        <button id="hs-amc-done-attach-btn" class="btn-secondary" style="width:100%;">📎 Attach Report (optional)</button>
        <button id="hs-amc-done-save" class="btn-primary" style="margin-top:10px;">Save</button>
        <button id="hs-amc-done-cancel" class="btn-secondary">Cancel</button>
        <p class="error-text" id="hs-amc-done-error"></p>
      </div>
    `;
    document.body.appendChild(modal);
    let attachment = null;

    modal.querySelector('#hs-amc-done-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#hs-amc-done-attach-btn').addEventListener('click', async () => {
      const a = await MVOA.pickAttachment({ photoOnly: false, useCamera: false });
      if (a) {
        attachment = a;
        modal.querySelector('#hs-amc-done-attach').innerHTML = `<p class="muted">📎 ${escapeHtml(a.name)}</p>`;
      }
    });
    modal.querySelector('#hs-amc-done-save').addEventListener('click', async () => {
      const errEl = modal.querySelector('#hs-amc-done-error');
      const dateVal = modal.querySelector('#hs-amc-done-date').value;
      if (!dateVal) { errEl.textContent = 'Please pick a date.'; return; }
      const saveBtn = modal.querySelector('#hs-amc-done-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        let reportUrl = '';
        if (attachment) {
          saveBtn.textContent = 'Uploading report…';
          reportUrl = await MVOA.uploadPhotoToDrive(attachment.file, `AMC_${asset.AssetCode}_${dateVal}_${attachment.name}`);
        }
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
        <button id="hs-report-monthly" class="btn-secondary" style="width:100%;">📅 Monthly Report</button>
      </div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));
    container.querySelector('#hs-report-failed').addEventListener('click', () => renderFailedItemsReport(container));
    container.querySelector('#hs-report-tasks').addEventListener('click', () => renderTaskResolutionReport(container));
    container.querySelector('#hs-report-shift').addEventListener('click', () => renderShiftCoverageReport(container));
    container.querySelector('#hs-report-hours').addEventListener('click', () => renderRunningHoursReport(container));
    container.querySelector('#hs-report-monthly').addEventListener('click', () => renderMonthlyReport(container));
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
      const available = templatesCache.filter(t => t.QRTarget === monthlyReportCategory).sort((a, b) => FREQUENCY_ORDER.indexOf(a.Frequency) - FREQUENCY_ORDER.indexOf(b.Frequency));
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
    const shifts = isShiftBased ? ['1st', '2nd', '3rd'] : [null];
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
      if (item.InputType === 'Numeric') return numericDisplayValue(item, resultObj);
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
          .map(t => ({ template: t, due: dueInfo(t) }))
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
        Category: categoryLabel(g.target), Template: r.template.Name, Frequency: FREQUENCY_LABEL[r.template.Frequency],
        Status: r.due.overdue ? 'Due' : 'Up to date', Detail: r.due.text
      })));
      printTablePdf('Due Status', ['Category', 'Template', 'Frequency', 'Status', 'Detail'], pdfRows);
    });

    groupsEl.innerHTML = groups.map(g => `
      <div class="card" style="max-width:600px;margin:0 0 16px 0;">
        <h3 style="margin:0 0 10px;color:var(--mvoa-blue);">${escapeHtml(categoryLabel(g.target))}</h3>
        ${g.rows.map(r => `
          <div class="mvoa-row" style="padding:6px 0;border-bottom:1px solid var(--border);">
            <span>${escapeHtml(r.template.Name)}</span>
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

  function shiftLabel(s) { return s === '2nd3rd' ? '2nd & 3rd' : s; } // '2nd3rd' kept for reading old log entries only — no longer written

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
  function lastLogForTemplate(templateId) {
    const matches = logsCache.filter(l => l.TemplateID === templateId).sort((a, b) => (b.Timestamp || '').localeCompare(a.Timestamp || ''));
    return matches[0] || null;
  }
  function hasLogSince(templateId, sinceDate) {
    return logsCache.some(l => l.TemplateID === templateId && new Date(l.Timestamp) >= sinceDate);
  }

  function dueInfo(template) {
    const last = lastLogForTemplate(template.TemplateID);
    const lastText = last ? `Last: ${formatDate(last.Timestamp)}` : 'Never logged';
    const now = new Date();

    if (template.Frequency === 'Daily') {
      const doneToday = last && new Date(last.Timestamp).toDateString() === now.toDateString();
      return { text: lastText, overdue: !doneToday };
    }

    if (template.Frequency === 'Weekly') {
      const monday = mostRecentMonday(now);
      const done = hasLogSince(template.TemplateID, monday);
      if (done) return { text: lastText, overdue: false };
      const isMonday = now.getDay() === 1;
      return isMonday ? { text: 'Due today (Monday)', overdue: false } : { text: `Not done since ${formatDate(monday)}`, overdue: true };
    }

    // Monthly and BiMonthly share the same "last week of a cycle month" shape
    const interval = template.Frequency === 'BiMonthly' ? 2 : 1;
    const anchor0 = 6; // July, 0-based — only relevant when interval=2
    const win = currentOrLastCycleWindow(now, interval, anchor0);
    if (!win) return { text: lastText, overdue: true };
    const done = hasLogSince(template.TemplateID, win.start);
    if (done) return { text: lastText, overdue: false };
    if (win.isCurrentMonth) return { text: 'Due this week', overdue: false };
    return { text: `Overdue since ${formatDate(win.start)}`, overdue: true };
  }

  function frequencyRuleText(template) {
    if (template.Frequency === 'Weekly') return 'Due every Monday';
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

    const targetTemplates = templatesCache
      .filter(t => t.QRTarget === currentScan.qrTarget)
      .sort((a, b) => FREQUENCY_ORDER.indexOf(a.Frequency) - FREQUENCY_ORDER.indexOf(b.Frequency));

    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Back to Plant Rounds &amp; Compliance</button>
        <strong>${escapeHtml(categoryLabel(currentScan.qrTarget))}${currentScan.assetName ? ' — ' + escapeHtml(currentScan.assetName) : ''}</strong>
      </div>
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
        currentTemplate = templateById(card.dataset.templateId);
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

  function renderChecklistForm(container) {
    const isDaily = currentTemplate.Frequency === 'Daily';
    const isShiftBased = currentTemplate.ShiftBased === 'TRUE' || currentTemplate.ShiftBased === 'true';
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

    if (isDaily && !isShiftBased && hasSubmittedToday(currentTemplate.TemplateID, null)) {
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

    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-scan" class="btn-secondary">← Back</button>
        <strong>${FREQUENCY_LABEL[currentTemplate.Frequency]}${isShiftBased ? ' (' + shiftLabel(currentShift) + ' shift)' : ''} — ${escapeHtml(categoryLabel(currentScan.qrTarget))}</strong>
      </div>
      <div class="card" style="max-width:600px;margin:0 0 12px 0;">
        <label>Performed By
          <input type="text" id="hs-performed-by" value="${escapeHtml(pendingPerformedBy)}">
        </label>
      </div>
      <div id="hs-items-list"></div>
      <div class="card" style="max-width:600px;margin:12px 0;">
        ${isShiftBased ? `<p class="muted" style="margin:0;">Reporting an event during your shift? Use "📝 End of Shift Report" from Home after submitting this checklist.</p>` : `
        <label>Overall Notes (optional)
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
        <button class="btn-secondary hs-assetlist-add" data-item-id="${item.ItemID}" data-prefix="${escapeHtml(prefix)}" style="margin-top:6px;width:100%;">+ Add Another Light</button>
      `;
    } else { // Text
      inputHtml = `<textarea class="hs-text-input" data-item-id="${item.ItemID}" rows="2" style="width:100%;margin-top:6px;box-sizing:border-box;">${escapeHtml(current.result || '')}</textarea>`;
    }
    return `
      <div class="mvoa-list-item" data-item-row="${item.ItemID}">
        <strong>${escapeHtml(item.CheckItem)}</strong>
        ${item.Requirement ? `<p class="muted" style="margin:2px 0;font-size:0.85rem;">${escapeHtml(item.Requirement)}</p>` : ''}
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
        if (!hasThreshold) {
          // Plain data-capture field (e.g. Running Hours in Shift) —
          // no pass/fail meaning, just record the number as-is.
          pendingResults[itemId] = { result: String(val), remarks: `Recorded: ${val}${unit}`, numericValue: val };
          if (statusEl) { statusEl.textContent = `Recorded: ${val}${unit}`; statusEl.style.color = 'inherit'; }
          return;
        }
        const threshold = parseFloat(item.FailThreshold);
        const isFail = item.FailDirection === 'above' ? val > threshold : val < threshold;
        const result = isFail ? 'Fail' : 'Pass';
        const remarks = `Entered: ${val}${unit} (fails if ${item.FailDirection === 'above' ? 'above' : 'below'} ${threshold}${unit})`;
        pendingResults[itemId] = { result, remarks, numericValue: val };
        if (statusEl) {
          statusEl.textContent = (isFail ? '✕ Fail — ' : '✓ Pass — ') + remarks;
          statusEl.style.color = isFail ? '#b3261e' : 'green';
        }
      }
    });

    listEl.addEventListener('change', (e) => {
      if (e.target.classList.contains('hs-dropdown-input')) {
        pendingResults[e.target.dataset.itemId] = { result: e.target.value };
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
    // Authoritative re-check right before writing — the shift-selection
    // screen already hides an already-done shift, but re-verify here in
    // case of a stale cache or two tabs racing each other.
    if (hasSubmittedToday(currentTemplate.TemplateID, isShiftBased ? currentShift : null)) {
      errEl.textContent = isShiftBased
        ? `${shiftLabel(currentShift)} shift has already been submitted today for this checklist.`
        : 'This checklist has already been submitted today.';
      return;
    }
    if (isShiftBased && !isWithinShiftWindow(currentShift, new Date())) {
      errEl.textContent = `${shiftLabel(currentShift)} shift can only be logged between ${shiftWindowLabel(currentShift)}.`;
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

      const anyFail = items.some(i => pendingResults[i.ItemID]?.result === 'Fail') ||
        items.some(i => i.InputType === 'AssetList' && (pendingResults[i.ItemID]?.entries || []).some(v => v && v.trim()));
      const logRow = LOG_COLS.map(c => ({
        LogID: logId, TemplateID: currentTemplate.TemplateID, PerformedBy: performedBy,
        Timestamp: now, Shift: currentShift || '', Status: anyFail ? 'Flagged' : 'Submitted', Notes: notes
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
        }
        return RESULT_COLS.map(c => ({ ResultID: resultId, LogID: logId, ItemID: item.ItemID, Result: resultValue, Remarks: remarksValue })[c]);
      });
      if (resultRows.length) await MVOA.sheetsAppendMany(MVOA.TABS.hsItemResults, resultRows);

      // Auto-flag: one Daily Ops task per failed item
      const failedItems = items.filter(i => pendingResults[i.ItemID]?.result === 'Fail');
      for (const item of failedItems) {
        try {
          await MVOA.createOpsTask({
            categoryName: failTaskCategoryFor(currentScan.qrTarget),
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
                categoryName: failTaskCategoryFor(currentScan.qrTarget),
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
