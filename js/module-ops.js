// ═══════════════════════════════════════════════════════════════
// MODULE: Daily Operations
// Columns (OpsTasks): TaskID | Title | Description | Priority |
//   AssetID | AssetName | CreatedBy | CreatedDate | PhotoURL_Initial |
//   Status | ComplianceComment | PhotoURL_Compliance | ClosedDate | ClosedBy
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
            <option value="Medium"
