// ═══════════════════════════════════════════════════════════════
// MODULE: Sheet Sizes (Diagnostics)
// Read-only, admin-only view that shows how many data rows each
// growing "log-style" sheet currently has, so growth can be watched
// over time before deciding where the bounded-read row limits in
// shared.js's SHEET_RECENT_ROW_LIMITS are actually worth turning on
// for a given view. Nothing here writes to any sheet, and checking
// counts is manual (a button) rather than automatic on every visit,
// so it doesn't add background API calls to normal app usage.
//
// Uses MVOA.sheetsRowCount(), which reads only column A of a sheet
// (not the whole tab) to get a row count cheaply.
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('diagnostics', {
  label: 'Sheet Sizes',
  icon: '📈',
  roles: ['ALL'], // gated to admins inside init() below, same as other "TESTING: opened to all roles" modules
  init: function (container) {
    DiagnosticsModule.mount(container);
  }
});

const DiagnosticsModule = (function () {
  // One entry per sheet worth watching — deliberately excludes static/
  // reference sheets (Roles, category lists, permission matrices, etc.)
  // that don't grow with day-to-day use. Add a line here for any new
  // log-style sheet that should show up in this view.
  const SHEETS = [
    { tab: 'AttLog', label: 'Attendance Logs', app: 'Staff Attendance' },
    { tab: 'OpsTasks', label: 'Ops Tasks', app: 'Daily Operations' },
    { tab: 'OpsTaskNotes', label: 'Ops Task Notes', app: 'Daily Operations' },
    { tab: 'HSChecklistLog', label: 'Checklist Log (rounds)', app: 'Plant Rounds & Compliance' },
    { tab: 'HSChecklistItemResults', label: 'Checklist Item Results', app: 'Plant Rounds & Compliance' },
    { tab: 'HSAMCLog', label: 'AMC Log', app: 'Plant Rounds & Compliance' },
    { tab: 'HSInOutLog', label: 'In/Out Log (Sewage/Garbage/Water/Garden)', app: 'Plant Rounds & Compliance' },
    { tab: 'FinanceRequests', label: 'Finance Requests', app: 'Finance' },
    { tab: 'FinanceApprovals', label: 'Finance Approvals', app: 'Finance' },
    { tab: 'FinanceRequestNotes', label: 'Finance Request Notes', app: 'Finance' },
    { tab: 'FinanceBudgetRevisions', label: 'Budget Revisions', app: 'Finance' },
    { tab: 'FinanceBudgetApprovals', label: 'Budget Approvals', app: 'Finance' },
  ];

  let lastResults = null;   // [{tab,label,app,count,error}]
  let lastCheckedAt = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function mount(container) {
    const user = MVOA.getUser();
    if (!MVOA.isAdmin(user)) {
      container.innerHTML = `
        <div class="card">
          <h3 style="margin-top:0;">Sheet Sizes</h3>
          <p class="muted">This view is only available to admins.</p>
        </div>
      `;
      return;
    }
    render(container);
  }

  function render(container) {
    container.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0;">📈 Sheet Sizes</h3>
        <p class="muted" style="font-size:0.85rem;">
          Row counts for every growing log sheet in the app (header row not counted).
          This is a manual check — it doesn't run automatically — so it's safe to click
          any time without adding background load.
        </p>
        <div class="mvoa-row" style="margin:10px 0;gap:10px;align-items:center;">
          <button id="diag-check-btn" class="btn-primary">🔄 Check Row Counts</button>
          ${lastCheckedAt ? `<span class="muted" style="font-size:0.8rem;">Last checked: ${escapeHtml(lastCheckedAt)}</span>` : ''}
        </div>
        <div id="diag-results">
          ${lastResults ? resultsHtml(lastResults) : '<p class="muted">Not checked yet — click "Check Row Counts" above.</p>'}
        </div>
      </div>
    `;
    container.querySelector('#diag-check-btn').addEventListener('click', () => runCheck(container));
  }

  function resultsHtml(results) {
    const maxCount = Math.max(1, ...results.map(r => r.count || 0));
    // Group by app, largest sheet first within each group, groups in the
    // order the largest single sheet appears — keeps the biggest concern
    // near the top without hiding the per-app structure.
    const byApp = new Map();
    results.forEach(r => {
      if (!byApp.has(r.app)) byApp.set(r.app, []);
      byApp.get(r.app).push(r);
    });
    const appOrder = [...byApp.keys()].sort((a, b) => {
      const maxA = Math.max(...byApp.get(a).map(r => r.count || 0));
      const maxB = Math.max(...byApp.get(b).map(r => r.count || 0));
      return maxB - maxA;
    });

    return appOrder.map(app => {
      const rows = byApp.get(app).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
      return `
        <div style="margin-top:16px;">
          <strong style="font-size:0.85rem;color:var(--mvoa-blue);">${escapeHtml(app)}</strong>
          <table class="mvoa-table" style="margin-top:6px;">
            <thead><tr><th>Sheet</th><th>Rows</th><th>Bounded-read limit</th><th style="width:40%;"></th></tr></thead>
            <tbody>
              ${rows.map(r => {
                if (r.error) {
                  return `<tr><td>${escapeHtml(r.label)}</td><td colspan="3" style="color:#b3261e;">Couldn't read (${escapeHtml(r.error)})</td></tr>`;
                }
                const limit = MVOA.SHEET_RECENT_ROW_LIMITS && MVOA.SHEET_RECENT_ROW_LIMITS[r.tab];
                const pct = Math.round(((r.count || 0) / maxCount) * 100);
                const overLimit = limit && r.count > limit;
                return `
                  <tr>
                    <td>${escapeHtml(r.label)}</td>
                    <td style="font-weight:700;">${r.count.toLocaleString()}</td>
                    <td class="muted">${limit ? limit.toLocaleString() + (overLimit ? ' ⚠️' : '') : '—'}</td>
                    <td>
                      <div style="background:var(--mvoa-blue-pale,#eef2f7);border-radius:4px;height:10px;overflow:hidden;">
                        <div style="background:${overLimit ? '#b3261e' : 'var(--mvoa-blue,#2a5b8c)'};width:${pct}%;height:100%;"></div>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }).join('');
  }

  async function runCheck(container) {
    const btn = container.querySelector('#diag-check-btn');
    const resultsEl = container.querySelector('#diag-results');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    resultsEl.innerHTML = '<p class="muted">Checking every sheet — this takes a few seconds…</p>';

    const results = await Promise.all(SHEETS.map(async s => {
      try {
        const count = await MVOA.sheetsRowCount(s.tab);
        return { ...s, count };
      } catch (e) {
        return { ...s, count: 0, error: e.message || String(e) };
      }
    }));

    lastResults = results;
    lastCheckedAt = new Date().toLocaleString();
    render(container);
  }

  return { mount };
})();