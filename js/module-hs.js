// ═══════════════════════════════════════════════════════════════
// MODULE: Plant Rounds & Compliance
// Columns:
//   HSChecklistTemplates: TemplateID | Name | QRTarget | Frequency | Active
//     QRTarget: 'DGSet' | 'PanelRoom'  Frequency: 'Daily'|'Weekly'|'Monthly'|'BiMonthly'
//   HSChecklistItems: ItemID | TemplateID | SeqNo | CheckItem | Requirement |
//     InputType | ShiftApplicability | Active
//     InputType: 'PassFail' | 'Text' | 'Dropdown'
//     ShiftApplicability (Daily only): '1st' | '2nd3rd' | 'Both'
//   HSChecklistItemOptions: ItemID | OptionValue | OptionOrder   (Dropdown items only)
//   HSChecklistLog: LogID | TemplateID | PerformedBy | Timestamp | Shift | Status | Notes
//     Status: 'Submitted' | 'Flagged'
//   HSChecklistItemResults: ResultID | LogID | ItemID | Result | Remarks
//
// QR SCANNING: reuses the same MVOA.parseAssetQR() format/scanner as
// Daily Ops asset scanning. QRTarget is inferred from the scanned
// asset's Category/AssetName — anything containing "panel" maps to
// PanelRoom, everything else maps to DGSet. If Inventory's actual
// label text for these two assets doesn't contain "panel" clearly,
// this heuristic will need adjusting — check on first real scan.
//
// AUTO-FLAGGING: a PassFail item marked "Fail" automatically creates
// a Daily Ops task assigned to Facility Manager — DGSet failures go
// to the "Maintenance" category, PanelRoom failures go to "Electrical".
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
  const QR_TARGET_LABEL = { DGSet: 'DG Set', PanelRoom: 'DG Panel Room' };
  const FAIL_TASK_CATEGORY = { DGSet: 'Maintenance', PanelRoom: 'Electrical' };
  const FREQUENCY_ORDER = ['Daily', 'Weekly', 'Monthly', 'BiMonthly'];
  const FREQUENCY_LABEL = { Daily: 'Daily', Weekly: 'Weekly', Monthly: 'Monthly', BiMonthly: 'Bi-Monthly' };

  const TEMPLATE_COLS = ['TemplateID', 'Name', 'QRTarget', 'Frequency', 'Active'];
  const ITEM_COLS = ['ItemID', 'TemplateID', 'SeqNo', 'CheckItem', 'Requirement', 'InputType', 'ShiftApplicability', 'Active'];
  const OPTION_COLS = ['ItemID', 'OptionValue', 'OptionOrder'];
  const LOG_COLS = ['LogID', 'TemplateID', 'PerformedBy', 'Timestamp', 'Shift', 'Status', 'Notes'];
  const RESULT_COLS = ['ResultID', 'LogID', 'ItemID', 'Result', 'Remarks'];

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
  let historyFilter = 'all'; // 'all' | 'DGSet' | 'PanelRoom'

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

  async function loadAll() {
    const [templates, items, options, logs] = await Promise.all([
      MVOA.sheetsRead(MVOA.TABS.hsTemplates),
      MVOA.sheetsRead(MVOA.TABS.hsItems),
      MVOA.sheetsRead(MVOA.TABS.hsItemOptions),
      MVOA.sheetsRead(MVOA.TABS.hsLog)
    ]);
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
        </div>
      </div>
      <div id="hs-recent"></div>
    `;
    const recentEl = container.querySelector('#hs-recent');
    recentEl.innerHTML = recent.length ? recent.map(l => logCardHtml(l)).join('') : '<p class="muted">No checklist rounds logged yet.</p>';
    container.querySelector('#hs-scan-btn').addEventListener('click', () => openQrScanner(container));
    container.querySelector('#hs-history-btn').addEventListener('click', () => renderHistory(container));
    container.querySelector('#hs-due-dashboard-btn').addEventListener('click', () => renderDueDashboard(container));
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
    const groups = ['DGSet', 'PanelRoom'].map(target => {
      const rows = templatesCache
        .filter(t => t.QRTarget === target)
        .map(t => ({ template: t, due: dueInfo(t) }))
        .sort((a, b) => {
          if (a.due.overdue !== b.due.overdue) return a.due.overdue ? -1 : 1;
          return FREQUENCY_ORDER.indexOf(a.template.Frequency) - FREQUENCY_ORDER.indexOf(b.template.Frequency);
        });
      return { target, rows };
    });

    groupsEl.innerHTML = groups.map(g => `
      <div class="card" style="max-width:600px;margin:0 0 16px 0;">
        <h3 style="margin:0 0 10px;color:var(--mvoa-blue);">${escapeHtml(QR_TARGET_LABEL[g.target])}</h3>
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
      <div class="mvoa-list-item">
        <div class="mvoa-row">
          <strong>${escapeHtml(t ? QR_TARGET_LABEL[t.QRTarget] + ' — ' + FREQUENCY_LABEL[t.Frequency] : l.TemplateID)}</strong>
          ${flagged ? MVOA.statusBadgeHtml('Critical') : MVOA.statusBadgeHtml('Approved')}
        </div>
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">By ${escapeHtml(l.PerformedBy)} · ${formatDate(l.Timestamp)}${l.Shift ? ' · Shift: ' + shiftLabel(l.Shift) : ''}</p>
        ${l.Notes ? `<p class="muted" style="margin:4px 0;font-size:0.85rem;">${escapeHtml(l.Notes)}</p>` : ''}
      </div>
    `;
  }

  function shiftLabel(s) { return s === '2nd3rd' ? '2nd & 3rd' : s; } // '2nd3rd' kept for reading old log entries only — no longer written

  // ───────────────────────────────────────────────────────────
  // QR SCANNER — same jsQR-based approach as Daily Ops, decoded via
  // the shared MVOA.parseAssetQR(). QRTarget inferred from the result.
  // ───────────────────────────────────────────────────────────
  // Matches your actual Inventory asset names: the Panel Room asset is
  // literally named "DG Room" (no "panel" in it at all — the earlier
  // "panel" keyword heuristic would have misclassified this), and the
  // DG Set asset is "DG Set GMMCO 200 KVA". Checking for "dg room" or
  // "panel" (kept as a fallback for any future differently-named panel
  // asset) covers Panel Room; everything else defaults to DGSet.
  function inferQrTarget(parsed) {
    const haystack = ((parsed.category || '') + ' ' + (parsed.assetName || '') + ' ' + (parsed.assetId || '')).toLowerCase();
    return (haystack.indexOf('dg room') !== -1 || haystack.indexOf('panel') !== -1) ? 'PanelRoom' : 'DGSet';
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
            currentScan = Object.assign({}, parsed, { qrTarget: inferQrTarget(parsed) });
            stop();
            renderScanResult(container);
            return;
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
    const targetTemplates = templatesCache
      .filter(t => t.QRTarget === currentScan.qrTarget)
      .sort((a, b) => FREQUENCY_ORDER.indexOf(a.Frequency) - FREQUENCY_ORDER.indexOf(b.Frequency));

    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="hs-back-home" class="btn-secondary">← Home</button>
        <strong>${escapeHtml(QR_TARGET_LABEL[currentScan.qrTarget])}${currentScan.assetName ? ' — ' + escapeHtml(currentScan.assetName) : ''}</strong>
      </div>
      <p class="muted" style="margin:0 0 12px;">Choose which checklist to log.</p>
      <div id="hs-template-cards"></div>
    `;
    container.querySelector('#hs-back-home').addEventListener('click', () => renderHome(container));

    const cardsEl = container.querySelector('#hs-template-cards');
    if (!targetTemplates.length) {
      cardsEl.innerHTML = `<p class="muted">No checklist templates set up yet for ${escapeHtml(QR_TARGET_LABEL[currentScan.qrTarget])}.</p>`;
      return;
    }
    cardsEl.innerHTML = targetTemplates.map(t => {
      const due = dueInfo(t);
      return `
        <div class="mvoa-list-item hs-template-card" data-template-id="${t.TemplateID}" style="cursor:pointer;">
          <div class="mvoa-row">
            <strong>${FREQUENCY_LABEL[t.Frequency]}</strong>
            ${due.overdue ? '<span style="color:#b3261e;font-weight:700;font-size:0.85rem;">⚠️ Due</span>' : '<span class="muted" style="font-size:0.85rem;">Up to date</span>'}
          </div>
          <p class="muted" style="margin:4px 0;font-size:0.8rem;">${due.text}</p>
        </div>
      `;
    }).join('');
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
  function renderChecklistForm(container) {
    const isDaily = currentTemplate.Frequency === 'Daily';
    if (isDaily && !currentShift) {
      container.innerHTML = `
        <div class="mvoa-row" style="margin-bottom:10px;">
          <button id="hs-back-scan" class="btn-secondary">← Back</button>
          <strong>${FREQUENCY_LABEL[currentTemplate.Frequency]} — ${escapeHtml(QR_TARGET_LABEL[currentScan.qrTarget])}</strong>
        </div>
        <div class="card" style="max-width:420px;margin:0 0 12px 0;">
          <label>Performed By
            <input type="text" id="hs-performed-by" value="${escapeHtml(pendingPerformedBy)}">
          </label>
        </div>
        <div class="card" style="max-width:420px;margin:0;">
          <p class="muted" style="margin:0 0 10px;">Which shift is this for?</p>
          <button class="btn-primary hs-shift-btn" data-shift="1st" style="width:100%;margin-bottom:8px;">1st Shift</button>
          <button class="btn-secondary hs-shift-btn" data-shift="2nd" style="width:100%;margin-bottom:8px;">2nd Shift</button>
          <button class="btn-secondary hs-shift-btn" data-shift="3rd" style="width:100%;">3rd Shift</button>
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
        <strong>${FREQUENCY_LABEL[currentTemplate.Frequency]}${isDaily ? ' (' + shiftLabel(currentShift) + ' shift)' : ''} — ${escapeHtml(QR_TARGET_LABEL[currentScan.qrTarget])}</strong>
      </div>
      <div class="card" style="max-width:600px;margin:0 0 12px 0;">
        <label>Performed By
          <input type="text" id="hs-performed-by" value="${escapeHtml(pendingPerformedBy)}">
        </label>
      </div>
      <div id="hs-items-list"></div>
      <div class="card" style="max-width:600px;margin:12px 0;">
        <label>Overall Notes (optional)
          <textarea id="hs-overall-notes" rows="2"></textarea>
        </label>
        <button id="hs-submit-btn" class="btn-primary" style="width:100%;">Submit Checklist</button>
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
    if (!pendingPerformedBy || !pendingPerformedBy.trim()) {
      errEl.textContent = 'Please enter who performed this checklist.';
      return;
    }
    const missing = items.filter(i => i.InputType === 'PassFail' && !pendingResults[i.ItemID]?.result);
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
      const notes = container.querySelector('#hs-overall-notes').value.trim();
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
            categoryName: FAIL_TASK_CATEGORY[currentScan.qrTarget],
            title: `Plant Rounds: ${item.CheckItem} failed — ${QR_TARGET_LABEL[currentScan.qrTarget]}`,
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
        <button data-filter="DGSet" class="ops-tab-btn ${historyFilter==='DGSet'?'active':''}">DG Set</button>
        <button data-filter="PanelRoom" class="ops-tab-btn ${historyFilter==='PanelRoom'?'active':''}">DG Panel Room</button>
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
