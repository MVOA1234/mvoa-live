// ═══════════════════════════════════════════════════════════════
// MODULE: Daily Operations
// Columns (OpsTasks): TaskID | Title | Description | Priority |
//   AssetID | AssetName | CreatedBy | CreatedDate | PhotoURL_Initial |
//   Status | ComplianceComment | PhotoURL_Compliance | ClosedDate | ClosedBy
//
// NOTE on photos: capturePhoto() in shared.js returns a data URL in
// memory. Sheets cells can't hold binary/large data, so until the
// photo-storage destination (e.g. Google Drive upload) is built, this
// module tracks only whether a photo was attached (PhotoURL_* columns
// store the literal text "captured-pending-upload", not a real URL).
// Swap in a real upload call once that's ready.
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('ops', {
  label: 'Daily Operations',
  icon: '📋',
  roles: ['ALL'], // TESTING: opened to all roles temporarily — revert to ['FM','DEV'] (plus whichever else should have it) once roles are finalized
  init: function (container) {
    OpsModule.mount(container);
  }
});

const OpsModule = (function () {
  const TAB = MVOA.TABS.opsTasks;
  let tasksCache = [];
  let categories = [];
  let assigneeOptions = [];
  let currentCategory = null; // null = show sub-tile grid; otherwise the selected category object
  let currentView = 'open';
  let pendingAsset = null;
  let pendingAttachments = []; // up to 3: { name, file, isPhoto, compressedSizeBytes }
  let pendingAssignee = '';

  const COLS = ['TaskID','Title','Description','Priority','AssetID','AssetName',
    'CreatedBy','CreatedDate','PhotoURL_Initial','Status','ComplianceComment',
    'PhotoURL_Compliance','ClosedDate','ClosedBy','CategoryID','AssignedTo',
    'AttachmentURL_2','AttachmentURL_3',
    'ComplianceAttachmentURL_2','ComplianceAttachmentURL_3',
    'NoteCount','LastNoteAt','LastNoteAuthor','CreatorLastSeenNotesAt','AssigneeLastSeenNotesAt',
    'AssigneeSeenAt','DelegatedTo'];

  function rowToObj(row, rowNumber) {
    const o = { rowNumber };
    COLS.forEach((c, i) => o[c] = row[i] || '');
    return o;
  }
  function objToRow(o) { return COLS.map(c => o[c] !== undefined ? o[c] : ''); }

  // ───────────────────────────────────────────────────────────
  // Notes read-tracking — a task's two parties are its Assignor
  // (CreatedBy) and its Assignee (AssignedTo). Each has their own
  // "last seen notes" timestamp, so a note from one party shows as
  // unread for the other until they open the thread.
  // ───────────────────────────────────────────────────────────
  function isCreatorOf(t, user) { return t.CreatedBy === user.name; }
  function isAssigneeOf(t, user) {
    return !!t.AssignedTo && t.AssignedTo.indexOf('user:') === 0 && t.AssignedTo.substring('user:'.length) === user.name;
  }
  function hasUnreadNote(t, user) {
    if (!t.LastNoteAt || t.LastNoteAuthor === user.name) return false; // no notes yet, or your own latest note
    if (isCreatorOf(t, user)) return !t.CreatorLastSeenNotesAt || t.LastNoteAt > t.CreatorLastSeenNotesAt;
    if (isAssigneeOf(t, user)) return !t.AssigneeLastSeenNotesAt || t.LastNoteAt > t.AssigneeLastSeenNotesAt;
    return false;
  }
  async function markNotesSeen(t, user) {
    const field = isCreatorOf(t, user) ? 'CreatorLastSeenNotesAt' : (isAssigneeOf(t, user) ? 'AssigneeLastSeenNotesAt' : null);
    if (!field) return; // viewer is neither party to this task — nothing to mark
    const now = new Date().toISOString();
    t[field] = now;
    try {
      await MVOA.sheetsUpdateRow(TAB, t.rowNumber, objToRow(t));
    } catch (e) {
      // Non-critical — worst case the unread dot reappears next reload. No need to surface an error to the user.
    }
  }

  // ───────────────────────────────────────────────────────────
  // New-task indicator — a single shared flag per task (not per-viewer
  // like notes). Any viewer sees the 🆕 marker on the tile/card as long
  // as the assignee hasn't opened the task card yet. Only opening the
  // task card itself (not the category list) clears it, and only the
  // assignee's own open counts — other viewers opening it does nothing.
  // ───────────────────────────────────────────────────────────
  function isNewTask(t) {
    return !!t.AssignedTo && !t.AssigneeSeenAt;
  }
  async function markTaskSeen(t, user) {
    if (!isAssigneeOf(t, user) || !isNewTask(t)) return; // only the assignee's own open clears it
    t.AssigneeSeenAt = new Date().toISOString();
    try {
      await MVOA.sheetsUpdateRow(TAB, t.rowNumber, objToRow(t));
    } catch (e) {
      // Non-critical — worst case the 🆕 badge reappears next reload.
    }
  }

  // ───────────────────────────────────────────────────────────
  // Delegation — a second, informational level of assignment. The
  // assignee (AssignedTo) always stays the assignee of record for
  // notifications, notes read-tracking, and the By Assignee report;
  // DelegatedTo is just a visible "who's actually doing this" note
  // that only the assignee themself can set or clear. Only settable
  // as a later step on an existing task, never at task creation.
  // ───────────────────────────────────────────────────────────
  function isDelegateOf(t, user) {
    return !!t.DelegatedTo && t.DelegatedTo.indexOf('user:') === 0 && t.DelegatedTo.substring('user:'.length) === user.name;
  }
  async function setDelegate(t, delegateValue) {
    t.DelegatedTo = delegateValue; // '' clears it
    try {
      await MVOA.sheetsUpdateRow(TAB, t.rowNumber, objToRow(t));
      await MVOA.logAudit({
        module: 'DailyOps', requestId: t.TaskID,
        eventType: delegateValue ? 'Delegated' : 'DelegationCleared',
        comment: delegateValue ? ('To: ' + MVOA.assigneeLabel(delegateValue, assigneeOptions)) : '',
        statusAfter: t.Status
      });
    } catch (e) {
      throw e; // caller shows the error — this one shouldn't fail silently, unlike the "seen" stamps
    }
  }

  async function loadTasks() {
    const rows = await MVOA.sheetsRead(TAB);
    tasksCache = rows.slice(1).map((r, i) => rowToObj(r, i + 2)).filter(t => t.TaskID);
    updateBadge();
    return tasksCache;
  }

  function updateBadge() {
    const openCount = tasksCache.filter(t => t.Status === 'Open').length;
    MVOA.setAppBadge(openCount);
  }

  async function mount(container) {
    container.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      await Promise.all([loadTasks(), loadCategoriesAndAssignees()]);
    } catch (e) {
      container.innerHTML = `<p class="error-text">Could not load Daily Operations: ${e.message}</p>`;
      return;
    }
    currentCategory = null;
    renderRoot(container);
  }

  async function loadCategoriesAndAssignees(force) {
    categories = (await MVOA.loadCategories(force)).filter(c => c.Active);
    assigneeOptions = await MVOA.loadAssigneeOptions();
    await MVOA.loadDailyOpsPermissionsMatrix(force);
  }

  // ───────────────────────────────────────────────────────────
  // ROOT RENDER — either the sub-tile category grid, or (once a
  // category is selected) the existing tabbed task view scoped to it.
  // ───────────────────────────────────────────────────────────
  function renderRoot(container) {
    if (!currentCategory) {
      renderCategoryGrid(container);
    } else {
      render(container);
    }
  }

  function renderCategoryGrid(container) {
    const user = MVOA.getUser();
    const visibleCategories = categories.filter(cat => MVOA.canViewCategory(cat, user));
    if (!categories.length) {
      container.innerHTML = `<p class="muted">No categories set up yet. Ask a Developer to add some in Settings.</p>`;
      return;
    }
    if (!visibleCategories.length) {
      container.innerHTML = `<p class="muted">You don't have access to any Daily Operations categories yet. Ask a Developer to check your permissions.</p>`;
      return;
    }
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:14px;">
        <p class="muted" style="margin:0;">Choose a category</p>
        <div>
          <button id="ops-reports-btn" class="btn-secondary">📊 Reports</button>
          <button id="ops-cat-refresh-btn" class="btn-secondary">↻ Refresh</button>
        </div>
      </div>
      <div class="tiles-grid" id="ops-cat-tiles"></div>
    `;
    const tilesEl = container.querySelector('#ops-cat-tiles');
    visibleCategories.forEach(cat => {
      const canEdit = MVOA.canEditCategory(cat, user);
      const catTasks = tasksCache.filter(t => t.CategoryID === cat.CategoryID && t.Status === 'Open');
      const openCount = catTasks.length;
      const hasNewNote = catTasks.some(t => hasUnreadNote(t, user));
      const hasNewTask = catTasks.some(t => isNewTask(t));
      const div = document.createElement('div');
      div.className = 'tile' + (canEdit ? '' : ' tile-locked');
      div.innerHTML = `
        <div class="tile-icon">${cat.Icon || '📋'}</div>
        <div class="tile-label">${cat.Name}</div>
        <div class="muted" style="font-size:0.75rem;margin-top:4px;">${openCount} open${canEdit ? '' : ' · view only'}${hasNewTask ? ' · <span style="color:var(--mvoa-blue);font-weight:700;">🆕 new task</span>' : ''}${hasNewNote ? ' · <span style="color:var(--mvoa-blue);font-weight:700;">💬 new</span>' : ''}</div>
      `;
      div.addEventListener('click', () => {
        currentCategory = cat;
        currentView = canEdit ? 'new' : 'open';
        render(container);
      });
      tilesEl.appendChild(div);
    });
    container.querySelector('#ops-reports-btn').addEventListener('click', () => renderReports(container));
    container.querySelector('#ops-cat-refresh-btn').addEventListener('click', async () => {
      const btn = container.querySelector('#ops-cat-refresh-btn');
      btn.disabled = true; btn.textContent = '↻ Refreshing…';
      try {
        await Promise.all([loadTasks(), loadCategoriesAndAssignees(true)]);
        renderCategoryGrid(container);
      } catch (e) {
        btn.disabled = false; btn.textContent = '↻ Refresh';
        alert('Refresh failed: ' + e.message);
      }
    });
  }

  function render(container) {
    const user = MVOA.getUser();
    const isUncategorized = !!currentCategory._isUncategorized;
    const canEdit = isUncategorized ? true : MVOA.canEditCategory(currentCategory, user);
    const showNewTab = canEdit && !isUncategorized; // never offer "+ New Task" inside the Uncategorized bucket
    if (currentView === 'new' && !showNewTab) currentView = 'open';

    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="ops-back-to-cats" class="btn-secondary">← Categories</button>
        <strong>${currentCategory.Icon || '📋'} ${currentCategory.Name}</strong>
      </div>
      <div class="ops-tabs">
        ${showNewTab ? `<button data-view="new" class="ops-tab-btn ${currentView==='new'?'active':''}">+ New Task</button>` : ''}
        <button data-view="open" class="ops-tab-btn ${currentView==='open'?'active':''}">Open (${tasksCache.filter(t=>t.CategoryID===currentCategory.CategoryID && t.Status==='Open').length})</button>
        <button data-view="closed" class="ops-tab-btn ${currentView==='closed'?'active':''}">Closed</button>
        <button data-view="history" class="ops-tab-btn ${currentView==='history'?'active':''}">📅 History</button>
        <button id="ops-refresh-btn" class="ops-tab-btn" title="Reload from sheet" style="margin-left:auto;">↻ Refresh</button>
      </div>
      ${canEdit ? '' : `<p class="muted" style="margin-top:-6px;">View only — you don't have edit access to this category.</p>`}
      ${isUncategorized ? `<p class="muted" style="margin-top:-6px;">Legacy tasks created before categories existed. New tasks should be created inside a real category.</p>` : ''}
      <div id="ops-view-body"></div>
    `;
    container.querySelector('#ops-back-to-cats').addEventListener('click', () => {
      currentCategory = null;
      renderRoot(container);
    });
    container.querySelectorAll('.ops-tab-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => { currentView = btn.dataset.view; render(container); });
    });
    container.querySelector('#ops-refresh-btn').addEventListener('click', () => refreshNow(container));
    const body = container.querySelector('#ops-view-body');
    if (currentView === 'new') renderNewTaskForm(body, container);
    else if (currentView === 'history') renderHistory(body, container);
    else renderTaskList(body, container, currentView === 'open' ? 'Open' : 'Closed');
  }

  // Manual refresh — re-pulls from the Sheet on demand, independent of
  // any background auto-sync timer. Disables the button briefly and
  // shows a quick confirmation so it's obvious something happened.
  async function refreshNow(container) {
    const btn = container.querySelector('#ops-refresh-btn');
    if (!btn) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '↻ Refreshing…';
    try {
      await Promise.all([loadTasks(), loadCategoriesAndAssignees(true)]);
      render(container);
      const freshBtn = container.querySelector('#ops-refresh-btn');
      if (freshBtn) {
        freshBtn.textContent = '✓ Updated';
        setTimeout(() => { if (freshBtn) freshBtn.textContent = original; }, 1500);
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      alert('Refresh failed: ' + e.message);
    }
  }

  function renderNewTaskForm(body, container) {
    body.innerHTML = `
      <div class="card" style="max-width:520px;margin:0;">
        <label>Title
          <input id="ops-title" type="text" placeholder="e.g. Green waste accumulated at Villa B5">
        </label>
        <label>Description (optional)
          <textarea id="ops-desc" rows="2"></textarea>
        </label>
        <label>Priority
          <select id="ops-priority">
            <option value="Urgent">Urgent</option>
            <option value="Medium" selected>Medium</option>
            <option value="Low">Low</option>
          </select>
        </label>
        <label>Assigned To
          <select id="ops-assignee">
            <option value="">— Select someone —</option>
            ${assigneeOptions.map(o => `<option value="${o.value}" ${pendingAssignee===o.value?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </label>

        <div id="ops-asset-chip"></div>
        <button id="ops-scan-btn" class="btn-secondary" style="width:100%;margin-top:10px;">📷 Scan Asset QR (optional)</button>

        <div style="margin-top:12px;">
          <p class="muted" style="margin:0 0 6px;">Attachments (optional — up to 3 photos or documents)</p>
          <div id="ops-attachment-chips"></div>
          <div id="ops-attachment-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;"></div>
        </div>

        <button id="ops-submit-btn" class="btn-primary">Submit Task</button>
        <button id="ops-submit-another-btn" class="btn-secondary" style="width:100%;">Save &amp; Add Another</button>
        <p class="error-text" id="ops-form-error"></p>
        <p class="muted" id="ops-form-saved-msg"></p>
      </div>
    `;
    renderAssetChip(body);
    renderAttachmentChips(body, '#ops-attachment-chips', '#ops-attachment-btns', pendingAttachments, 3);
    body.querySelector('#ops-scan-btn').addEventListener('click', () => openQrScanner(body));
    body.querySelector('#ops-submit-btn').addEventListener('click', () => submitNewTask(body, container, { stayOnForm: false }));
    body.querySelector('#ops-submit-another-btn').addEventListener('click', () => submitNewTask(body, container, { stayOnForm: true }));
  }

  function renderAssetChip(body) {
    const el = body.querySelector('#ops-asset-chip');
    if (!el) return;
    el.innerHTML = pendingAsset
      ? `<div class="mvoa-row" style="margin-top:8px;"><span>📍 ${pendingAsset.assetName} <span class="muted">(${pendingAsset.assetId})</span></span>
         <button class="btn-secondary" id="ops-clear-asset">Clear</button></div>`
      : '';
    const clearBtn = el.querySelector('#ops-clear-asset');
    if (clearBtn) clearBtn.addEventListener('click', () => { pendingAsset = null; renderAssetChip(body); });
  }

  function formatKB(bytes) {
    return bytes > 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }

  // Reusable attachment picker: renders chips for each attachment in the
  // given array, plus "Add Photo" / "Add Document" buttons when under the
  // max limit. Mutates the attachments array in place so the caller (submit
  // handler or close dialog) always reads the current state.
  function renderAttachmentChips(scope, chipsSelector, btnsSelector, attachments, maxCount) {
    const chipsEl = typeof chipsSelector === 'string' ? scope.querySelector(chipsSelector) : chipsSelector;
    const btnsEl = typeof btnsSelector === 'string' ? scope.querySelector(btnsSelector) : btnsSelector;
    if (!chipsEl || !btnsEl) return;

    chipsEl.innerHTML = attachments.map((a, i) => `
      <div class="mvoa-row" style="margin-bottom:4px;">
        <span>${a.isPhoto ? '📷' : '📄'} ${escapeHtml(a.name)} <span class="muted">(${formatKB(a.compressedSizeBytes)})</span></span>
        <button class="btn-secondary att-remove" data-idx="${i}" style="padding:4px 10px;margin:0;">✕</button>
      </div>
    `).join('');

    chipsEl.querySelectorAll('.att-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        attachments.splice(parseInt(btn.dataset.idx), 1);
        renderAttachmentChips(scope, chipsSelector, btnsSelector, attachments, maxCount);
      });
    });

    if (attachments.length < maxCount) {
      btnsEl.innerHTML = `
        <button class="btn-secondary att-photo-pick">📷 Add Photo</button>
        <button class="btn-secondary att-doc-pick">📄 Add Document</button>
      `;
      btnsEl.querySelector('.att-photo-pick').addEventListener('click', async () => {
        const a = await MVOA.pickAttachment({ photoOnly: true, useCamera: true });
        if (a) { attachments.push(a); renderAttachmentChips(scope, chipsSelector, btnsSelector, attachments, maxCount); }
      });
      btnsEl.querySelector('.att-doc-pick').addEventListener('click', async () => {
        const a = await MVOA.pickAttachment({ photoOnly: false, useCamera: false });
        if (a) { attachments.push(a); renderAttachmentChips(scope, chipsSelector, btnsSelector, attachments, maxCount); }
      });
    } else {
      btnsEl.innerHTML = `<p class="muted" style="margin:0;">Maximum ${maxCount} attachments reached.</p>`;
    }
  }

  let isSubmittingTask = false; // hard re-entrancy guard — see submitNewTask

  async function submitNewTask(body, container, opts) {
    // Checked synchronously, first line, before touching the DOM or state.
    // A disabled button alone isn't enough: two taps close enough together
    // can both dispatch click events before the first handler's disabling
    // code actually runs, so both handlers would otherwise execute fully.
    if (isSubmittingTask) return;
    isSubmittingTask = true;
    try {
      await doSubmitNewTask(body, container, opts);
    } finally {
      isSubmittingTask = false;
    }
  }

  async function doSubmitNewTask(body, container, opts) {
    opts = opts || {};
    const submitBtn = body.querySelector('#ops-submit-btn');
    const submitAnotherBtn = body.querySelector('#ops-submit-another-btn');
    if (submitBtn) submitBtn.disabled = true;
    if (submitAnotherBtn) submitAnotherBtn.disabled = true;

    const title = body.querySelector('#ops-title').value.trim();
    const desc = body.querySelector('#ops-desc').value.trim();
    const priority = body.querySelector('#ops-priority').value;
    const assignedTo = body.querySelector('#ops-assignee').value;
    const errEl = body.querySelector('#ops-form-error');
    const savedEl = body.querySelector('#ops-form-saved-msg');
    errEl.textContent = ''; savedEl.textContent = '';
    if (!title) {
      errEl.textContent = 'Title is required.';
      if (submitBtn) submitBtn.disabled = false;
      if (submitAnotherBtn) submitAnotherBtn.disabled = false;
      return;
    }
    if (!assignedTo) {
      errEl.textContent = 'Please assign this task to someone — every task needs an assignee.';
      if (submitBtn) submitBtn.disabled = false;
      if (submitAnotherBtn) submitAnotherBtn.disabled = false;
      return;
    }

    const user = MVOA.getUser();
    await loadTasks();
    const existingIds = tasksCache.map(t => t.TaskID);
    const taskId = MVOA.nextId('TASK', existingIds);
    const now = new Date().toISOString();

    const attachmentUrls = ['', '', ''];
    if (pendingAttachments.length) {
      errEl.textContent = `Uploading ${pendingAttachments.length} attachment(s)…`;
      for (let i = 0; i < Math.min(pendingAttachments.length, 3); i++) {
        const att = pendingAttachments[i];
        try {
          attachmentUrls[i] = await MVOA.uploadPhotoToDrive(att.file, `${taskId}_att${i+1}_${att.name}`);
        } catch (e) {
          errEl.textContent = `Attachment ${i+1} upload failed: ${e.message} — remove it or fix Drive setup and retry.`;
          if (submitBtn) submitBtn.disabled = false;
          if (submitAnotherBtn) submitAnotherBtn.disabled = false;
          return;
        }
      }
    }
    errEl.textContent = '';

    const row = {
      TaskID: taskId, Title: title, Description: desc, Priority: priority,
      AssetID: pendingAsset ? pendingAsset.assetId : '',
      AssetName: pendingAsset ? pendingAsset.assetName : '',
      CreatedBy: user.name, CreatedDate: now,
      PhotoURL_Initial: attachmentUrls[0],
      Status: 'Open', ComplianceComment: '', PhotoURL_Compliance: '', ClosedDate: '', ClosedBy: '',
      CategoryID: currentCategory.CategoryID, AssignedTo: assignedTo,
      AttachmentURL_2: attachmentUrls[1], AttachmentURL_3: attachmentUrls[2],
      ComplianceAttachmentURL_2: '', ComplianceAttachmentURL_3: ''
    };

    try {
      await MVOA.sheetsAppend(TAB, objToRow(row));
      await MVOA.logAudit({ module: 'DailyOps', requestId: taskId, eventType: 'Created', comment: title, statusAfter: 'Open' });
    } catch (e) {
      errEl.textContent = 'Could not save task: ' + e.message;
      if (submitBtn) submitBtn.disabled = false;
      if (submitAnotherBtn) submitAnotherBtn.disabled = false;
      return;
    }

    pendingAsset = null; pendingAttachments = []; pendingAssignee = '';
    await loadTasks();

    if (opts.stayOnForm) {
      render(container);
      const freshBody = container.querySelector('#ops-view-body');
      const msg = freshBody && freshBody.querySelector('#ops-form-saved-msg');
      if (msg) msg.textContent = `✓ "${title}" saved. Add the next task below.`;
    } else {
      currentView = 'open';
      render(container);
    }
  }

  function openQrScanner(body) {
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box">
        <video id="ops-qr-video" autoplay playsinline muted></video>
        <canvas id="ops-qr-canvas" style="display:none;"></canvas>
        <p class="muted" id="ops-qr-status">Point camera at the asset's QR label…</p>
        <button id="ops-qr-cancel" class="btn-secondary">Cancel</button>
      </div>
    `;
    document.body.appendChild(modal);

    const video = modal.querySelector('#ops-qr-video');
    const canvas = modal.querySelector('#ops-qr-canvas');
    const statusEl = modal.querySelector('#ops-qr-status');
    let stream, raf;

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(t => t.stop());
      modal.remove();
    }
    modal.querySelector('#ops-qr-cancel').addEventListener('click', stop);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(s => {
        stream = s;
        video.srcObject = s;
        tick();
      })
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
            pendingAsset = parsed;
            renderAssetChip(body);
            stop();
            return;
          } else {
            statusEl.innerHTML = `Scanned, but not a recognised MVOA format.<br><span style="font-size:0.75rem;word-break:break-all;">Raw: ${escapeHtml(code.data)}</span><br>Keep trying or cancel.`;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
  }

  function renderTaskList(body, container, statusFilter) {
    const user = MVOA.getUser();
    const canEdit = MVOA.canEditCategory(currentCategory, user) || !!currentCategory._isUncategorized;
    const list = tasksCache.filter(t => t.CategoryID === currentCategory.CategoryID && t.Status === statusFilter)
      .sort((a, b) => (b.CreatedDate || '').localeCompare(a.CreatedDate || ''));
    if (!list.length) {
      body.innerHTML = `<p class="muted">No ${statusFilter.toLowerCase()} tasks.</p>`;
      return;
    }
    body.innerHTML = list.map(t => {
      const noteCount = Number(t.NoteCount) || 0;
      const unread = statusFilter === 'Open' && hasUnreadNote(t, user);
      const isNew = statusFilter === 'Open' && isNewTask(t);
      return `
      <div class="mvoa-list-item" data-task-id="${t.TaskID}">
        <div class="mvoa-row">
          <strong>${escapeHtml(t.Title)}</strong>
          <span>${isNew ? `<span class="ops-new-task-badge" style="color:var(--mvoa-blue);font-weight:700;font-size:0.8rem;margin-right:8px;">🆕 New</span>` : ''}${MVOA.statusBadgeHtml(t.Status === 'Open' ? 'Open' : 'Closed')}</span>
        </div>
        ${t.Description ? `<p class="muted" style="margin:6px 0;">${escapeHtml(t.Description)}</p>` : ''}
        ${t.AssetName ? `<p class="muted" style="margin:4px 0;">📍 ${escapeHtml(t.AssetName)} (${escapeHtml(t.AssetID)})</p>` : ''}
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">By ${escapeHtml(t.CreatedBy)} · ${formatDate(t.CreatedDate)} · Priority: ${escapeHtml(t.Priority)}${t.AssignedTo ? ' · 👤 ' + escapeHtml(MVOA.assigneeLabel(t.AssignedTo, assigneeOptions)) : ''}</p>
        ${t.DelegatedTo ? `<p class="muted" style="margin:-2px 0 4px;font-size:0.8rem;">↳ Delegated to: 👤 ${escapeHtml(MVOA.assigneeLabel(t.DelegatedTo, assigneeOptions))}</p>` : ''}
        ${attachmentLinksHtml(t)}
        ${statusFilter === 'Open'
          ? `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
               <button class="ops-notes-toggle btn-secondary" data-task-id="${t.TaskID}" style="font-size:0.8rem;padding:4px 10px;margin:0;position:relative;">💬 Notes${noteCount ? ` (${noteCount})` : ''}${unread ? ` <span class="ops-unread-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d9534f;margin-left:4px;"></span>` : ''}</button>
               ${isAssigneeOf(t, user) ? `<button class="ops-delegate-toggle btn-secondary" data-task-id="${t.TaskID}" style="font-size:0.8rem;padding:4px 10px;margin:0;">🔀 ${t.DelegatedTo ? 'Change Delegate' : 'Delegate'}</button>` : ''}
             </div>
             <div class="ops-notes-body hidden" data-task-id="${t.TaskID}"></div>
             <div class="ops-delegate-body hidden" data-task-id="${t.TaskID}"></div>
             ${canEdit ? `<button class="btn-primary ops-comply-btn" data-task-id="${t.TaskID}" style="margin-top:8px;">Mark Compliant / Close</button>` : ''}`
          : `<p class="muted" style="font-size:0.8rem;margin-top:6px;">Closed by ${escapeHtml(t.ClosedBy)} · ${formatDate(t.ClosedDate)}${t.ComplianceComment ? ' — ' + escapeHtml(t.ComplianceComment) : ''}</p>${attachmentLinksHtml(t, true)}`}
      </div>
    `;
    }).join('');

    if (statusFilter === 'Open') {
      body.querySelectorAll('.mvoa-list-item').forEach(card => {
        card.addEventListener('click', async () => {
          const taskId = card.dataset.taskId;
          const task = tasksCache.find(x => x.TaskID === taskId);
          if (task && isAssigneeOf(task, user) && isNewTask(task)) {
            await markTaskSeen(task, user);
            const badge = card.querySelector('.ops-new-task-badge');
            if (badge) badge.remove();
          }
        });
      });
    }

    body.querySelectorAll('.ops-notes-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const taskId = btn.dataset.taskId;
        const notesBody = body.querySelector(`.ops-notes-body[data-task-id="${taskId}"]`);
        const isHidden = notesBody.classList.contains('hidden');
        if (!isHidden) { notesBody.classList.add('hidden'); return; }
        notesBody.classList.remove('hidden');
        await renderNotesThread(notesBody, taskId, btn, canEdit);
        const task = tasksCache.find(x => x.TaskID === taskId);
        if (task && hasUnreadNote(task, user)) {
          await markNotesSeen(task, user);
          const dot = btn.querySelector('.ops-unread-dot');
          if (dot) dot.remove();
        }
      });
    });

    body.querySelectorAll('.ops-delegate-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const taskId = btn.dataset.taskId;
        const formBody = body.querySelector(`.ops-delegate-body[data-task-id="${taskId}"]`);
        const isHidden = formBody.classList.contains('hidden');
        if (!isHidden) { formBody.classList.add('hidden'); return; }
        formBody.classList.remove('hidden');
        renderDelegateForm(formBody, taskId, btn, container);
      });
    });

    body.querySelectorAll('.ops-comply-btn').forEach(btn => {
      btn.addEventListener('click', () => openComplyDialog(btn.dataset.taskId, container));
    });
  }

  // Inline picker shown when the assignee taps "Delegate" / "Change
  // Delegate" on their own task. Only the assignee ever sees this
  // control (gated in renderTaskList), so no separate canEdit check
  // is needed here.
  function renderDelegateForm(formBody, taskId, toggleBtn, container) {
    const task = tasksCache.find(t => t.TaskID === taskId);
    if (!task) return;
    formBody.innerHTML = `
      <div style="margin-top:8px;padding:10px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);">
        <label style="margin:0;">Delegate this task to
          <select id="ops-delegate-select-${taskId}">
            <option value="">— No delegate —</option>
            ${assigneeOptions.map(o => `<option value="${o.value}" ${task.DelegatedTo===o.value?'selected':''}>${escapeHtml(o.label)}</option>`).join('')}
          </select>
        </label>
        <button class="btn-primary ops-delegate-save" data-task-id="${taskId}" style="margin-top:8px;width:100%;">Save</button>
        <p class="error-text ops-delegate-error" style="min-height:1em;margin-top:4px;"></p>
      </div>
    `;
    const errEl = formBody.querySelector('.ops-delegate-error');
    formBody.querySelector('.ops-delegate-save').addEventListener('click', async () => {
      const select = formBody.querySelector(`#ops-delegate-select-${taskId}`);
      const btn = formBody.querySelector('.ops-delegate-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await setDelegate(task, select.value);
        formBody.classList.add('hidden');
        render(container); // full re-render — picks up the new delegation line and updated button label
      } catch (e) {
        errEl.textContent = 'Could not save: ' + e.message;
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  }


  async function renderNotesThread(notesBody, taskId, toggleBtn, canEdit) {
    notesBody.innerHTML = `<p class="muted" style="font-size:0.8rem;padding:8px 0;">Loading notes…</p>`;
    let notes;
    try {
      notes = await MVOA.loadNotesForTask(taskId);
    } catch (e) {
      notesBody.innerHTML = `<p class="error-text">Could not load notes: ${escapeHtml(e.message)}</p>`;
      return;
    }
    const existingDot = toggleBtn.querySelector('.ops-unread-dot');
    toggleBtn.innerHTML = `💬 Notes${notes.length ? ` (${notes.length})` : ''}` + (existingDot ? existingDot.outerHTML : '');
    const notesHtml = notes.length
      ? notes.map(n => `
          <div style="border-left:3px solid var(--mvoa-blue);padding:6px 10px;margin-bottom:8px;background:var(--bg);border-radius:0 6px 6px 0;">
            <div class="mvoa-row" style="margin-bottom:2px;">
              <strong style="font-size:0.85rem;">${escapeHtml(n.Author)}</strong>
              <span class="muted" style="font-size:0.75rem;">${formatDate(n.Timestamp)}</span>
            </div>
            <p style="margin:0;font-size:0.9rem;">${escapeHtml(n.Note)}</p>
          </div>`).join('')
      : `<p class="muted" style="font-size:0.8rem;padding:4px 0;">No notes yet — be the first to add one.</p>`;

    const addNoteForm = canEdit ? `
      <div style="margin-top:8px;">
        <textarea id="ops-note-text-${taskId}" rows="2" placeholder="Type a note, question or update…" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:8px;font-size:0.9rem;resize:vertical;box-sizing:border-box;"></textarea>
        <button class="btn-primary ops-note-submit" data-task-id="${taskId}" style="margin-top:6px;width:100%;">Add Note</button>
        <p class="error-text ops-note-error" style="min-height:1em;margin-top:4px;"></p>
      </div>` : '';

    notesBody.innerHTML = `
      <div style="margin-top:8px;padding:10px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);">
        ${notesHtml}
        ${addNoteForm}
      </div>`;

    if (canEdit) {
      const submitBtn = notesBody.querySelector('.ops-note-submit');
      const textarea = notesBody.querySelector(`#ops-note-text-${taskId}`);
      const errEl = notesBody.querySelector('.ops-note-error');
      submitBtn.addEventListener('click', async () => {
        const text = textarea.value.trim();
        errEl.textContent = '';
        if (!text) { errEl.textContent = 'Note cannot be empty.'; return; }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
        try {
          await MVOA.appendNote(taskId, text);
          textarea.value = '';
          await stampNoteMetadata(taskId);
          await renderNotesThread(notesBody, taskId, toggleBtn, canEdit);
        } catch (e) {
          errEl.textContent = 'Could not save note: ' + escapeHtml(e.message);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add Note';
        }
      });
    }
  }

  // Denormalizes the latest-note info onto the OpsTasks row itself (count,
  // timestamp, author) so task cards and category tiles can show note
  // counts/unread indicators without loading every task's full thread.
  // Also stamps the author's own "last seen" field, since posting a note
  // means they've implicitly seen everything up to that point.
  async function stampNoteMetadata(taskId) {
    const task = tasksCache.find(t => t.TaskID === taskId);
    if (!task) return;
    const user = MVOA.getUser();
    task.NoteCount = (Number(task.NoteCount) || 0) + 1;
    task.LastNoteAt = new Date().toISOString();
    task.LastNoteAuthor = user.name;
    if (isCreatorOf(task, user)) task.CreatorLastSeenNotesAt = task.LastNoteAt;
    if (isAssigneeOf(task, user)) task.AssigneeLastSeenNotesAt = task.LastNoteAt;
    try {
      await MVOA.sheetsUpdateRow(TAB, task.rowNumber, objToRow(task));
    } catch (e) {
      // Non-critical — the notes thread itself already saved; worst case
      // the count/unread badge is stale until next reload.
    }
  }



  // ───────────────────────────────────────────────────────────
  // HISTORY — date-range view across ALL tasks (open + closed),
  // filtered by CreatedDate or ClosedDate falling in the chosen range.
  // ───────────────────────────────────────────────────────────
  let historyFrom = '';
  let historyTo = '';
  function renderHistory(body, container) {
    body.innerHTML = `
      <div class="card" style="max-width:600px;margin:0 0 16px 0;">
        <div class="mvoa-row" style="gap:10px;flex-wrap:wrap;">
          <label style="flex:1;min-width:140px;">From
            <input type="date" id="ops-hist-from" value="${historyFrom}">
          </label>
          <label style="flex:1;min-width:140px;">To
            <input type="date" id="ops-hist-to" value="${historyTo}">
          </label>
        </div>
        <button id="ops-hist-apply" class="btn-primary">Apply</button>
        <button id="ops-hist-clear" class="btn-secondary">Clear</button>
      </div>
      <div id="ops-hist-results"></div>
    `;
    body.querySelector('#ops-hist-apply').addEventListener('click', () => {
      historyFrom = body.querySelector('#ops-hist-from').value;
      historyTo = body.querySelector('#ops-hist-to').value;
      renderHistoryResults(body);
    });
    body.querySelector('#ops-hist-clear').addEventListener('click', () => {
      historyFrom = ''; historyTo = '';
      body.querySelector('#ops-hist-from').value = '';
      body.querySelector('#ops-hist-to').value = '';
      renderHistoryResults(body);
    });
    renderHistoryResults(body);
  }

  function renderHistoryResults(body) {
    const resultsEl = body.querySelector('#ops-hist-results');
    const fromTs = historyFrom ? new Date(historyFrom + 'T00:00:00').getTime() : -Infinity;
    const toTs = historyTo ? new Date(historyTo + 'T23:59:59').getTime() : Infinity;

    const inRange = iso => {
      if (!iso) return false;
      const t = new Date(iso).getTime();
      return !isNaN(t) && t >= fromTs && t <= toTs;
    };

    const list = tasksCache.filter(t => t.CategoryID === currentCategory.CategoryID && (inRange(t.CreatedDate) || inRange(t.ClosedDate)))
      .sort((a, b) => (b.CreatedDate || '').localeCompare(a.CreatedDate || ''));

    if (!list.length) {
      resultsEl.innerHTML = `<p class="muted">No tasks ${historyFrom || historyTo ? 'in that date range' : 'yet'}.</p>`;
      return;
    }
    resultsEl.innerHTML = `<p class="muted">${list.length} task(s)</p>` + list.map(t => `
      <div class="mvoa-list-item">
        <div class="mvoa-row">
          <strong>${t.Title}</strong>
          ${MVOA.statusBadgeHtml(t.Status === 'Open' ? 'Open' : 'Closed')}
        </div>
        ${t.AssetName ? `<p class="muted" style="margin:4px 0;">📍 ${t.AssetName} (${t.AssetID})</p>` : ''}
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">Created by ${t.CreatedBy} · ${formatDate(t.CreatedDate)} · Priority: ${t.Priority}${t.AssignedTo ? ' · 👤 ' + escapeHtml(MVOA.assigneeLabel(t.AssignedTo, assigneeOptions)) : ''}</p>
        ${t.Status === 'Closed' ? `<p class="muted" style="font-size:0.8rem;">Closed by ${t.ClosedBy} · ${formatDate(t.ClosedDate)}${t.ComplianceComment ? ' — ' + t.ComplianceComment : ''}</p>` : ''}
      </div>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Returns HTML showing all attachment links for a task card.
  function attachmentLinksHtml(t, forCompliance) {
    const urls = forCompliance
      ? [t.PhotoURL_Compliance, t.ComplianceAttachmentURL_2, t.ComplianceAttachmentURL_3]
      : [t.PhotoURL_Initial, t.AttachmentURL_2, t.AttachmentURL_3];
    const links = urls.filter(Boolean).map((url, i) =>
      `<a href="${url}" target="_blank" rel="noopener">📎 Attachment ${i + 1}</a>`
    ).join(' · ');
    return links ? `<p class="muted" style="font-size:0.8rem;">${links}</p>` : '';
  }

  function openComplyDialog(taskId, container) {
    const task = tasksCache.find(t => t.TaskID === taskId);
    if (!task) return;
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box" style="text-align:left;">
        <h3>Close: ${escapeHtml(task.Title)}</h3>
        <label>Compliance Comment <span style="color:#b3261e;">*</span>
          <textarea id="ops-comply-comment" rows="3" placeholder="What was done? (required)"></textarea>
        </label>
        <p class="muted" style="margin-top:-4px;font-size:0.8rem;">Required — cannot close without a comment.</p>
        <div style="margin-top:12px;">
          <p class="muted" style="margin:0 0 6px;">Attachments (optional — up to 3)</p>
          <div id="ops-comply-chips"></div>
          <div id="ops-comply-att-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;"></div>
        </div>
        <button id="ops-comply-submit" class="btn-primary">Confirm Close</button>
        <button id="ops-comply-cancel" class="btn-secondary">Cancel</button>
        <p class="error-text" id="ops-comply-error"></p>
      </div>
    `;
    document.body.appendChild(modal);

    const closeAttachments = [];
    renderAttachmentChips(modal, '#ops-comply-chips', '#ops-comply-att-btns', closeAttachments, 3);

    modal.querySelector('#ops-comply-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#ops-comply-submit').addEventListener('click', async () => {
      const comment = modal.querySelector('#ops-comply-comment').value.trim();
      const errEl = modal.querySelector('#ops-comply-error');
      errEl.textContent = '';

      // Mandatory compliance comment
      if (!comment) {
        errEl.textContent = 'A compliance comment is required before closing this task.';
        modal.querySelector('#ops-comply-comment').focus();
        return;
      }

      const confirmBtn = modal.querySelector('#ops-comply-submit');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Closing…';

      const complianceUrls = ['', '', ''];
      if (closeAttachments.length) {
        confirmBtn.textContent = `Uploading ${closeAttachments.length} attachment(s)…`;
        for (let i = 0; i < Math.min(closeAttachments.length, 3); i++) {
          const att = closeAttachments[i];
          try {
            complianceUrls[i] = await MVOA.uploadPhotoToDrive(att.file, `${taskId}_compliance${i+1}_${att.name}`);
          } catch (e) {
            errEl.textContent = `Attachment ${i+1} upload failed: ${e.message}`;
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Close';
            return;
          }
        }
      }

      const user = MVOA.getUser();
      const now = new Date().toISOString();
      const updated = Object.assign({}, task, {
        Status: 'Closed', ComplianceComment: comment,
        PhotoURL_Compliance: complianceUrls[0],
        ClosedDate: now, ClosedBy: user.name,
        ComplianceAttachmentURL_2: complianceUrls[1],
        ComplianceAttachmentURL_3: complianceUrls[2]
      });
      try {
        await MVOA.sheetsUpdateRow(TAB, task.rowNumber, objToRow(updated));
        await MVOA.logAudit({ module: 'DailyOps', requestId: taskId, eventType: 'Completed', comment, statusAfter: 'Closed' });
      } catch (e) {
        errEl.textContent = 'Could not close task: ' + e.message;
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm Close';
        return;
      }
      modal.remove();
      currentView = 'closed';
      await loadTasks();
      render(container);
    });
  }


  // ───────────────────────────────────────────────────────────
  // REPORTS — Tasks by Category, Tasks by Assignee, Overdue/Aging.
  // Each renders an on-screen table plus CSV export and Print-to-PDF
  // buttons, matching the pattern used in the Inventory app.
  // ───────────────────────────────────────────────────────────
  let reportView = 'byCategory';
  const OVERDUE_DAYS_THRESHOLD = 3;

  function categoryName(categoryId) {
    if (!categoryId) return 'Uncategorized';
    const c = categories.find(c => c.CategoryID === categoryId);
    return c ? c.Name : categoryId;
  }

  function daysOpen(createdDate) {
    const t = new Date(createdDate).getTime();
    if (isNaN(t)) return 0;
    return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
  }

  function renderReports(container) {
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="ops-reports-back" class="btn-secondary">← Categories</button>
        <strong>📊 Reports</strong>
      </div>
      <div class="ops-tabs">
        <button data-report="byCategory" class="ops-tab-btn ${reportView==='byCategory'?'active':''}">By Category</button>
        <button data-report="byAssignee" class="ops-tab-btn ${reportView==='byAssignee'?'active':''}">By Assignee</button>
        <button data-report="overdue" class="ops-tab-btn ${reportView==='overdue'?'active':''}">Overdue / Aging</button>
      </div>
      <div id="ops-report-body"></div>
    `;
    container.querySelector('#ops-reports-back').addEventListener('click', () => { currentCategory = null; renderRoot(container); });
    container.querySelectorAll('.ops-tab-btn[data-report]').forEach(btn => {
      btn.addEventListener('click', () => { reportView = btn.dataset.report; renderReports(container); });
    });
    const body = container.querySelector('#ops-report-body');
    if (reportView === 'byCategory') renderReportByCategory(body);
    else if (reportView === 'byAssignee') renderReportByAssignee(body);
    else renderReportOverdue(body);
  }

  let reportStatusFilter = 'all'; // 'all' | 'Open' | 'Closed' — applies to By Category and By Assignee

  function renderReportByCategory(body) {
    const allCatIds = categories.map(c => c.CategoryID).concat(['']); // '' = Uncategorized bucket
    const rows = allCatIds.map(id => {
      const inCat = tasksCache.filter(t => t.CategoryID === id);
      const openCount = inCat.filter(t => t.Status === 'Open').length;
      const closedCount = inCat.filter(t => t.Status === 'Closed').length;
      const row = { Category: categoryName(id), Total: inCat.length };
      if (reportStatusFilter === 'Open') row.Open = openCount;
      else if (reportStatusFilter === 'Closed') row.Closed = closedCount;
      else { row.Open = openCount; row.Closed = closedCount; }
      return row;
    }).filter(r => r.Total > 0);

    const columns = reportStatusFilter === 'Open' ? ['Category', 'Open', 'Total']
      : reportStatusFilter === 'Closed' ? ['Category', 'Closed', 'Total']
      : ['Category', 'Open', 'Closed', 'Total'];

    body.innerHTML = '';
    renderReportStatusSelector(body);
    renderReportTable(body, {
      title: 'Tasks by Category' + (reportStatusFilter !== 'all' ? ` (${reportStatusFilter} only)` : ''),
      columns,
      rows,
      filenameBase: 'ops-report-by-category' + (reportStatusFilter !== 'all' ? '-' + reportStatusFilter.toLowerCase() : ''),
      append: true
    });
  }

  function renderReportByAssignee(body) {
    const map = {};
    tasksCache.forEach(t => {
      const key = t.AssignedTo || '';
      if (!map[key]) map[key] = [];
      map[key].push(t);
    });
    const rows = Object.keys(map).map(key => {
      const list = map[key];
      const openList = list.filter(t => t.Status === 'Open');
      const closedList = list.filter(t => t.Status === 'Closed');
      const closedWithDates = closedList.filter(t => t.CreatedDate && t.ClosedDate);
      const avgDaysToClose = closedWithDates.length
        ? Math.round(closedWithDates.reduce((sum, t) => sum + (new Date(t.ClosedDate) - new Date(t.CreatedDate)) / (1000*60*60*24), 0) / closedWithDates.length * 10) / 10
        : '';
      const avgDaysOpen = openList.length
        ? Math.round(openList.reduce((sum, t) => sum + daysOpen(t.CreatedDate), 0) / openList.length * 10) / 10
        : 0;
      const row = {
        Assignee: key ? MVOA.assigneeLabel(key, assigneeOptions) : 'Unassigned',
        _key: key, _openCount: openList.length, _closedCount: closedList.length
      };
      if (reportStatusFilter === 'Open') {
        row.Open = openList.length ? `${openList.length} (avg ${avgDaysOpen}d open)` : '0';
      } else if (reportStatusFilter === 'Closed') {
        row.Closed = closedList.length;
        row['Avg Days to Close'] = avgDaysToClose;
      } else {
        row.Open = openList.length ? `${openList.length} (avg ${avgDaysOpen}d open)` : '0';
        row.Closed = closedList.length;
        row['Avg Days to Close'] = avgDaysToClose;
      }
      return row;
    }).sort((a, b) => reportStatusFilter === 'Closed' ? b._closedCount - a._closedCount : b._openCount - a._openCount);

    const columns = reportStatusFilter === 'Open' ? ['Assignee', 'Open']
      : reportStatusFilter === 'Closed' ? ['Assignee', 'Closed', 'Avg Days to Close']
      : ['Assignee', 'Open', 'Closed', 'Avg Days to Close'];

    body.innerHTML = '';
    renderReportStatusSelector(body);
    renderAssigneeSelector(body, rows);

    renderReportTable(body, {
      title: 'Tasks by Assignee' + (reportStatusFilter !== 'all' ? ` (${reportStatusFilter} only)` : ''),
      columns,
      rows,
      filenameBase: 'ops-report-by-assignee' + (reportStatusFilter !== 'all' ? '-' + reportStatusFilter.toLowerCase() : ''),
      append: true,
      onRowClick: row => renderAssigneeDrillDown(body, row)
    });
  }

  // Status filter shared by By Category and By Assignee — re-renders
  // whichever of those two reports is currently active on change.
  function renderReportStatusSelector(body) {
    body.insertAdjacentHTML('beforeend', `
      <div class="card" style="max-width:320px;margin:0 0 14px 0;">
        <label style="margin:0;">Status
          <select id="ops-report-status-filter">
            <option value="all" ${reportStatusFilter==='all'?'selected':''}>All (Open + Closed)</option>
            <option value="Open" ${reportStatusFilter==='Open'?'selected':''}>Open only</option>
            <option value="Closed" ${reportStatusFilter==='Closed'?'selected':''}>Closed only</option>
          </select>
        </label>
      </div>
    `);
    body.querySelector('#ops-report-status-filter').addEventListener('change', e => {
      reportStatusFilter = e.target.value;
      if (reportView === 'byCategory') renderReportByCategory(body);
      else if (reportView === 'byAssignee') renderReportByAssignee(body);
    });
  }

  // Dropdown alternative to tapping a table row — jumps straight to one
  // assignee's drill-down. Placed above the table.
  function renderAssigneeSelector(body, rows) {
    body.insertAdjacentHTML('beforeend', `
      <div class="card" style="max-width:520px;margin:0 0 14px 0;">
        <label style="margin:0;">Jump to a specific assignee
          <select id="ops-assignee-select">
            <option value="">— Select —</option>
            ${rows.map((r, i) => `<option value="${i}">${escapeHtml(r.Assignee)}</option>`).join('')}
          </select>
        </label>
      </div>
    `);
    body.querySelector('#ops-assignee-select').addEventListener('change', e => {
      if (e.target.value === '') return;
      const row = rows[parseInt(e.target.value, 10)];
      if (row) renderAssigneeDrillDown(body, row);
    });
  }

  // Shows a summary + open-tasks list for one assignee, right below the
  // table, when their row is tapped in the By Assignee report (or
  // selected via the dropdown above it).
  function renderAssigneeDrillDown(body, row) {
    let panel = body.querySelector('#ops-assignee-drilldown');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ops-assignee-drilldown';
      panel.className = 'card';
      panel.style.marginTop = '14px';
      body.appendChild(panel);
    }
    const list = tasksCache.filter(t => (t.AssignedTo || '') === row._key);
    const openList = list.filter(t => t.Status === 'Open')
      .sort((a, b) => daysOpen(b.CreatedDate) - daysOpen(a.CreatedDate));
    const closedCount = list.filter(t => t.Status === 'Closed').length;

    panel.innerHTML = `
      <div class="mvoa-row">
        <h3 style="margin:0;color:var(--mvoa-blue);">${escapeHtml(row.Assignee)}'s Tasks</h3>
        <div>
          <button class="btn-secondary" id="ops-drilldown-pdf">🖨 Print to PDF</button>
          <button class="btn-secondary" id="ops-drilldown-close">✕ Close</button>
        </div>
      </div>
      <p class="muted" style="margin:6px 0;"><strong style="color:var(--mvoa-blue);">Open:</strong> ${openList.length} &nbsp;&nbsp; <strong style="color:var(--mvoa-blue);">Closed:</strong> ${closedCount}</p>
      <div style="margin-top:10px;">
        <p class="muted" style="margin:0 0 6px;font-weight:600;">Open Tasks</p>
        ${openList.length ? openList.map(t => `
          <div class="mvoa-row" style="padding:6px 0;border-bottom:1px solid var(--border);">
            <span>${escapeHtml(t.Title)}</span>
            <span class="muted" style="font-size:0.85rem;white-space:nowrap;">${daysOpen(t.CreatedDate)}d open</span>
          </div>
        `).join('') : '<p class="muted">No open tasks.</p>'}
      </div>
    `;
    panel.querySelector('#ops-drilldown-close').addEventListener('click', () => panel.remove());
    panel.querySelector('#ops-drilldown-pdf').addEventListener('click', () => printAssigneeDrillDownPdf(row.Assignee, openList, closedCount));
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Dedicated PDF export for the assignee drill-down: Open/Closed summary
  // plus a title + days-open list of that assignee's open tasks only —
  // mirrors what's shown on screen.
  function printAssigneeDrillDownPdf(assigneeName, openList, closedCount) {
    const win = window.open('', '_blank');
    const rowsHtml = openList.map(t => `<tr><td>${escapeHtml(t.Title)}</td><td>${daysOpen(t.CreatedDate)}</td></tr>`).join('');
    win.document.write(`
      <html>
      <head>
        <title>${escapeHtml(assigneeName)} — Tasks</title>
        <style>
          body { font-family: -apple-system, Arial, sans-serif; padding: 24px; color: #1f2937; }
          h1 { color: #1d4e6b; font-size: 1.3rem; margin-bottom: 4px; }
          .muted { color: #6b7280; font-size: 0.85rem; margin-top: 0; }
          .summary { font-size: 0.95rem; margin: 14px 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th, td { border: 1px solid #dde1e6; padding: 6px 8px; text-align: left; font-size: 0.85rem; }
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
        <h1>MVOA — ${escapeHtml(assigneeName)}'s Tasks</h1>
        <p class="muted">Generated ${new Date().toLocaleString()}</p>
        <p class="summary"><strong>Open:</strong> ${openList.length} &nbsp;&nbsp; <strong>Closed:</strong> ${closedCount}</p>
        <table>
          <thead><tr><th>Open Task</th><th>Days Open</th></tr></thead>
          <tbody>${rowsHtml || `<tr><td colspan="2">No open tasks.</td></tr>`}</tbody>
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


  function renderReportOverdue(body) {
    const rows = tasksCache.filter(t => t.Status === 'Open')
      .map(t => ({
        Task: t.Title,
        Category: categoryName(t.CategoryID),
        Assignee: t.AssignedTo ? MVOA.assigneeLabel(t.AssignedTo, assigneeOptions) : 'Unassigned',
        Priority: t.Priority,
        'Days Open': daysOpen(t.CreatedDate),
        Created: formatDate(t.CreatedDate)
      }))
      .sort((a, b) => b['Days Open'] - a['Days Open']);

    const bodyWrap = document.createElement('div');
    bodyWrap.innerHTML = `<p class="muted">Flagging anything open ${OVERDUE_DAYS_THRESHOLD}+ days.</p>`;
    body.innerHTML = '';
    body.appendChild(bodyWrap);

    renderReportTable(body, {
      title: 'Overdue / Aging Report',
      columns: ['Task', 'Category', 'Assignee', 'Priority', 'Days Open', 'Created'],
      rows,
      filenameBase: 'ops-report-overdue',
      rowClass: r => r['Days Open'] >= OVERDUE_DAYS_THRESHOLD ? 'report-row-overdue' : '',
      append: true
    });
  }

  // Generic table renderer + CSV/PDF export, shared by all three reports.
  function renderReportTable(body, opts) {
    const { title, columns, rows, filenameBase, rowClass, append, onRowClick } = opts;
    const tableHtml = `
      <div class="card" style="max-width:100%;margin:0 0 14px 0;">
        <div class="mvoa-row">
          <h3 style="margin:0;color:var(--mvoa-blue);">${title}</h3>
          <div>
            <button class="btn-secondary ops-report-csv-btn">⬇ CSV</button>
            <button class="btn-secondary ops-report-pdf-btn">🖨 Print to PDF</button>
          </div>
        </div>
        ${onRowClick ? `<p class="muted" style="margin:8px 0 0;">Tap a row to see that person's tasks.</p>` : ''}
        <div style="overflow-x:auto;margin-top:10px;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:8px;">
          <table class="mvoa-table" id="ops-report-table">
            <thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>
              ${rows.length ? rows.map((r, i) => `<tr class="${rowClass ? rowClass(r) : ''}" ${onRowClick ? `data-row-index="${i}" style="cursor:pointer;"` : ''}>${columns.map(c => `<td>${escapeHtml(String(r[c] !== undefined && r[c] !== '' ? r[c] : (typeof r[c] === 'number' ? r[c] : '—')))}</td>`).join('')}</tr>`).join('')
                       : `<tr><td colspan="${columns.length}" class="muted">No data.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
    if (append) body.insertAdjacentHTML('beforeend', tableHtml);
    else body.innerHTML = tableHtml;

    const csvBtn = [...body.querySelectorAll('.ops-report-csv-btn')].pop();
    const pdfBtn = [...body.querySelectorAll('.ops-report-pdf-btn')].pop();
    csvBtn.addEventListener('click', () => exportReportCsv(title, columns, rows, filenameBase));
    pdfBtn.addEventListener('click', () => printReportPdf(title, columns, rows));
    if (onRowClick) {
      const table = [...body.querySelectorAll('#ops-report-table')].pop();
      table.querySelectorAll('tbody tr[data-row-index]').forEach(tr => {
        tr.addEventListener('click', () => onRowClick(rows[parseInt(tr.dataset.rowIndex, 10)]));
      });
    }
  }

  function exportReportCsv(title, columns, rows, filenameBase) {
    const esc = v => {
      const s = String(v !== undefined && v !== null ? v : '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [columns.map(esc).join(',')]
      .concat(rows.map(r => columns.map(c => esc(r[c])).join(',')));
    const csv = lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `${filenameBase}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function printReportPdf(title, columns, rows) {
    const win = window.open('', '_blank');
    const tableRows = rows.map(r => `<tr>${columns.map(c => `<td>${escapeHtml(String(r[c] !== undefined && r[c] !== '' ? r[c] : '—'))}</td>`).join('')}</tr>`).join('');
    win.document.write(`
      <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: -apple-system, Arial, sans-serif; padding: 24px; color: #1f2937; }
          h1 { color: #1d4e6b; font-size: 1.3rem; margin-bottom: 4px; }
          .muted { color: #6b7280; font-size: 0.85rem; margin-top: 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; }
          th, td { border: 1px solid #dde1e6; padding: 6px 8px; text-align: left; font-size: 0.85rem; }
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
        <h1>MVOA — ${escapeHtml(title)}</h1>
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
