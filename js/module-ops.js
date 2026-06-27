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
  roles: ['FM', 'DEV'],
  init: function (container) {
    OpsModule.mount(container);
  }
});

const OpsModule = (function () {
  const TAB = MVOA.TABS.opsTasks;
  let tasksCache = [];
  let currentView = 'new';
  let pendingAsset = null;
  let pendingPhoto = null;

  const COLS = ['TaskID','Title','Description','Priority','AssetID','AssetName',
    'CreatedBy','CreatedDate','PhotoURL_Initial','Status','ComplianceComment',
    'PhotoURL_Compliance','ClosedDate','ClosedBy'];

  function rowToObj(row, rowNumber) {
    const o = { rowNumber };
    COLS.forEach((c, i) => o[c] = row[i] || '');
    return o;
  }
  function objToRow(o) { return COLS.map(c => o[c] !== undefined ? o[c] : ''); }

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
    container.innerHTML = `<p class="muted">Loading tasks…</p>`;
    try { await loadTasks(); } catch (e) {
      container.innerHTML = `<p class="error-text">Could not load tasks: ${e.message}</p>`;
      return;
    }
    render(container);
  }

  function render(container) {
    container.innerHTML = `
      <div class="ops-tabs">
        <button data-view="new" class="ops-tab-btn ${currentView==='new'?'active':''}">+ New Task</button>
        <button data-view="open" class="ops-tab-btn ${currentView==='open'?'active':''}">Open (${tasksCache.filter(t=>t.Status==='Open').length})</button>
        <button data-view="closed" class="ops-tab-btn ${currentView==='closed'?'active':''}">Closed</button>
        <button data-view="history" class="ops-tab-btn ${currentView==='history'?'active':''}">📅 History</button>
      </div>
      <div id="ops-view-body"></div>
    `;
    container.querySelectorAll('.ops-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => { currentView = btn.dataset.view; render(container); });
    });
    const body = container.querySelector('#ops-view-body');
    if (currentView === 'new') renderNewTaskForm(body, container);
    else if (currentView === 'history') renderHistory(body, container);
    else renderTaskList(body, container, currentView === 'open' ? 'Open' : 'Closed');
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

        <div id="ops-asset-chip"></div>
        <button id="ops-scan-btn" class="btn-secondary" style="width:100%;margin-top:10px;">📷 Scan Asset QR (optional)</button>

        <div id="ops-photo-chip"></div>
        <button id="ops-photo-btn" class="btn-secondary" style="width:100%;margin-top:10px;">🖼️ Attach Photo (optional)</button>

        <button id="ops-submit-btn" class="btn-primary">Submit Task</button>
        <button id="ops-submit-another-btn" class="btn-secondary" style="width:100%;">Save &amp; Add Another</button>
        <p class="error-text" id="ops-form-error"></p>
        <p class="muted" id="ops-form-saved-msg"></p>
      </div>
    `;
    renderAssetChip(body);
    renderPhotoChip(body);

    body.querySelector('#ops-scan-btn').addEventListener('click', () => openQrScanner(body));
    body.querySelector('#ops-photo-btn').addEventListener('click', async () => {
      const photo = await MVOA.capturePhoto({ useCamera: true });
      if (photo) { pendingPhoto = photo; renderPhotoChip(body); }
    });
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

  function renderPhotoChip(body) {
    const el = body.querySelector('#ops-photo-chip');
    if (!el) return;
    el.innerHTML = pendingPhoto
      ? `<div class="mvoa-row" style="margin-top:8px;"><span>🖼️ ${pendingPhoto.name}</span>
         <button class="btn-secondary" id="ops-clear-photo">Clear</button></div>`
      : '';
    const clearBtn = el.querySelector('#ops-clear-photo');
    if (clearBtn) clearBtn.addEventListener('click', () => { pendingPhoto = null; renderPhotoChip(body); });
  }

  async function submitNewTask(body, container, opts) {
    opts = opts || {};
    const title = body.querySelector('#ops-title').value.trim();
    const desc = body.querySelector('#ops-desc').value.trim();
    const priority = body.querySelector('#ops-priority').value;
    const errEl = body.querySelector('#ops-form-error');
    const savedEl = body.querySelector('#ops-form-saved-msg');
    errEl.textContent = ''; savedEl.textContent = '';
    if (!title) { errEl.textContent = 'Title is required.'; return; }

    const user = MVOA.getUser();
    const existingIds = tasksCache.map(t => t.TaskID);
    const taskId = MVOA.nextId('TASK', existingIds);
    const now = new Date().toISOString();

    errEl.textContent = pendingPhoto ? 'Uploading photo…' : '';
    let photoUrl = '';
    if (pendingPhoto) {
      try {
        photoUrl = await MVOA.uploadPhotoToDrive(pendingPhoto.file, `${taskId}_initial_${pendingPhoto.name}`);
      } catch (e) {
        errEl.textContent = 'Photo upload failed: ' + e.message + ' (task not saved — remove the photo or fix Drive setup and retry)';
        return;
      }
    }
    errEl.textContent = '';

    const row = {
      TaskID: taskId, Title: title, Description: desc, Priority: priority,
      AssetID: pendingAsset ? pendingAsset.assetId : '',
      AssetName: pendingAsset ? pendingAsset.assetName : '',
      CreatedBy: user.name, CreatedDate: now,
      PhotoURL_Initial: photoUrl,
      Status: 'Open', ComplianceComment: '', PhotoURL_Compliance: '', ClosedDate: '', ClosedBy: ''
    };

    try {
      await MVOA.sheetsAppend(TAB, objToRow(row));
      await MVOA.logAudit({ module: 'DailyOps', requestId: taskId, eventType: 'Created', comment: title, statusAfter: 'Open' });
    } catch (e) {
      errEl.textContent = 'Could not save task: ' + e.message;
      return;
    }

    pendingAsset = null; pendingPhoto = null;
    await loadTasks();

    if (opts.stayOnForm) {
      render(container); // rebuilds a blank New Task form, refreshes Open-count in tab label
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
            statusEl.textContent = 'Scanned, but not a recognised MVOA asset label. Keep trying or cancel.';
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
  }

  function renderTaskList(body, container, statusFilter) {
    const list = tasksCache.filter(t => t.Status === statusFilter)
      .sort((a, b) => (b.CreatedDate || '').localeCompare(a.CreatedDate || ''));
    if (!list.length) {
      body.innerHTML = `<p class="muted">No ${statusFilter.toLowerCase()} tasks.</p>`;
      return;
    }
    body.innerHTML = list.map(t => `
      <div class="mvoa-list-item" data-task-id="${t.TaskID}">
        <div class="mvoa-row">
          <strong>${t.Title}</strong>
          ${MVOA.statusBadgeHtml(t.Status === 'Open' ? 'Open' : 'Closed')}
        </div>
        ${t.Description ? `<p class="muted" style="margin:6px 0;">${t.Description}</p>` : ''}
        ${t.AssetName ? `<p class="muted" style="margin:4px 0;">📍 ${t.AssetName} (${t.AssetID})</p>` : ''}
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">By ${t.CreatedBy} · ${formatDate(t.CreatedDate)} · Priority: ${t.Priority}</p>
        ${t.PhotoURL_Initial ? `<p class="muted" style="font-size:0.8rem;">🖼️ <a href="${t.PhotoURL_Initial}" target="_blank" rel="noopener">Photo</a></p>` : ''}
        ${statusFilter === 'Open'
          ? `<button class="btn-primary ops-comply-btn" data-task-id="${t.TaskID}" style="margin-top:10px;">Mark Compliant / Close</button>`
          : `<p class="muted" style="font-size:0.8rem;margin-top:6px;">Closed by ${t.ClosedBy} · ${formatDate(t.ClosedDate)}${t.ComplianceComment ? ' — ' + t.ComplianceComment : ''}</p>`}
      </div>
    `).join('');
    body.querySelectorAll('.ops-comply-btn').forEach(btn => {
      btn.addEventListener('click', () => openComplyDialog(btn.dataset.taskId, container));
    });
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

    const list = tasksCache.filter(t => inRange(t.CreatedDate) || inRange(t.ClosedDate))
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
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">Created by ${t.CreatedBy} · ${formatDate(t.CreatedDate)} · Priority: ${t.Priority}</p>
        ${t.Status === 'Closed' ? `<p class="muted" style="font-size:0.8rem;">Closed by ${t.ClosedBy} · ${formatDate(t.ClosedDate)}${t.ComplianceComment ? ' — ' + t.ComplianceComment : ''}</p>` : ''}
      </div>
    `).join('');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function openComplyDialog(taskId, container) {
    const task = tasksCache.find(t => t.TaskID === taskId);
    if (!task) return;
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box" style="text-align:left;">
        <h3>Close: ${task.Title}</h3>
        <label>Compliance Comment
          <textarea id="ops-comply-comment" rows="3" placeholder="What was done?"></textarea>
        </label>
        <div id="ops-comply-photo-chip"></div>
        <button id="ops-comply-photo-btn" class="btn-secondary" style="width:100%;margin-top:8px;">🖼️ Attach Photo (optional)</button>
        <button id="ops-comply-submit" class="btn-primary">Confirm Close</button>
        <button id="ops-comply-cancel" class="btn-secondary">Cancel</button>
        <p class="error-text" id="ops-comply-error"></p>
      </div>
    `;
    document.body.appendChild(modal);
    let compliancePhoto = null;

    function renderChip() {
      const el = modal.querySelector('#ops-comply-photo-chip');
      el.innerHTML = compliancePhoto ? `<p class="muted">🖼️ ${compliancePhoto.name}</p>` : '';
    }
    modal.querySelector('#ops-comply-photo-btn').addEventListener('click', async () => {
      const p = await MVOA.capturePhoto({ useCamera: true });
      if (p) { compliancePhoto = p; renderChip(); }
    });
    modal.querySelector('#ops-comply-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#ops-comply-submit').addEventListener('click', async () => {
      const comment = modal.querySelector('#ops-comply-comment').value.trim();
      const errEl = modal.querySelector('#ops-comply-error');
      const user = MVOA.getUser();
      const now = new Date().toISOString();

      let photoUrl = '';
      if (compliancePhoto) {
        errEl.textContent = 'Uploading photo…';
        try {
          photoUrl = await MVOA.uploadPhotoToDrive(compliancePhoto.file, `${taskId}_compliance_${compliancePhoto.name}`);
        } catch (e) {
          errEl.textContent = 'Photo upload failed: ' + e.message;
          return;
        }
      }
      errEl.textContent = '';

      const updated = Object.assign({}, task, {
        Status: 'Closed',
        ComplianceComment: comment,
        PhotoURL_Compliance: photoUrl,
        ClosedDate: now,
        ClosedBy: user.name
      });
      try {
        await MVOA.sheetsUpdateRow(TAB, task.rowNumber, objToRow(updated));
        await MVOA.logAudit({ module: 'DailyOps', requestId: taskId, eventType: 'Completed', comment, statusAfter: 'Closed' });
      } catch (e) {
        errEl.textContent = 'Could not close task: ' + e.message;
        return;
      }
      modal.remove();
      currentView = 'closed';
      await loadTasks();
      render(container);
    });
  }

  return { mount };
})();
