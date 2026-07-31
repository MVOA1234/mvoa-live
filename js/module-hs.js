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

  const CATEGORY_COLS = ['CategoryKey', 'Label', 'QRMatchKeyword', 'FailTaskCategory', 'Icon', 'Active'];
  const TEMPLATE_COLS = ['TemplateID', 'Name', 'QRTarget', 'Frequency', 'Active'];
  const ITEM_COLS = ['ItemID', 'TemplateID', 'SeqNo', 'CheckItem', 'Requirement', 'InputType', 'ShiftApplicability', 'Active', 'Unit', 'FailThreshold', 'FailDirection'];
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
    const recent = logsCache.slice().sort((a, b) => (b.Timestamp || '').localeCompare(a.Timestamp || '')).slice(0, 5);
    container.innerHTML = `
      <div class="card" style="max-width:520px;margin:0 0 16px 0;text-align:center;">
        <p class="muted" style="margin:0 0 12px;">Scan the DG Set or DG Panel Room QR label to log a round.</p>
        <button id="hs-scan-btn" class="btn-primary" style="width:100%;">📷 Scan Equipment QR</button>
      </div>
      <div class="mvoa-row" style="margin-bottom:10px;">
        <p class="muted" style="margin:0;">Recent activity</p>
        <div>
          <button id="hs-due-dashboard-btn" class="btn-secondary">📊 Due Status</button>
          <button id="hs-history-btn" class="btn-secondary">📅 Full History</button>
          <button id="hs-reports-btn" class="btn-secondary">📈 More Reports</button>
          <button id="hs-eos-btn" class="btn-secondary">📝 End of Shift Report</button>
        </div>
      </div>
      <div id="hs-recent"></div>
    `;
    const recentEl = container.querySelector('#hs-recent');
    recentEl.innerHTML = recent.length ? recent.map(l => logCardHtml(l)).join('') : '<p class="muted">No checklist rounds logged yet.</p>';
    wireLogCardDrilldowns(recentEl);
    container.querySelector('#hs-scan-btn').addEventListener('click', () => openQrScanner(container));
    container.querySelector('#hs-history-btn').addEventListener('click', () => renderHistory(container));
    container.querySelector('#hs-due-dashboard-btn').addEventListener('click', () => renderDueDashboard(container));
    container.querySelector('#hs-reports-btn').addEventListener('click', () => renderReportsMenu(container));
    container.querySelector('#hs-eos-btn').addEventListener('click', () => renderEndOfShiftPicker(container));
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
    const dailyTemplates = templatesCache.filter(t => t.Frequency === 'Daily' && MVOA.canEditPlantRoundsSection(t.QRTarget, user));
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Home</button>
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

  function renderReportsMenu(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Home</button>
        <strong>📈 Reports</strong>
      </div>
      <div class="card" style="max-width:420px;margin:0;">
        <button id="hs-report-failed" class="btn-secondary" style="width:100%;margin-bottom:8px;">❌ Failed Items Log</button>
        <button id="hs-report-tasks" class="btn-secondary" style="width:100%;margin-bottom:8px;">🔗 Auto-Flagged Task Resolution</button>
        <button id="hs-report-shift" class="btn-secondary" style="width:100%;margin-bottom:8px;">🕐 Shift Coverage (Daily)</button>
        <button id="hs-report-hours" class="btn-secondary" style="width:100%;">⏱️ DG Running Hours</button>
      </div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));
    container.querySelector('#hs-report-failed').addEventListener('click', () => renderFailedItemsReport(container));
    container.querySelector('#hs-report-tasks').addEventListener('click', () => renderTaskResolutionReport(container));
    container.querySelector('#hs-report-shift').addEventListener('click', () => renderShiftCoverageReport(container));
    container.querySelector('#hs-report-hours').addEventListener('click', () => renderRunningHoursReport(container));
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
        <button id="hs-back-home" class="btn-secondary">← Home</button>
        <strong>📊 Due Status</strong>
      </div>
      <p class="muted" style="margin:0 0 12px;">Overdue items are listed first. Scan the equipment QR to actually log a checklist.</p>
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

    groupsEl.innerHTML = groups.map(g => `
      <div class="card" style="max-width:600px;margin:0 0 16px 0;">
        <h3 style="margin:0 0 10px;color:var(--mvoa-blue);">${escapeHtml(categoryLabel(g.target))}</h3>
        ${g.rows.map(r => `
          <div class="mvoa-row" style="padding:6px 0;border-bottom:1px solid var(--border);">
            <span>${FREQUENCY_LABEL[r.template.Frequency]}</span>
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

  function openQrScanner(container) {
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box">
        <video id="hs-qr-video" autoplay playsinline muted></video>
        <canvas id="hs-qr-canvas" style="display:none;"></canvas>
        <p class="muted" id="hs-qr-status">Point camera at the DG Set or Panel Room QR label…</p>
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

  function renderScanResult(container) {
    const user = MVOA.getUser();
    const canView = MVOA.canViewPlantRoundsSection(currentScan.qrTarget, user);
    const canEdit = MVOA.canEditPlantRoundsSection(currentScan.qrTarget, user);

    if (!canView) {
      container.innerHTML = `
        <div class="mvoa-row" style="margin-bottom:10px;">
          <button id="hs-back-home" class="btn-secondary">← Home</button>
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
        <button id="hs-back-home" class="btn-secondary">← Home</button>
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
      return `
        <div class="mvoa-list-item ${canEdit ? 'hs-template-card' : ''}" data-template-id="${t.TemplateID}" style="${canEdit ? 'cursor:pointer;' : ''}">
          <div class="mvoa-row">
            <strong>${FREQUENCY_LABEL[t.Frequency]}</strong>
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

  function renderChecklistForm(container) {
    const isDaily = currentTemplate.Frequency === 'Daily';
    if (isDaily && !currentShift) {
      const shiftDone = { '1st': hasSubmittedToday(currentTemplate.TemplateID, '1st'),
        '2nd': hasSubmittedToday(currentTemplate.TemplateID, '2nd'),
        '3rd': hasSubmittedToday(currentTemplate.TemplateID, '3rd') };
      const shiftBtn = (shift, label) => shiftDone[shift]
        ? `<button class="btn-secondary" disabled style="width:100%;margin-bottom:8px;opacity:0.5;cursor:not-allowed;">${label} — Already submitted today</button>`
        : `<button class="btn-${shift === '1st' ? 'primary' : 'secondary'} hs-shift-btn" data-shift="${shift}" style="width:100%;margin-bottom:8px;">${label}</button>`;
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

    const items = itemsCache
      .filter(i => i.TemplateID === currentTemplate.TemplateID)
      .filter(i => !isDaily || i.ShiftApplicability === 'Both' || i.ShiftApplicability === currentShift ||
        (i.ShiftApplicability === '2nd3rd' && (currentShift === '2nd' || currentShift === '3rd')))
      .sort((a, b) => (parseInt(a.SeqNo, 10) || 0) - (parseInt(b.SeqNo, 10) || 0));

    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-scan" class="btn-secondary">← Back</button>
        <strong>${FREQUENCY_LABEL[currentTemplate.Frequency]}${isDaily ? ' (' + shiftLabel(currentShift) + ' shift)' : ''} — ${escapeHtml(categoryLabel(currentScan.qrTarget))}</strong>
      </div>
      <div class="card" style="max-width:600px;margin:0 0 12px 0;">
        <label>Performed By
          <input type="text" id="hs-performed-by" value="${escapeHtml(pendingPerformedBy)}">
        </label>
      </div>
      <div id="hs-items-list"></div>
      <div class="card" style="max-width:600px;margin:12px 0;">
        ${isDaily ? `<p class="muted" style="margin:0;">Reporting an event during your shift? Use "📝 End of Shift Report" from Home after submitting this checklist.</p>` : `
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
      listEl.innerHTML = `<p class="muted">No checklist items set up for this template${isDaily ? ' / shift' : ''}.</p>`;
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
    const isDaily = currentTemplate.Frequency === 'Daily';
    // Authoritative re-check right before writing — the shift-selection
    // screen already hides an already-done shift, but re-verify here in
    // case of a stale cache or two tabs racing each other.
    if (hasSubmittedToday(currentTemplate.TemplateID, isDaily ? currentShift : null)) {
      errEl.textContent = isDaily
        ? `${shiftLabel(currentShift)} shift has already been submitted today for this checklist.`
        : 'This checklist has already been submitted today.';
      return;
    }
    if (!pendingPerformedBy || !pendingPerformedBy.trim()) {
      errEl.textContent = 'Please enter who performed this checklist.';
      return;
    }
    const missing = items.filter(i => (i.InputType === 'PassFail' || i.InputType === 'Numeric') && !pendingResults[i.ItemID]?.result);
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

      const anyFail = items.some(i => pendingResults[i.ItemID]?.result === 'Fail');
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
        return RESULT_COLS.map(c => ({ ResultID: resultId, LogID: logId, ItemID: item.ItemID, Result: r.result || '', Remarks: r.remarks || '' })[c]);
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
  const OPS_TASK_COL_IDX = { Title: 1, Description: 2, Status: 9, ClosedDate: 12, ClosedBy: 13 };
  async function findAutoFlaggedTask(logId, checkItem) {
    const rows = await MVOA.sheetsRead(MVOA.TABS.opsTasks);
    const marker = `(Plant Rounds log ${logId})`;
    return rows.slice(1).find(r =>
      (r[OPS_TASK_COL_IDX.Description] || '').indexOf(marker) !== -1 &&
      (r[OPS_TASK_COL_IDX.Title] || '').indexOf(checkItem) !== -1
    ) || null;
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
    let results;
    try {
      results = await loadItemResults();
    } catch (e) {
      listEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const fails = results
      .filter(r => r.Result === 'Fail')
      .map(r => {
        const log = logsCache.find(l => l.LogID === r.LogID);
        const item = itemsCache.find(i => i.ItemID === r.ItemID);
        const template = log ? templateById(log.TemplateID) : null;
        return { r, log, item, template };
      })
      .filter(x => failedItemsFilter === 'all' || (x.template && x.template.QRTarget === failedItemsFilter))
      .sort((a, b) => (b.log ? b.log.Timestamp : '').localeCompare(a.log ? a.log.Timestamp : ''));

    listEl.innerHTML = fails.length ? fails.map(x => `
      <div class="mvoa-list-item">
        <div class="mvoa-row">
          <strong>${escapeHtml(x.item ? x.item.CheckItem : x.r.ItemID)}</strong>
          ${MVOA.statusBadgeHtml('Critical')}
        </div>
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">${x.template ? escapeHtml(categoryLabel(x.template.QRTarget) + ' — ' + FREQUENCY_LABEL[x.template.Frequency]) : ''} · ${x.log ? escapeHtml(x.log.PerformedBy) + ' · ' + formatDate(x.log.Timestamp) : ''}</p>
        ${x.r.Remarks ? `<p style="margin:4px 0;font-size:0.9rem;">${escapeHtml(x.r.Remarks)}</p>` : ''}
      </div>
    `).join('') : '<p class="muted">No failed items found.</p>';
  }

  // ───────────────────────────────────────────────────────────
  // AUTO-FLAGGED TASK RESOLUTION
  // ───────────────────────────────────────────────────────────
  async function renderTaskResolutionReport(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-reports" class="btn-secondary">← Reports</button>
        <strong>🔗 Auto-Flagged Task Resolution</strong>
      </div>
      <div id="hs-task-res-list"><p class="muted">Loading…</p></div>
    `;
    container.querySelector('#hs-back-reports').addEventListener('click', () => renderReportsMenu(container));

    const listEl = container.querySelector('#hs-task-res-list');
    let results, opsTaskRows;
    try {
      [results, opsTaskRows] = await Promise.all([loadItemResults(), MVOA.sheetsRead(MVOA.TABS.opsTasks)]);
    } catch (e) {
      listEl.innerHTML = `<p class="error-text">Could not load: ${e.message}</p>`;
      return;
    }
    const fails = results.filter(r => r.Result === 'Fail').map(r => {
      const log = logsCache.find(l => l.LogID === r.LogID);
      const item = itemsCache.find(i => i.ItemID === r.ItemID);
      const marker = `(Plant Rounds log ${r.LogID})`;
      const taskRow = opsTaskRows.slice(1).find(row =>
        (row[OPS_TASK_COL_IDX.Description] || '').indexOf(marker) !== -1 &&
        item && (row[OPS_TASK_COL_IDX.Title] || '').indexOf(item.CheckItem) !== -1
      );
      return { r, log, item, taskRow };
    }).sort((a, b) => (b.log ? b.log.Timestamp : '').localeCompare(a.log ? a.log.Timestamp : ''));

    listEl.innerHTML = fails.length ? fails.map(x => {
      const status = x.taskRow ? x.taskRow[OPS_TASK_COL_IDX.Status] : null;
      return `
        <div class="mvoa-list-item">
          <div class="mvoa-row">
            <strong>${escapeHtml(x.item ? x.item.CheckItem : x.r.ItemID)}</strong>
            ${status === 'Closed' ? MVOA.statusBadgeHtml('Approved') : status === 'Open' ? MVOA.statusBadgeHtml('Critical') : '<span class="muted">No task found</span>'}
          </div>
          <p class="muted" style="margin:4px 0;font-size:0.8rem;">${x.log ? formatDate(x.log.Timestamp) : ''}</p>
          ${status === 'Closed' ? `<p class="muted" style="font-size:0.8rem;">Closed by ${escapeHtml(x.taskRow[OPS_TASK_COL_IDX.ClosedBy])} · ${formatDate(x.taskRow[OPS_TASK_COL_IDX.ClosedDate])}</p>` : ''}
        </div>
      `;
    }).join('') : '<p class="muted">No failed items found.</p>';
  }

  // ───────────────────────────────────────────────────────────
  // SHIFT COVERAGE (Daily templates only)
  // ───────────────────────────────────────────────────────────
  function renderShiftCoverageReport(container) {
    const dailyTemplates = templatesCache.filter(t => t.Frequency === 'Daily');
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
  }

  // ───────────────────────────────────────────────────────────
  // HISTORY
  // ───────────────────────────────────────────────────────────
  function renderHistory(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Home</button>
        <strong>📅 Checklist History</strong>

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
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return { mount };
})();
