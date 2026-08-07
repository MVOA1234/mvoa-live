// ═══════════════════════════════════════════════════════════════
// MODULE: Approvals & Payments
// Sheet tabs used: FinanceApprovalRules | FinanceRequests |
//   FinanceApprovals | FinanceRequestNotes | Roles | ExpenseSheet_<MonYY>
//   (one tab per month, created on demand — see sheetsEnsureTab)
//
// FinanceApprovalRules columns: RuleID | ExpenseCategory | BudgetStatus |
//   MinAmount | MaxAmount | InitiatedByRole | TechnicalVerificationRole |
//   AdministrativeApprover | FinancialApprover | ECApprovalRequired |
//   AGMApprovalRequired | QuorumOverride | MinimumDocs | Notes
//
// FinanceRequests columns: RequestID | RuleID | Category | BudgetStatus |
//   Amount | Vendor | Description | RequestedBy | RequestedDate |
//   RequestType | AttachmentURL_1 | AttachmentURL_2 | AttachmentURL_3 |
//   RequiredDocsSnapshot | Status | QuorumRequired | ECApprovalCount |
//   ClosedDate | ClosedBy | PaymentStatus | PaymentDate | PaymentRef |
//   NotifiedAt | ReminderSentAt | DisbursementStage | ExpenseTab | ExpenseRow
//
// DisbursementStage (new — models the real Schedule D payment-release
// workflow: Accountant logs the Expense Sheet entry → Treasurer reviews,
// possibly kicking it back for correction over more than one round →
// Treasurer's approval of that entry IS the formal Treasurer approval →
// Disbursement Officer releases payment → Accountant's entry is updated
// with the Cheque/UTR reference):
//   '' → not yet logged as an expense (Status must be 'Approved' first)
//   'PendingTreasurer' → Accountant has logged the entry, awaiting Treasurer
//   'NeedsCorrection' → Treasurer sent it back with a query (see notes thread)
//   'PendingPayment' → Treasurer approved, awaiting Disbursement Officer
//   'Paid' → Disbursement Officer has released payment
// ExpenseTab / ExpenseRow point at the specific ExpenseSheet_<MonYY> row
// this request's entry lives in, so it can be re-read/updated in place.
//
// ExpenseSheet_<MonYY> columns (mirrors the Association's existing
// month-by-month Excel Payments sheet, unchanged so nothing about how the
// Accountant already works has to change):
//   RequestID | SlNo | Vendor | InvoiceDate | InvoiceNumber |
//   InvoicePeriodPurpose | Period | GrossAmount | GST | TDSRate | TDS |
//   LessAdd | NetAmount | NelsonCheck | LakshmanCheck | ApprovedBy |
//   PassedBy | UDNumber | Date
// ("PassedBy" being filled in is what constitutes the Treasurer's formal
// approval — same as the real paper process. UDNumber/Date are filled by
// the Disbursement Officer at the moment of payment.)
//
// FinanceApprovals columns: ApprovalID | RequestID | ApproverName |
//   ApproverRole | Stage | Decision | Comment | Timestamp
//
// FinanceRequestNotes columns: NoteID | RequestID | Author | Timestamp | Note
// (reused for the Accountant↔Treasurer clarify/correction loop too, not
// just pre-approval questions — same thread, same tab.)
//
// STATUS values on FinanceRequests: PendingApproval | Approved | Rejected
// PaymentStatus values: Unpaid | Paid (kept for simple display on "My
// Requests"; DisbursementStage above is what actually drives the workflow)
//
// Approval routing is data-driven from FinanceApprovalRules (the DoFA
// matrix), not hardcoded — see resolveRule() and the approver-matching
// helpers below. Petty Cash is modelled as a single "reimbursement claim"
// request (no separate no-approval "spend" record — see FIN-A-001
// Payment Authority table vs. Financial Approval Matrix discussion).
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('finance', {
  label: 'Approvals & Payments',
  icon: '💳',
  roles: ['ALL'], // TESTING: opened to all roles temporarily — revert to real roles once finalized
  init: function (container) {
    FinanceModule.mount(container);
  }
});

const FinanceModule = (function () {
  const TAB_RULES = 'FinanceApprovalRules';
  const TAB_REQUESTS = 'FinanceRequests';
  const TAB_APPROVALS = 'FinanceApprovals';
  const TAB_NOTES = 'FinanceRequestNotes';
  const TAB_ROLES = 'Roles';
  const TAB_BUDGETS = 'FinanceBudgets';
  const EXPENSE_TAB_PREFIX = 'ExpenseSheet_';
  const DEFAULT_QUORUM = 7;
  const LS_QUEUE_SEEN = 'mvoa_fin_queue_last_seen';
  const LS_PAYMENTS_SEEN = 'mvoa_fin_payments_last_seen';

  const RULE_COLS = ['RuleID','ExpenseCategory','BudgetStatus','MinAmount','MaxAmount',
    'InitiatedByRole','TechnicalVerificationRole','AdministrativeApprover','FinancialApprover',
    'ECApprovalRequired','AGMApprovalRequired','QuorumOverride','MinimumDocs','Notes'];

  const REQUEST_COLS = ['RequestID','RuleID','Category','BudgetStatus','Amount','Vendor',
    'Description','RequestedBy','RequestedDate','RequestType','AttachmentURL_1','AttachmentURL_2',
    'AttachmentURL_3','RequiredDocsSnapshot','Status','QuorumRequired','ECApprovalCount',
    'ClosedDate','ClosedBy','PaymentStatus','PaymentDate','PaymentRef','NotifiedAt','ReminderSentAt',
    // Purchase Requisition fields — only populated when the requester used
    // "Fill Purchase Requisition in-app" instead of uploading FIN-F-004:
    'PR_AssetFacility','PR_Location','PR_ReasonJustification','PR_CurrentCondition',
    'PR_RiskIfDeferred','PR_ProcurementMethod','PR_ExpectedCompletionDays',
    // Schedule D payment-release workflow — see header comment.
    'DisbursementStage','ExpenseTab','ExpenseRow',
    // Tracks when the request last moved to a new stage in either chain
    // (spend-approval or payment-release) — drives the "🆕 New" indicator
    // in the Approval Queue / Payments tabs (see LS_QUEUE_SEEN/LS_PAYMENTS_SEEN)
    // and the human-readable stage text shown to the requester.
    'StageEnteredAt'];

  const APPROVAL_COLS = ['ApprovalID','RequestID','ApproverName','ApproverRole','Stage','Decision','Comment','Timestamp'];

  const NOTE_COLS = ['NoteID','RequestID','Author','Timestamp','Note'];

  const ROLE_COLS = ['Name','Role','PIN_Hash','Phone','Email','Active','EC_Member','Title','AdminAccess'];

  // Mirrors the Association's existing month-by-month Excel Payments
  // sheet column-for-column — see header comment for the workflow this
  // drives.
  const EXPENSE_COLS = ['RequestID','SlNo','Vendor','InvoiceDate','InvoiceNumber',
    'InvoicePeriodPurpose','Period','GrossAmount','GST','TDSRate','TDS','LessAdd','NetAmount',
    'NelsonCheck','LakshmanCheck','ApprovedBy','PassedBy','UDNumber','Date'];

  // FinanceBudgets — one row per Category × Financial Year, the source of
  // truth for "Total Budget" (this isn't derivable from anything else —
  // it's a real input the EC/Treasurer sets). "Consumed" and "Available"
  // are always computed live from FinanceRequests, never stored, so they
  // can't go stale — see budgetInfoFor().
  const BUDGET_COLS = ['BudgetID','Category','FYYear','TotalBudget','Notes'];

  let rulesCache = [];
  let requestsCache = [];
  let rolesCache = [];
  let budgetsCache = [];
  let currentView = 'mine'; // 'submit' | 'mine' | 'queue' | 'payments' | 'budget'
  let pendingAttachments = []; // up to 3: { name, file, isPhoto, compressedSizeBytes }
  let fillPrInApp = false; // Submit form: Purchase Requisition fill-in-app toggle

  // Financial Year runs Apr–Mar (Indian society/RWA convention) — flag to
  // the user if this assumption doesn't match how MVOA actually budgets.
  function currentFY() {
    return fyFor(new Date());
  }
  function fyFor(date) {
    const y = date.getFullYear();
    const startYear = date.getMonth() >= 3 ? y : y - 1; // month index 3 = April
    return `${startYear}-${String(startYear + 1).slice(-2)}`;
  }
  function fyDateRange(fy) {
    const startYear = Number(fy.split('-')[0]);
    return { start: new Date(startYear, 3, 1), end: new Date(startYear + 1, 2, 31, 23, 59, 59) };
  }
  function budgetInfoFor(category, fy) {
    const b = budgetsCache.find(x => x.Category === category && x.FYYear === fy);
    if (!b) return null;
    const total = Number(b.TotalBudget) || 0;
    const { start, end } = fyDateRange(fy);
    // "Consumed" = Approved requests against this category that are
    // Budgeted (Unbudgeted spend, by definition, doesn't draw against a
    // budget line) and fall within this FY, regardless of payment stage —
    // approval is the moment the commitment is made against the budget.
    const consumed = requestsCache
      .filter(r => r.Category === category && r.BudgetStatus === 'Budgeted' && r.Status === 'Approved')
      .filter(r => { const d = new Date(r.RequestedDate); return d >= start && d <= end; })
      .reduce((sum, r) => sum + (Number(r.Amount) || 0), 0);
    return { total, consumed, available: total - consumed, fy };
  }

  // ───────────────────────────────────────────────────────────
  // Row <-> object helpers (same pattern as module-ops.js)
  // ───────────────────────────────────────────────────────────
  function rowToObj(cols, row, rowNumber) {
    const o = { rowNumber };
    cols.forEach((c, i) => o[c] = row[i] !== undefined ? row[i] : '');
    return o;
  }
  function objToRow(cols, o) { return cols.map(c => o[c] !== undefined ? o[c] : ''); }

  async function loadAll(force) {
    const [ruleRows, reqRows, roleRows] = await Promise.all([
      MVOA.sheetsRead(TAB_RULES),
      MVOA.sheetsRead(TAB_REQUESTS),
      MVOA.sheetsRead(TAB_ROLES)
    ]);
    rulesCache = ruleRows.slice(1).map((r, i) => rowToObj(RULE_COLS, r, i + 2)).filter(r => r.RuleID);
    requestsCache = reqRows.slice(1).map((r, i) => rowToObj(REQUEST_COLS, r, i + 2)).filter(r => r.RequestID);
    rolesCache = roleRows.slice(1).map((r, i) => rowToObj(ROLE_COLS, r, i + 2)).filter(r => r.Name);
    // Optional tab — Budget Available/Consumed only shows once this exists;
    // fails open so a fresh install without it yet doesn't break anything else.
    try {
      const budgetRows = await MVOA.sheetsRead(TAB_BUDGETS);
      budgetsCache = budgetRows.slice(1).map((r, i) => rowToObj(BUDGET_COLS, r, i + 2)).filter(b => b.BudgetID);
    } catch (e) {
      budgetsCache = [];
    }
    updateBadge();
  }

  function updateBadge() {
    const user = MVOA.getUser();
    const count = requestsCache.filter(r => r.Status === 'PendingApproval' && isEligibleForRequest(user, r)).length;
    MVOA.setAppBadge(count);
  }

  async function mount(container) {
    container.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      await loadAll();
    } catch (e) {
      container.innerHTML = `<p class="error-text">Could not load Approvals &amp; Payments: ${escapeHtml(e.message)}</p>`;
      return;
    }
    render(container);
  }

  function render(container) {
    container.innerHTML = `
      <div class="ops-tabs">
        <button data-view="submit" class="ops-tab-btn ${currentView==='submit'?'active':''}">+ New Request</button>
        <button data-view="mine" class="ops-tab-btn ${currentView==='mine'?'active':''}">My Requests</button>
        <button data-view="queue" class="ops-tab-btn ${currentView==='queue'?'active':''}">Approval Queue</button>
        <button data-view="payments" class="ops-tab-btn ${currentView==='payments'?'active':''}">₹ Payments</button>
        <button data-view="budget" class="ops-tab-btn ${currentView==='budget'?'active':''}">📊 Budget</button>
        ${currentView === 'budget' ? `<button id="fin-budget-back-btn" class="ops-tab-btn">← Back to Approvals &amp; Payments</button>` : ''}
        <button id="fin-refresh-btn" class="ops-tab-btn" title="Reload from sheet" style="margin-left:auto;">↻ Refresh</button>
      </div>
      <div id="fin-view-body"></div>
    `;
    container.querySelectorAll('.ops-tab-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => { currentView = btn.dataset.view; render(container); });
    });
    if (currentView === 'budget') {
      container.querySelector('#fin-budget-back-btn').addEventListener('click', () => { currentView = 'mine'; render(container); });
    }
    container.querySelector('#fin-refresh-btn').addEventListener('click', async () => {
      const btn = container.querySelector('#fin-refresh-btn');
      const original = btn.textContent;
      btn.disabled = true; btn.textContent = '↻ Refreshing…';
      try {
        await loadAll(true);
        render(container);
      } catch (e) {
        btn.disabled = false; btn.textContent = original;
        alert('Refresh failed: ' + e.message);
      }
    });
    const body = container.querySelector('#fin-view-body');
    if (currentView === 'submit') renderSubmitForm(body, container);
    else if (currentView === 'queue') renderQueue(body, container);
    else if (currentView === 'payments') renderPayments(body, container);
    else if (currentView === 'budget') renderBudgetStatus(body, container);
    else renderMine(body, container);
  }

  // ─── Budget Status — Category × FY: Total / Consumed / Available ─
  function renderBudgetStatus(body, container) {
    const fys = [...new Set(budgetsCache.map(b => b.FYYear))].sort().reverse();
    const selectedFy = fys.includes(currentFY()) ? currentFY() : (fys[0] || currentFY());
    body.innerHTML = `
      <div style="margin-bottom:12px;">
        <label>Financial Year
          <select id="fin-budget-fy">
            ${(fys.length ? fys : [currentFY()]).map(fy => `<option value="${fy}" ${fy === selectedFy ? 'selected' : ''}>${fy}</option>`).join('')}
          </select>
        </label>
      </div>
      <div id="fin-budget-table"></div>
      ${!budgetsCache.length ? `<p class="muted" style="margin-top:12px;">No budget lines set up yet — add rows to the <strong>FinanceBudgets</strong> sheet (Category, FYYear, TotalBudget) to see them here.</p>` : ''}
    `;
    function draw() {
      const fy = body.querySelector('#fin-budget-fy').value;
      const rows = budgetsCache.filter(b => b.FYYear === fy);
      const tableEl = body.querySelector('#fin-budget-table');
      if (!rows.length) { tableEl.innerHTML = `<p class="muted">No budget lines for ${escapeHtml(fy)}.</p>`; return; }
      tableEl.innerHTML = `
        <table class="mvoa-table">
          <thead><tr><th>Category</th><th>Total Budget</th><th>Consumed</th><th>Available</th></tr></thead>
          <tbody>
            ${rows.map(b => {
              const info = budgetInfoFor(b.Category, fy);
              const overBudget = info.available < 0;
              return `<tr>
                <td>${escapeHtml(b.Category)}</td>
                <td>${formatAmount(info.total)}</td>
                <td>${formatAmount(info.consumed)}</td>
                <td style="color:${overBudget ? '#b3261e' : 'green'};font-weight:700;">${formatAmount(info.available)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    }
    body.querySelector('#fin-budget-fy').addEventListener('change', draw);
    draw();
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function formatKB(bytes) {
    return bytes > 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.round((bytes||0) / 1024) + ' KB';
  }
  function formatAmount(n) {
    const num = Number(n) || 0;
    return '₹' + num.toLocaleString('en-IN');
  }

  // ───────────────────────────────────────────────────────────
  // Rule resolution — turns (category, budgetStatus, amount) into
  // the applicable FinanceApprovalRules row, data-driven from the
  // DoFA matrix rather than hardcoded thresholds.
  // ───────────────────────────────────────────────────────────
  function selectableCategories() {
    return [...new Set(rulesCache.filter(r => r.RuleID !== 'R03').map(r => r.ExpenseCategory))];
  }

  function budgetStatusOptionsFor(category) {
    const opts = [...new Set(rulesCache.filter(r => r.ExpenseCategory === category && r.RuleID !== 'R03').map(r => r.BudgetStatus))];
    const real = opts.filter(o => o === 'Budgeted' || o === 'Unbudgeted');
    return real.length > 1 ? real : null; // null = no selector needed, rule doesn't branch on budget status
  }

  function resolveRule(category, budgetStatus, amount) {
    const amt = Number(amount) || 0;
    const candidates = rulesCache.filter(r =>
      r.ExpenseCategory === category && r.RuleID !== 'R03' &&
      (!budgetStatus || !r.BudgetStatus || r.BudgetStatus === budgetStatus || r.BudgetStatus.indexOf('/') !== -1)
    );
    const match = candidates.find(r => {
      const min = Number(r.MinAmount) || 0;
      const max = (r.MaxAmount === '' || r.MaxAmount === null || r.MaxAmount === undefined) ? Infinity : Number(r.MaxAmount);
      return amt >= min && amt <= max;
    });
    if (match) return { blocked: false, rule: match };

    // Petty Cash over the reimbursement ceiling is explicitly blocked (R03)
    if (category === 'Petty Cash Reimbursement') {
      const blockRule = rulesCache.find(r => r.RuleID === 'R03');
      if (blockRule && amt >= (Number(blockRule.MinAmount) || 0)) {
        return { blocked: true, message: blockRule.Notes };
      }
    }
    return { blocked: false, rule: null };
  }

  function requiredDocsList(rule) {
    if (!rule || !rule.MinimumDocs) return [];
    return rule.MinimumDocs.split('+').map(s => s.trim()).filter(Boolean);
  }

  // ───────────────────────────────────────────────────────────
  // Approver matching — parses strings like "Secretary & President"
  // (AND — both required) or "Secretary / Operations Head" (OR — either
  // one suffices) from the matrix, and checks a Roles-sheet user against
  // them by Title (President/Secretary/Treasurer) or Role (TRES/FM/EC).
  // ───────────────────────────────────────────────────────────
  function parseApproverGroups(spec) {
    if (!spec || spec === '—' || spec === '-') return [];
    const andParts = spec.split(/\s*&\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
    return andParts.map(part => part.split('/').map(s => s.trim()).filter(Boolean));
  }

  function roleMatchesToken(person, token) {
    const t = token.toLowerCase();
    const role = (person.Role || '').toLowerCase();
    const title = (person.Title || '').toLowerCase();
    if (t === 'treasurer') return role === 'tres' || title.indexOf('treasurer') !== -1;
    if (t === 'secretary') return title.indexOf('secretary') !== -1;
    if (t === 'president') return title.indexOf('president') !== -1;
    if (t === 'operations head') return title.indexOf('operations head') !== -1 || role.indexOf('ops') !== -1;
    if (t === 'fm') return role === 'fm';
    return title.indexOf(t) !== -1 || role === t;
  }

  function personMatchesAndGroup(person, orGroup) {
    return orGroup.some(tok => roleMatchesToken(person, tok));
  }

  function isEcMember(person) {
    const v = String(person.EC_Member || '').toLowerCase();
    return v === 'true' || v === 'yes' || v === '1';
  }
  function isAdmin(person) {
    return String(person.AdminAccess || '').toLowerCase() === 'true' || (person.Role || '').toUpperCase() === 'DEV';
  }

  // ───────────────────────────────────────────────────────────
  // Stage engine — given a request + its approvals log, works out
  // what stage is next, who may act on it, and whether the whole
  // request is now fully approved or rejected.
  // ───────────────────────────────────────────────────────────
  async function loadApprovalsFor(requestId) {
    const rows = await MVOA.sheetsRead(TAB_APPROVALS);
    return rows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2))
      .filter(a => a.RequestID === requestId);
  }

  function andGroupSatisfied(approvals, orGroup, stage) {
    return approvals.some(a => {
      if (a.Stage !== stage || a.Decision !== 'Approved') return false;
      const person = rolesCache.find(p => p.Name === a.ApproverName) || { Role: a.ApproverRole, Title: a.ApproverRole };
      return personMatchesAndGroup(person, orGroup);
    });
  }

  // Computes the current status of a request from its rule + approvals log.
  // Returns { stage, eligibleCheck, ecCount, rejected, fullyApproved }
  function computeRequestState(request, approvals) {
    if (approvals.some(a => a.Decision === 'Rejected')) {
      return { stage: null, rejected: true, fullyApproved: false, ecCount: 0 };
    }
    const rule = rulesCache.find(r => r.RuleID === request.RuleID) || {};
    const adminGroups = parseApproverGroups(rule.AdministrativeApprover);
    const adminDone = adminGroups.every(g => andGroupSatisfied(approvals, g, 'Administrative'));
    if (!adminDone) return { stage: 'Administrative', groups: adminGroups, rejected: false, fullyApproved: false, ecCount: 0 };

    const finGroups = parseApproverGroups(rule.FinancialApprover);
    const finDone = finGroups.length === 0 || finGroups.every(g => andGroupSatisfied(approvals, g, 'Financial'));
    if (!finDone) return { stage: 'Financial', groups: finGroups, rejected: false, fullyApproved: false, ecCount: 0 };

    const ecRequired = rule.ECApprovalRequired === 'Yes' || rule.ECApprovalRequired === 'Ratification';
    const ecApprovers = new Set(approvals.filter(a => a.Stage === 'EC' && a.Decision === 'Approved').map(a => a.ApproverName));
    const quorum = Number(request.QuorumRequired) || Number(rule.QuorumOverride) || DEFAULT_QUORUM;
    if (ecRequired && ecApprovers.size < quorum) {
      return { stage: 'EC', rejected: false, fullyApproved: false, ecCount: ecApprovers.size, quorum };
    }

    const agmRequired = rule.AGMApprovalRequired === 'Yes';
    const agmDone = !agmRequired || approvals.some(a => a.Stage === 'AGM' && a.Decision === 'Approved');
    if (!agmDone) return { stage: 'AGM', rejected: false, fullyApproved: false, ecCount: ecApprovers.size };

    return { stage: null, rejected: false, fullyApproved: true, ecCount: ecApprovers.size };
  }

  function isEligibleForRequest(user, request) {
    // Cheap check used only for the Home-tile badge count — full per-stage
    // eligibility is recomputed properly inside renderQueue().
    return true;
  }

  // ───────────────────────────────────────────────────────────
  // Human-readable "where is this right now" — covers BOTH chains
  // (spend-approval via computeRequestState, and payment-release via
  // DisbursementStage) so the requester always has one clear answer,
  // whichever half of the pipeline the request is currently in.
  // ───────────────────────────────────────────────────────────
  function stageDescription(request, approvals) {
    if (request.Status === 'Rejected') return { text: 'Rejected', cls: 'rejected' };
    if (request.Status === 'PendingApproval') {
      const rule = rulesCache.find(r => r.RuleID === request.RuleID) || {};
      const state = computeRequestState(request, approvals);
      if (state.stage === 'Administrative') return { text: `Awaiting ${rule.AdministrativeApprover || 'Administrative'} approval`, cls: 'pending' };
      if (state.stage === 'Financial') return { text: `Awaiting ${rule.FinancialApprover || 'Financial'} approval`, cls: 'pending' };
      if (state.stage === 'EC') return { text: `Awaiting EC approval (${state.ecCount} of ${state.quorum})`, cls: 'pending' };
      if (state.stage === 'AGM') return { text: 'Awaiting AGM approval', cls: 'pending' };
      return { text: 'Pending approval', cls: 'pending' };
    }
    // Status === 'Approved' — now in the Schedule D payment-release chain
    switch (request.DisbursementStage) {
      case 'PendingTreasurer': return { text: 'Awaiting Treasurer review (payment release)', cls: 'approved' };
      case 'NeedsCorrection': return { text: "Sent back by Treasurer for correction — waiting on Accountant", cls: 'rejected' };
      case 'PendingPayment': return { text: 'Treasurer approved — awaiting Disbursement Officer', cls: 'approved' };
      case 'Paid': return { text: 'Paid' + (request.PaymentRef ? ` (Ref: ${request.PaymentRef})` : ''), cls: 'paid' };
      default: return { text: 'Approved — awaiting Expense Sheet entry (Accountant)', cls: 'approved' };
    }
  }
  function stageBadgeHtml(request, approvals) {
    const s = stageDescription(request, approvals);
    return statusBadge(s.text, s.cls);
  }

  // "🆕 New" indicator — compares each request's StageEnteredAt against
  // when THIS browser last opened the given tab (stored in localStorage).
  // This is an in-app "something arrived since you last looked" signal —
  // NOT a push/email/SMS notification, since that infrastructure isn't
  // built. It resets every time the tab is opened, same browser only.
  function getLastSeen(key) {
    return localStorage.getItem(key) || '1970-01-01T00:00:00.000Z';
  }
  function markSeenNow(key) {
    localStorage.setItem(key, new Date().toISOString());
  }
  function isNewSince(request, lastSeen) {
    return !!request.StageEnteredAt && request.StageEnteredAt > lastSeen;
  }

  // ───────────────────────────────────────────────────────────
  // SUBMIT — new request form
  // ───────────────────────────────────────────────────────────
  function renderSubmitForm(body, container) {
    const categories = selectableCategories();
    body.innerHTML = `
      <div class="card" style="max-width:560px;margin:0;">
        <label>Category
          <select id="fin-category">
            <option value="">— Select —</option>
            ${categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
          </select>
        </label>
        <div id="fin-budget-status-wrap"></div>
        <label>Amount (₹)
          <input id="fin-amount" type="number" min="0" step="1" placeholder="0">
        </label>
        <label>Vendor / Payee
          <input id="fin-vendor" type="text" placeholder="e.g. ABC Electricals">
        </label>
        <label>Description
          <textarea id="fin-desc" rows="2" placeholder="What is this expense for?"></textarea>
        </label>
        <div id="fin-rule-preview"></div>
        <div id="fin-pr-toggle-wrap"></div>
        <div id="fin-pr-fields-wrap"></div>
        <div style="margin-top:12px;">
          <p class="muted" id="fin-attachments-label" style="margin:0 0 6px;">Attachments</p>
          <div id="fin-attachment-chips"></div>
          <div id="fin-attachment-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;"></div>
        </div>
        <button id="fin-submit-btn" class="btn-primary">Submit Request</button>
        <p class="error-text" id="fin-form-error"></p>
        <p class="muted" id="fin-form-saved-msg"></p>
      </div>
    `;
    pendingAttachments = [];
    renderAttachmentChips(body, '#fin-attachment-chips', '#fin-attachment-btns', pendingAttachments, 3);

    const catEl = body.querySelector('#fin-category');
    const amtEl = body.querySelector('#fin-amount');
    const bsWrap = body.querySelector('#fin-budget-status-wrap');

    function refreshBudgetStatusSelector() {
      const opts = budgetStatusOptionsFor(catEl.value);
      if (!opts) { bsWrap.innerHTML = ''; return; }
      bsWrap.innerHTML = `
        <label>Budget Status
          <select id="fin-budget-status">
            ${opts.map(o => `<option value="${o}">${o}</option>`).join('')}
          </select>
        </label>`;
      bsWrap.querySelector('#fin-budget-status').addEventListener('change', refreshRulePreview);
    }

    function currentBudgetStatus() {
      const sel = body.querySelector('#fin-budget-status');
      return sel ? sel.value : '';
    }

    function refreshRulePreview() {
      const previewEl = body.querySelector('#fin-rule-preview');
      const category = catEl.value;
      const amount = Number(amtEl.value) || 0;
      if (!category) { previewEl.innerHTML = ''; return; }
      const result = resolveRule(category, currentBudgetStatus(), amount);
      if (result.blocked) {
        previewEl.innerHTML = `<p class="error-text" style="margin-top:10px;">${escapeHtml(result.message)}</p>`;
        return;
      }
      if (!result.rule) {
        previewEl.innerHTML = `<p class="muted" style="margin-top:10px;">Enter an amount to see the required approvals for this category.</p>`;
        return;
      }
      const rule = result.rule;
      const docs = requiredDocsList(rule);
      const budgetStatus = currentBudgetStatus();
      const fy = currentFY();
      const info = budgetStatus === 'Budgeted' ? budgetInfoFor(category, fy) : null;
      previewEl.innerHTML = `
        ${budgetStatus === 'Budgeted' ? (info ? `
          <div class="mvoa-list-item" style="margin-top:10px;background:${info.available - amount < 0 ? '#fbeaea' : 'var(--card-bg)'};">
            <p style="margin:0;font-weight:600;">Budget Available (FY ${escapeHtml(fy)}): <span style="color:${info.available - amount < 0 ? '#b3261e' : 'green'};">${formatAmount(info.available)}</span> of ${formatAmount(info.total)}</p>
            ${amount > 0 && info.available - amount < 0 ? `<p class="error-text" style="margin:4px 0 0;">⚠️ This request (${formatAmount(amount)}) would exceed the remaining budget for this category.</p>` : ''}
          </div>` : `
          <div class="mvoa-list-item" style="margin-top:10px;">
            <p class="muted" style="margin:0;">No budget line set up yet for "${escapeHtml(category)}" in FY ${escapeHtml(fy)}.</p>
          </div>`) : ''}
        <div class="mvoa-list-item" style="margin-top:10px;">
          <p style="margin:0 0 6px;font-weight:600;">This request will need:</p>
          <p class="muted" style="margin:2px 0;">Administrative approval: ${escapeHtml(rule.AdministrativeApprover || '—')}</p>
          <p class="muted" style="margin:2px 0;">Financial approval: ${escapeHtml(rule.FinancialApprover || '—')}</p>
          ${rule.ECApprovalRequired === 'Yes' || rule.ECApprovalRequired === 'Ratification'
            ? `<p class="muted" style="margin:2px 0;">EC ${rule.ECApprovalRequired === 'Ratification' ? 'ratification' : 'approval'} — quorum ${rule.QuorumOverride || DEFAULT_QUORUM}</p>` : ''}
          ${rule.AGMApprovalRequired === 'Yes' ? `<p class="muted" style="margin:2px 0;">AGM approval required</p>` : ''}
          ${docs.length ? `<p class="muted" style="margin:6px 0 0;">Minimum documents: ${docs.map(escapeHtml).join(', ')} — please attach at least ${Math.min(docs.length, 3)} file(s) below, or fill the Purchase Requisition in-app if offered.</p>` : ''}
        </div>`;
      body.querySelector('#fin-attachments-label').textContent =
        docs.length ? `Attachments — at least ${Math.min(docs.length, 3)} required` : 'Attachments (optional — up to 3)';

      // Purchase Requisition (FIN-F-004) — offered as a fillable in-app
      // form wherever the DoFA Matrix calls for a "Purchase Request" as
      // part of the minimum documentation, instead of requiring an upload.
      const prToggleWrap = body.querySelector('#fin-pr-toggle-wrap');
      const needsPR = docs.some(d => /purchase request/i.test(d));
      if (needsPR) {
        prToggleWrap.innerHTML = `
          <label style="display:flex;align-items:center;gap:8px;margin-top:10px;">
            <input type="checkbox" id="fin-pr-fill-toggle" ${fillPrInApp ? 'checked' : ''}>
            📝 Fill the Purchase Requisition in-app instead of uploading FIN-F-004
          </label>`;
        prToggleWrap.querySelector('#fin-pr-fill-toggle').addEventListener('change', (e) => {
          fillPrInApp = e.target.checked;
          renderPrFields();
        });
      } else {
        prToggleWrap.innerHTML = '';
        fillPrInApp = false;
      }
      renderPrFields();
    }

    function renderPrFields() {
      const wrap = body.querySelector('#fin-pr-fields-wrap');
      if (!fillPrInApp) { wrap.innerHTML = ''; return; }
      wrap.innerHTML = `
        <div class="mvoa-list-item" style="margin-top:10px;">
          <p style="margin:0 0 8px;font-weight:600;">Purchase Requisition details</p>
          <label>Asset / Facility <input id="fin-pr-asset" type="text"></label>
          <label>Location <input id="fin-pr-location" type="text"></label>
          <label>Reason / Justification <input id="fin-pr-reason" type="text" placeholder="e.g. Breakdown, Preventive Maintenance, Safety, Statutory Compliance…"></label>
          <label>Current Condition <textarea id="fin-pr-condition" rows="2"></textarea></label>
          <label>Risk if Work is Deferred <input id="fin-pr-risk" type="text" placeholder="e.g. Safety Risk, Service Interruption…"></label>
          <label>Procurement Method
            <select id="fin-pr-method">
              <option value="One Quotation">One Quotation</option>
              <option value="Two Quotations">Two Quotations</option>
              <option value="Three Quotations">Three Quotations</option>
              <option value="Rate Contract">Rate Contract</option>
              <option value="Proprietary Item">Proprietary Item</option>
              <option value="Emergency Procurement">Emergency Procurement</option>
            </select>
          </label>
          <label>Expected Completion (days) <input id="fin-pr-days" type="number" min="0"></label>
        </div>`;
    }

    catEl.addEventListener('change', () => { refreshBudgetStatusSelector(); refreshRulePreview(); });
    amtEl.addEventListener('input', refreshRulePreview);
    refreshBudgetStatusSelector();
    fillPrInApp = false;

    body.querySelector('#fin-submit-btn').addEventListener('click', () => submitRequest(body, container));
  }

  function renderAttachmentChips(scope, chipsSelector, btnsSelector, attachments, maxCount) {
    const chipsEl = scope.querySelector(chipsSelector);
    const btnsEl = scope.querySelector(btnsSelector);
    if (!chipsEl || !btnsEl) return;
    chipsEl.innerHTML = attachments.map((a, i) => `
      <div class="mvoa-row" style="margin-bottom:4px;">
        <span>${a.isPhoto ? '📷' : '📄'} ${escapeHtml(a.name)} <span class="muted">(${formatKB(a.compressedSizeBytes)})</span></span>
        <button class="btn-secondary fin-att-remove" data-idx="${i}" style="padding:4px 10px;margin:0;">✕</button>
      </div>
    `).join('');
    chipsEl.querySelectorAll('.fin-att-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        attachments.splice(parseInt(btn.dataset.idx), 1);
        renderAttachmentChips(scope, chipsSelector, btnsSelector, attachments, maxCount);
      });
    });
    if (attachments.length < maxCount) {
      btnsEl.innerHTML = `
        <button class="btn-secondary fin-att-photo-pick">📷 Add Photo</button>
        <button class="btn-secondary fin-att-doc-pick">📄 Add Document</button>
      `;
      btnsEl.querySelector('.fin-att-photo-pick').addEventListener('click', async () => {
        const a = await MVOA.pickAttachment({ photoOnly: true, useCamera: true });
        if (a) { attachments.push(a); renderAttachmentChips(scope, chipsSelector, btnsSelector, attachments, maxCount); }
      });
      btnsEl.querySelector('.fin-att-doc-pick').addEventListener('click', async () => {
        const a = await MVOA.pickAttachment({ photoOnly: false, useCamera: false });
        if (a) { attachments.push(a); renderAttachmentChips(scope, chipsSelector, btnsSelector, attachments, maxCount); }
      });
    } else {
      btnsEl.innerHTML = `<p class="muted" style="margin:0;">Maximum ${maxCount} attachments reached.</p>`;
    }
  }

  let isSubmitting = false;
  async function submitRequest(body, container) {
    if (isSubmitting) return;
    isSubmitting = true;
    try { await doSubmitRequest(body, container); }
    finally { isSubmitting = false; }
  }

  async function doSubmitRequest(body, container) {
    const submitBtn = body.querySelector('#fin-submit-btn');
    const errEl = body.querySelector('#fin-form-error');
    const savedEl = body.querySelector('#fin-form-saved-msg');
    errEl.textContent = ''; savedEl.textContent = '';

    const category = body.querySelector('#fin-category').value;
    const budgetStatusSel = body.querySelector('#fin-budget-status');
    const budgetStatus = budgetStatusSel ? budgetStatusSel.value : '';
    const amount = Number(body.querySelector('#fin-amount').value) || 0;
    const vendor = body.querySelector('#fin-vendor').value.trim();
    const desc = body.querySelector('#fin-desc').value.trim();

    if (!category) { errEl.textContent = 'Please select a category.'; return; }
    if (amount <= 0) { errEl.textContent = 'Please enter an amount greater than zero.'; return; }

    const result = resolveRule(category, budgetStatus, amount);
    if (result.blocked) { errEl.textContent = result.message; return; }
    if (!result.rule) { errEl.textContent = 'No approval rule matches this category/amount combination — contact your Developer.'; return; }
    const rule = result.rule;
    const docs = requiredDocsList(rule);
    // If the Purchase Requisition is being filled in-app, it no longer needs
    // to be one of the uploaded attachments — the in-app fields below stand
    // in for FIN-F-004 directly.
    const docsNeedingUpload = fillPrInApp ? docs.filter(d => !/purchase request/i.test(d)) : docs;
    const minAttachments = Math.min(docsNeedingUpload.length, 3);
    if (pendingAttachments.length < minAttachments) {
      errEl.textContent = `This category requires at least ${minAttachments} attachment(s): ${docsNeedingUpload.join(', ')}.`;
      return;
    }
    let prFields = {};
    if (fillPrInApp) {
      const val = id => (body.querySelector(id) || { value: '' }).value.trim();
      prFields = {
        PR_AssetFacility: val('#fin-pr-asset'), PR_Location: val('#fin-pr-location'),
        PR_ReasonJustification: val('#fin-pr-reason'), PR_CurrentCondition: val('#fin-pr-condition'),
        PR_RiskIfDeferred: val('#fin-pr-risk'), PR_ProcurementMethod: val('#fin-pr-method'),
        PR_ExpectedCompletionDays: val('#fin-pr-days')
      };
      if (!prFields.PR_AssetFacility || !prFields.PR_ReasonJustification) {
        errEl.textContent = 'Please fill in at least Asset/Facility and Reason/Justification on the Purchase Requisition.';
        return;
      }
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    const user = MVOA.getUser();
    const existingIds = requestsCache.map(r => r.RequestID);
    const requestId = MVOA.nextId('FIN', existingIds);
    const now = new Date().toISOString();

    const attachmentUrls = ['', '', ''];
    if (pendingAttachments.length) {
      for (let i = 0; i < Math.min(pendingAttachments.length, 3); i++) {
        const att = pendingAttachments[i];
        try {
          attachmentUrls[i] = await MVOA.uploadPhotoToDrive(att.file, `${requestId}_att${i+1}_${att.name}`);
        } catch (e) {
          errEl.textContent = `Attachment ${i+1} upload failed: ${e.message}`;
          submitBtn.disabled = false; submitBtn.textContent = 'Submit Request';
          return;
        }
      }
    }

    const requestType = category === 'Petty Cash Reimbursement' ? 'PettyCashReimbursement'
      : category === 'Emergency Expenditure' ? 'Emergency' : 'Standard';

    const row = Object.assign({
      RequestID: requestId, RuleID: rule.RuleID, Category: category, BudgetStatus: budgetStatus,
      Amount: amount, Vendor: vendor, Description: desc, RequestedBy: user.name, RequestedDate: now,
      RequestType: requestType, AttachmentURL_1: attachmentUrls[0], AttachmentURL_2: attachmentUrls[1],
      AttachmentURL_3: attachmentUrls[2], RequiredDocsSnapshot: rule.MinimumDocs || '',
      Status: 'PendingApproval', QuorumRequired: rule.QuorumOverride || '', ECApprovalCount: 0,
      ClosedDate: '', ClosedBy: '', PaymentStatus: 'Unpaid', PaymentDate: '', PaymentRef: '',
      NotifiedAt: '', ReminderSentAt: '', DisbursementStage: '', ExpenseTab: '', ExpenseRow: '',
      StageEnteredAt: now
    }, prFields);

    try {
      await MVOA.sheetsAppend(TAB_REQUESTS, objToRow(REQUEST_COLS, row));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Submitted', comment: `${category} — ${formatAmount(amount)}`, statusAfter: 'PendingApproval' });
    } catch (e) {
      errEl.textContent = 'Could not save request: ' + e.message;
      submitBtn.disabled = false; submitBtn.textContent = 'Submit Request';
      return;
    }

    pendingAttachments = [];
    fillPrInApp = false;
    await loadAll();
    currentView = 'mine';
    render(container);
  }

  // ───────────────────────────────────────────────────────────
  // MY REQUESTS
  // ───────────────────────────────────────────────────────────
  function statusBadge(text, colorClass) {
    const colors = {
      pending: '#8a6d00;background:#fdf1cf',
      approved: '#0f6e56;background:#eaf5ef',
      rejected: '#a32d2d;background:#fbeaea',
      paid: '#185fa5;background:#e6f1fb'
    };
    return `<span class="mvoa-badge" style="color:${colors[colorClass].split(';')[0]};background:${colors[colorClass].split('background:')[1]};">${escapeHtml(text)}</span>`;
  }

  function displayStatus(request) {
    if (request.Status === 'Rejected') return statusBadge('Rejected', 'rejected');
    if (request.Status === 'Approved' && request.PaymentStatus === 'Paid') return statusBadge('Paid', 'paid');
    if (request.Status === 'Approved') return statusBadge('Approved — awaiting payment', 'approved');
    return statusBadge('Pending approval', 'pending');
  }

  async function renderMine(body, container) {
    const user = MVOA.getUser();
    const list = requestsCache.filter(r => r.RequestedBy === user.name)
      .sort((a, b) => (b.RequestedDate || '').localeCompare(a.RequestedDate || ''));
    if (!list.length) {
      body.innerHTML = `<p class="muted">You haven't submitted any requests yet.</p>`;
      return;
    }
    body.innerHTML = `<p class="muted">Loading current status…</p>`;
    let allApprovals = [];
    try {
      const rows = await MVOA.sheetsRead(TAB_APPROVALS);
      allApprovals = rows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2));
    } catch (e) { /* fall back to coarse status below if this fails */ }

    body.innerHTML = list.map(r => {
      const approvals = allApprovals.filter(a => a.RequestID === r.RequestID);
      const badge = allApprovals.length || r.Status !== 'PendingApproval' ? stageBadgeHtml(r, approvals) : displayStatus(r);
      return `
      <div class="mvoa-list-item" data-request-id="${escapeHtml(r.RequestID)}">
        <div class="mvoa-row">
          <strong>${escapeHtml(r.Category)} — ${formatAmount(r.Amount)}</strong>
          ${badge}
        </div>
        ${r.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(r.Vendor)}</p>` : ''}
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">Submitted ${formatDate(r.RequestedDate)}</p>
        <button class="fin-mine-notes-toggle btn-secondary" data-request-id="${escapeHtml(r.RequestID)}" style="font-size:0.8rem;padding:4px 10px;margin-top:6px;">💬 Notes</button>
        <div class="fin-mine-notes-body hidden" data-request-id="${escapeHtml(r.RequestID)}"></div>
      </div>
    `; }).join('');

    body.querySelectorAll('.fin-mine-notes-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.requestId;
        const notesBody = body.querySelector(`.fin-mine-notes-body[data-request-id="${id}"]`);
        const isHidden = notesBody.classList.contains('hidden');
        if (!isHidden) { notesBody.classList.add('hidden'); btn.textContent = '💬 Notes'; return; }
        notesBody.classList.remove('hidden');
        await renderNotesThread(notesBody, id, btn, true);
      });
    });
  }

  async function renderNotesThread(notesBody, requestId, toggleBtn, canWrite) {
    notesBody.innerHTML = `<p class="muted" style="font-size:0.8rem;padding:8px 0;">Loading notes…</p>`;
    let notes;
    try {
      const rows = await MVOA.sheetsRead(TAB_NOTES);
      notes = rows.slice(1).map((r, i) => rowToObj(NOTE_COLS, r, i + 2)).filter(n => n.RequestID === requestId);
    } catch (e) {
      notesBody.innerHTML = `<p class="error-text">Could not load notes: ${escapeHtml(e.message)}</p>`;
      return;
    }
    if (toggleBtn) toggleBtn.textContent = `💬 Notes (${notes.length})`;
    const notesHtml = notes.length
      ? notes.map(n => `
          <div style="border-left:3px solid var(--mvoa-blue);padding:6px 10px;margin-bottom:8px;background:var(--bg);border-radius:0 6px 6px 0;">
            <div class="mvoa-row" style="margin-bottom:2px;">
              <strong style="font-size:0.85rem;">${escapeHtml(n.Author)}</strong>
              <span class="muted" style="font-size:0.75rem;">${formatDate(n.Timestamp)}</span>
            </div>
            <p style="margin:0;font-size:0.9rem;">${escapeHtml(n.Note)}</p>
          </div>`).join('')
      : `<p class="muted" style="font-size:0.8rem;padding:4px 0;">No notes yet.</p>`;

    const addForm = canWrite ? `
      <div style="margin-top:8px;">
        <textarea id="fin-note-text-${requestId}" rows="2" placeholder="Ask a question or leave a clarification…" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:8px;font-size:0.9rem;resize:vertical;box-sizing:border-box;"></textarea>
        <button class="btn-primary fin-note-submit" data-request-id="${requestId}" style="margin-top:6px;width:100%;">Add Note</button>
        <p class="error-text fin-note-error" style="min-height:1em;margin-top:4px;"></p>
      </div>` : '';

    notesBody.innerHTML = `
      <div style="margin-top:8px;padding:10px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);">
        ${notesHtml}
        ${addForm}
      </div>`;

    if (canWrite) {
      const submitBtn = notesBody.querySelector('.fin-note-submit');
      const textarea = notesBody.querySelector(`#fin-note-text-${requestId}`);
      const errEl = notesBody.querySelector('.fin-note-error');
      submitBtn.addEventListener('click', async () => {
        const text = textarea.value.trim();
        errEl.textContent = '';
        if (!text) { errEl.textContent = 'Note cannot be empty.'; return; }
        submitBtn.disabled = true; submitBtn.textContent = 'Saving…';
        try {
          const user = MVOA.getUser();
          const existingIds = [];
          const noteId = MVOA.nextId('NOTE', existingIds);
          const row = { NoteID: noteId, RequestID: requestId, Author: user.name, Timestamp: new Date().toISOString(), Note: text };
          await MVOA.sheetsAppend(TAB_NOTES, objToRow(NOTE_COLS, row));
          textarea.value = '';
          await renderNotesThread(notesBody, requestId, toggleBtn, canWrite);
        } catch (e) {
          errEl.textContent = 'Could not save note: ' + escapeHtml(e.message);
          submitBtn.disabled = false; submitBtn.textContent = 'Add Note';
        }
      });
    }
  }

  // ───────────────────────────────────────────────────────────
  // APPROVAL QUEUE
  // ───────────────────────────────────────────────────────────
  async function renderQueue(body, container) {
    body.innerHTML = `<p class="muted">Loading queue…</p>`;
    const user = MVOA.getUser();
    const person = rolesCache.find(p => p.Name === user.name) || {};
    const pending = requestsCache.filter(r => r.Status === 'PendingApproval');
    const approved = requestsCache.filter(r => r.Status === 'Approved' && r.PaymentStatus !== 'Paid');

    const cards = [];
    for (const req of pending) {
      const approvals = await loadApprovalsFor(req.RequestID);
      const state = computeRequestState(req, approvals);
      if (state.rejected || state.fullyApproved) continue; // will settle on next refresh
      let eligible = false;
      if (state.stage === 'Administrative' || state.stage === 'Financial') {
        eligible = (state.groups || []).some(g => personMatchesAndGroup(person, g));
      } else if (state.stage === 'EC') {
        eligible = isEcMember(person) && !approvals.some(a => a.Stage === 'EC' && a.ApproverName === user.name);
      } else if (state.stage === 'AGM') {
        eligible = isAdmin(person);
      }
      if (eligible) cards.push({ req, state, approvals });
    }

    body.innerHTML = `
      <h3 style="color:var(--mvoa-blue);margin:0 0 8px;">Awaiting your action</h3>
      ${cards.length ? '' : '<p class="muted">Nothing waiting on you right now.</p>'}
      <div id="fin-queue-cards"></div>
      <p class="muted" style="margin-top:16px;">Once a request is fully approved, its actual payment release (Expense Sheet entry → Treasurer review → Disbursement Officer) happens in the <strong>₹ Payments</strong> tab, not here.</p>
    `;

    const cardsEl = body.querySelector('#fin-queue-cards');
    const lastSeen = getLastSeen(LS_QUEUE_SEEN);
    cards.forEach(({ req, state }) => {
      const div = document.createElement('div');
      div.className = 'mvoa-list-item';
      div.innerHTML = `
        <div class="mvoa-row">
          <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
          <span>
            ${isNewSince(req, lastSeen) ? '<span class="mvoa-badge" style="color:#8a4b00;background:#fff1de;margin-right:4px;">🆕 New</span>' : ''}
            <span class="mvoa-badge" style="color:#185fa5;background:#e6f1fb;">${escapeHtml(state.stage)} approval</span>
          </span>
        </div>
        ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
        ${req.Description ? `<p class="muted" style="margin:4px 0;">${escapeHtml(req.Description)}</p>` : ''}
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">By ${escapeHtml(req.RequestedBy)} · ${formatDate(req.RequestedDate)}</p>
        ${attachmentLinksHtml(req)}
        ${state.stage === 'EC' ? `<p class="muted" style="margin:4px 0;font-size:0.8rem;">${state.ecCount} of ${state.quorum} EC approvals so far</p>` : ''}
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-primary fin-approve-btn" data-request-id="${escapeHtml(req.RequestID)}" data-stage="${escapeHtml(state.stage)}" style="margin:0;">Approve</button>
          ${state.stage !== 'AGM' ? `<button class="btn-secondary fin-reject-btn" data-request-id="${escapeHtml(req.RequestID)}" data-stage="${escapeHtml(state.stage)}" style="margin:0;">Reject</button>` : ''}
          <button class="btn-secondary fin-queue-notes-toggle" data-request-id="${escapeHtml(req.RequestID)}" style="margin:0;">💬 Ask a question</button>
        </div>
        <p class="error-text fin-queue-error" data-request-id="${escapeHtml(req.RequestID)}" style="min-height:1em;margin-top:4px;"></p>
        <div class="fin-queue-notes-body hidden" data-request-id="${escapeHtml(req.RequestID)}"></div>
      `;
      cardsEl.appendChild(div);
    });

    cardsEl.querySelectorAll('.fin-approve-btn').forEach(btn => {
      btn.addEventListener('click', () => decide(btn.dataset.requestId, btn.dataset.stage, 'Approved', container));
    });
    cardsEl.querySelectorAll('.fin-reject-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const comment = prompt('Reason for rejecting (required):');
        if (comment && comment.trim()) decide(btn.dataset.requestId, btn.dataset.stage, 'Rejected', container, comment.trim());
      });
    });
    cardsEl.querySelectorAll('.fin-queue-notes-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.requestId;
        const notesBody = cardsEl.querySelector(`.fin-queue-notes-body[data-request-id="${id}"]`);
        const isHidden = notesBody.classList.contains('hidden');
        if (!isHidden) { notesBody.classList.add('hidden'); btn.textContent = '💬 Ask a question'; return; }
        notesBody.classList.remove('hidden');
        await renderNotesThread(notesBody, id, null, true);
      });
    });
    markSeenNow(LS_QUEUE_SEEN); // cards just shown with "🆕 New" (if any) — reset for next visit
  }

  function attachmentLinksHtml(r) {
    const urls = [r.AttachmentURL_1, r.AttachmentURL_2, r.AttachmentURL_3];
    const links = urls.filter(Boolean).map((url, i) => `<a href="${url}" target="_blank" rel="noopener">📎 Attachment ${i + 1}</a>`).join(' · ');
    return links ? `<p class="muted" style="font-size:0.8rem;">${links}</p>` : '';
  }

  async function decide(requestId, stage, decision, container, comment) {
    const user = MVOA.getUser();
    const errEl = document.querySelector(`.fin-queue-error[data-request-id="${requestId}"]`);
    try {
      const req = requestsCache.find(r => r.RequestID === requestId);
      const priorApprovals = await loadApprovalsFor(requestId); // BEFORE this decision is appended, for stage comparison below
      const priorState = computeRequestState(req, priorApprovals);

      const existingIds = [];
      const approvalId = MVOA.nextId('APR', existingIds);
      const row = {
        ApprovalID: approvalId, RequestID: requestId, ApproverName: user.name, ApproverRole: user.role || '',
        Stage: stage, Decision: decision, Comment: comment || '', Timestamp: new Date().toISOString()
      };
      await MVOA.sheetsAppend(TAB_APPROVALS, objToRow(APPROVAL_COLS, row));

      let resultingStatus = req.Status;
      const now = new Date().toISOString();
      if (decision === 'Rejected') {
        const updated = Object.assign({}, req, { Status: 'Rejected', ClosedDate: now, ClosedBy: user.name, StageEnteredAt: now });
        await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
        resultingStatus = 'Rejected';
      } else {
        const freshApprovals = await loadApprovalsFor(requestId);
        const state = computeRequestState(req, freshApprovals);
        if (state.fullyApproved) {
          // Now entering the payment-release chain — DisbursementStage starts
          // blank (Accountant's "needs an Expense Sheet entry" queue), and
          // StageEnteredAt marks the moment of full approval.
          const updated = Object.assign({}, req, { Status: 'Approved', ECApprovalCount: state.ecCount, StageEnteredAt: now });
          await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
          resultingStatus = 'Approved';
        } else if (state.stage === priorState.stage) {
          // Still the same stage — either an EC vote toward quorum, or one
          // half of an AND group (e.g. "Secretary & President") just signed
          // off while the other hasn't yet. Not a stage change, so
          // StageEnteredAt is left alone — the still-pending approver
          // already knew about this one.
          const updated = Object.assign({}, req, { ECApprovalCount: state.ecCount });
          await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
          resultingStatus = state.stage === 'EC' ? `PendingApproval (${state.ecCount}/${state.quorum} EC)` : `PendingApproval (${state.stage})`;
        } else {
          // Moved on to a genuinely new stage (Administrative→Financial,
          // Financial→EC, EC→AGM) — this is exactly what the 🆕 New
          // indicator for the next approver is keyed off.
          const updated = Object.assign({}, req, { StageEnteredAt: now });
          await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
          resultingStatus = `PendingApproval (next: ${state.stage})`;
        }
      }
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: `${stage} ${decision}`, comment: comment || '', statusAfter: resultingStatus });
      await loadAll();
      render(container);
    } catch (e) {
      if (errEl) errEl.textContent = 'Could not save decision: ' + e.message;
    }
  }

  // Final step of the Schedule D workflow — called by the Disbursement
  // Officer's action in the Payments tab once UDNumber/Date have been
  // written into the Expense Sheet row itself (see renderPayments).
  async function markPaid(requestId, paymentRef) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req) return;
    const user = MVOA.getUser();
    const now = new Date().toISOString();
    const updated = Object.assign({}, req, {
      PaymentStatus: 'Paid', PaymentDate: now, PaymentRef: paymentRef || '',
      DisbursementStage: 'Paid', ClosedDate: now, ClosedBy: user.name, StageEnteredAt: now
    });
    await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
    await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Paid', comment: paymentRef || '', statusAfter: 'Paid' });
  }

  // ═══════════════════════════════════════════════════════════════
  // PAYMENTS — the real Schedule D release workflow: Accountant logs the
  // Expense Sheet entry → Treasurer reviews (approve, or send back with a
  // query — may repeat) → Disbursement Officer releases payment. See the
  // header comment for the full column/stage reference.
  // ═══════════════════════════════════════════════════════════════

  function isAccountantPerson(person) {
    const title = (person.Title || '').toLowerCase();
    return (person.Role || '').toUpperCase() === 'ACCT' || title.indexOf('accountant') !== -1;
  }
  function isDisbursementOfficerPerson(person) {
    const title = (person.Title || '').toLowerCase();
    return (person.Role || '').toUpperCase() === 'DISB' || title.indexOf('disbursement officer') !== -1;
  }
  function isTreasurerPerson(person) {
    return roleMatchesToken(person, 'treasurer');
  }

  function currentPerson() {
    const user = MVOA.getUser();
    return rolesCache.find(p => p.Name === user.name) || { Name: user.name, Role: user.role, Title: user.title };
  }

  function expenseTabForDate(d) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return EXPENSE_TAB_PREFIX + months[d.getMonth()] + String(d.getFullYear()).slice(-2);
  }
  function allKnownExpenseTabs() {
    const tabs = new Set([expenseTabForDate(new Date())]);
    requestsCache.forEach(r => { if (r.ExpenseTab) tabs.add(r.ExpenseTab); });
    return [...tabs].sort().reverse();
  }
  async function readExpenseRow(tab, requestId) {
    const rows = await MVOA.sheetsRead(tab);
    const idx = rows.findIndex((r, i) => i > 0 && r[0] === requestId);
    if (idx === -1) return null;
    return { row: rowToObj(EXPENSE_COLS, rows[idx], idx + 1), rowNumber: idx + 1 };
  }

  function renderPayments(body, container) {
    const person = currentPerson();
    const isAcct = isAccountantPerson(person);
    const isTres = isTreasurerPerson(person);
    const isDisb = isDisbursementOfficerPerson(person);
    const isAdminUser = isAdmin(person);

    if (!isAcct && !isTres && !isDisb && !isAdminUser) {
      body.innerHTML = `<p class="muted">Payment release (Expense Sheet entry, Treasurer review, Disbursement) is handled by the Accountant, Treasurer and Disbursement Officer. You don't have any actions here.</p>`;
      return;
    }

    const needsExpenseEntry = requestsCache.filter(r => r.Status === 'Approved' && !r.DisbursementStage);
    const needsCorrection = requestsCache.filter(r => r.DisbursementStage === 'NeedsCorrection');
    const pendingTreasurer = requestsCache.filter(r => r.DisbursementStage === 'PendingTreasurer');
    const pendingPayment = requestsCache.filter(r => r.DisbursementStage === 'PendingPayment');
    const paid = requestsCache.filter(r => r.DisbursementStage === 'Paid')
      .sort((a, b) => (b.ClosedDate || '').localeCompare(a.ClosedDate || '')).slice(0, 10);

    body.innerHTML = `
      <div style="margin-bottom:14px;">
        <button id="fin-view-expense-sheet-btn" class="btn-secondary">📅 View Expense Sheet</button>
      </div>
      ${(isAcct || isAdminUser) ? `
        <h3 style="color:var(--mvoa-blue);margin:0 0 8px;">Approved — log Expense Sheet entry</h3>
        ${needsExpenseEntry.length ? '<div id="fin-pay-needentry"></div>' : '<p class="muted">Nothing waiting to be logged.</p>'}
        <h3 style="color:var(--mvoa-blue);margin:20px 0 8px;">Sent back for correction</h3>
        ${needsCorrection.length ? '<div id="fin-pay-correction"></div>' : '<p class="muted">Nothing needs correction right now.</p>'}
      ` : ''}
      ${(isTres || isAdminUser) ? `
        <h3 style="color:var(--mvoa-blue);margin:20px 0 8px;">Awaiting your review</h3>
        ${pendingTreasurer.length ? '<div id="fin-pay-treasurer"></div>' : '<p class="muted">Nothing awaiting your review.</p>'}
      ` : ''}
      ${(isDisb || isAdminUser) ? `
        <h3 style="color:var(--mvoa-blue);margin:20px 0 8px;">Ready for payment</h3>
        ${pendingPayment.length ? '<div id="fin-pay-disburse"></div>' : '<p class="muted">Nothing awaiting payment.</p>'}
      ` : ''}
      <h3 style="color:var(--mvoa-blue);margin:20px 0 8px;">Recently paid</h3>
      ${paid.length ? '<div id="fin-pay-recent"></div>' : '<p class="muted">No payments logged yet.</p>'}
    `;

    body.querySelector('#fin-view-expense-sheet-btn').addEventListener('click', () => renderExpenseSheetBrowser(container));

    const lastSeen = getLastSeen(LS_PAYMENTS_SEEN);
    const newBadge = (req) => isNewSince(req, lastSeen) ? '<span class="mvoa-badge" style="color:#8a4b00;background:#fff1de;margin-right:4px;">🆕 New</span>' : '';

    function baseCard(req, extraRight) {
      return `
        <div class="mvoa-list-item" data-request-id="${escapeHtml(req.RequestID)}">
          <div class="mvoa-row">
            <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
            <span>${newBadge(req)}${extraRight || ''}</span>
          </div>
          ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          <p class="muted" style="margin:4px 0;font-size:0.8rem;">Requested by ${escapeHtml(req.RequestedBy)} · ${formatDate(req.RequestedDate)}</p>
        </div>`;
    }

    if (needsExpenseEntry.length) {
      const el = body.querySelector('#fin-pay-needentry');
      el.innerHTML = needsExpenseEntry.map(req => baseCard(req,
        `<button class="btn-primary fin-log-entry-btn" data-request-id="${escapeHtml(req.RequestID)}" style="margin:0;">Log Expense Entry</button>`
      )).join('');
      el.querySelectorAll('.fin-log-entry-btn').forEach(btn => {
        btn.addEventListener('click', () => openExpenseEntryDialog(btn.dataset.requestId, container, false));
      });
    }
    if (needsCorrection.length) {
      const el = body.querySelector('#fin-pay-correction');
      el.innerHTML = needsCorrection.map(req => `
        <div class="mvoa-list-item" data-request-id="${escapeHtml(req.RequestID)}">
          <div class="mvoa-row">
            <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
            <span class="mvoa-badge" style="color:#a32d2d;background:#fbeaea;">Needs correction</span>
          </div>
          ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          <button class="btn-secondary fin-corr-notes-toggle" data-request-id="${escapeHtml(req.RequestID)}" style="font-size:0.8rem;padding:4px 10px;margin:6px 6px 0 0;">💬 See Treasurer's query</button>
          <button class="btn-primary fin-edit-entry-btn" data-request-id="${escapeHtml(req.RequestID)}" style="font-size:0.8rem;padding:4px 10px;margin:6px 0 0 0;">Edit &amp; Resubmit</button>
          <div class="fin-corr-notes-body hidden" data-request-id="${escapeHtml(req.RequestID)}"></div>
        </div>`).join('');
      el.querySelectorAll('.fin-edit-entry-btn').forEach(btn => {
        btn.addEventListener('click', () => openExpenseEntryDialog(btn.dataset.requestId, container, true));
      });
      el.querySelectorAll('.fin-corr-notes-toggle').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.requestId;
          const notesBody = el.querySelector(`.fin-corr-notes-body[data-request-id="${id}"]`);
          const isHidden = notesBody.classList.contains('hidden');
          if (!isHidden) { notesBody.classList.add('hidden'); return; }
          notesBody.classList.remove('hidden');
          await renderNotesThread(notesBody, id, null, true);
        });
      });
    }
    if (pendingTreasurer.length) {
      const el = body.querySelector('#fin-pay-treasurer');
      pendingTreasurer.forEach(async req => {
        const div = document.createElement('div');
        div.className = 'mvoa-list-item';
        div.dataset.requestId = req.RequestID;
        div.innerHTML = `<p class="muted">Loading entry…</p>`;
        el.appendChild(div);
        let entry = null;
        try { entry = req.ExpenseTab ? await readExpenseRow(req.ExpenseTab, req.RequestID) : null; } catch (e) { /* fall through */ }
        div.innerHTML = `
          <div class="mvoa-row">
            <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
            <span>${newBadge(req)}<span class="mvoa-badge" style="color:#8a6d00;background:#fdf1cf;">Awaiting review</span></span>
          </div>
          ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          ${entry ? `
            <p class="muted" style="margin:4px 0;font-size:0.85rem;">Invoice ${escapeHtml(entry.row.InvoiceNumber || '—')} · Gross ${formatAmount(entry.row.GrossAmount)} · GST ${escapeHtml(entry.row.GST || '0')} · TDS ${escapeHtml(entry.row.TDS || '0')} · Net ${formatAmount(entry.row.NetAmount)}</p>
          ` : '<p class="error-text" style="font-size:0.85rem;">Could not load the Expense Sheet entry.</p>'}
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn-primary fin-treasurer-approve-btn" data-request-id="${escapeHtml(req.RequestID)}" style="margin:0;">Approve</button>
            <button class="btn-secondary fin-treasurer-sendback-btn" data-request-id="${escapeHtml(req.RequestID)}" style="margin:0;">Send Back with Query</button>
          </div>
          <p class="error-text fin-treasurer-error" data-request-id="${escapeHtml(req.RequestID)}" style="min-height:1em;margin-top:4px;"></p>
        `;
        div.querySelector('.fin-treasurer-approve-btn').addEventListener('click', () => treasurerApprove(req.RequestID, container));
        div.querySelector('.fin-treasurer-sendback-btn').addEventListener('click', () => {
          const q = prompt('What needs to be corrected? (this will be sent to the Accountant)');
          if (q && q.trim()) treasurerSendBack(req.RequestID, q.trim(), container);
        });
      });
    }
    if (pendingPayment.length) {
      const el = body.querySelector('#fin-pay-disburse');
      el.innerHTML = pendingPayment.map(req => `
        <div class="mvoa-list-item" data-request-id="${escapeHtml(req.RequestID)}">
          <div class="mvoa-row">
            <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
            <span>${newBadge(req)}<span class="mvoa-badge" style="color:#0f6e56;background:#eaf5ef;">Treasurer approved</span></span>
          </div>
          ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          <div style="margin-top:8px;">
            <input type="text" class="fin-ud-number" data-request-id="${escapeHtml(req.RequestID)}" placeholder="UD Number / Cheque / UTR" style="width:100%;margin-bottom:6px;">
            <button class="btn-primary fin-disburse-btn" data-request-id="${escapeHtml(req.RequestID)}" style="margin:0;">Release Payment</button>
          </div>
          <p class="error-text fin-disburse-error" data-request-id="${escapeHtml(req.RequestID)}" style="min-height:1em;margin-top:4px;"></p>
        </div>`).join('');
      el.querySelectorAll('.fin-disburse-btn').forEach(btn => {
        btn.addEventListener('click', () => disbursePayment(btn.dataset.requestId, el, container));
      });
    }
    if (paid.length) {
      const el = body.querySelector('#fin-pay-recent');
      el.innerHTML = paid.map(req => baseCard(req,
        `<span class="mvoa-badge" style="color:#185fa5;background:#e6f1fb;">Paid ${req.PaymentRef ? '· ' + escapeHtml(req.PaymentRef) : ''}</span>`
      )).join('');
    }
    markSeenNow(LS_PAYMENTS_SEEN); // cards just shown with "🆕 New" (if any) — reset for next visit
  }

  // ─── Accountant: Log / Edit Expense Sheet entry ───────────────
  function openExpenseEntryDialog(requestId, container, isCorrection) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req) return;
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `<div class="ops-qr-box" style="text-align:left;"><p class="muted">Loading…</p></div>`;
    document.body.appendChild(modal);

    (async () => {
      let existing = null;
      if (isCorrection && req.ExpenseTab) {
        try { existing = (await readExpenseRow(req.ExpenseTab, requestId)) || null; } catch (e) { /* fresh form if unreadable */ }
      }
      const e = (existing && existing.row) || {};
      const tabs = allKnownExpenseTabs();
      const box = modal.querySelector('.ops-qr-box');
      box.innerHTML = `
        <h3>${isCorrection ? 'Edit' : 'Log'} Expense Entry — ${escapeHtml(req.Category)}</h3>
        <label>Month (Expense Sheet tab)
          <select id="fin-exp-tab" ${isCorrection ? 'disabled' : ''}>
            ${tabs.map(t => `<option value="${t}" ${req.ExpenseTab === t ? 'selected' : ''}>${t.replace(EXPENSE_TAB_PREFIX,'')}</option>`).join('')}
          </select>
        </label>
        <label>Vendor <input id="fin-exp-vendor" type="text" value="${escapeHtml(e.Vendor || req.Vendor || '')}"></label>
        <label>Invoice Date <input id="fin-exp-invdate" type="date"></label>
        <label>Invoice Number <input id="fin-exp-invno" type="text" value="${escapeHtml(e.InvoiceNumber || '')}"></label>
        <label>Invoice Period / Purpose <input id="fin-exp-purpose" type="text" value="${escapeHtml(e.InvoicePeriodPurpose || req.Description || '')}"></label>
        <label>Period <input id="fin-exp-period" type="text" value="${escapeHtml(e.Period || '')}"></label>
        <label>Gross Amount (₹) <input id="fin-exp-gross" type="number" min="0" value="${escapeHtml(e.GrossAmount !== undefined ? e.GrossAmount : req.Amount)}"></label>
        <label>GST Applicable? <select id="fin-exp-gst">
          <option value="No" ${(e.GST || 'No') === 'No' ? 'selected' : ''}>No</option>
          <option value="Yes" ${e.GST === 'Yes' ? 'selected' : ''}>Yes</option>
        </select></label>
        <label>TDS Rate (%) <input id="fin-exp-tdsrate" type="number" min="0" value="${escapeHtml(e.TDSRate || 0)}"></label>
        <label>TDS (₹) <input id="fin-exp-tds" type="number" min="0" value="${escapeHtml(e.TDS || 0)}"></label>
        <label>Less / Add (₹, +/-) <input id="fin-exp-lessadd" type="number" value="${escapeHtml(e.LessAdd || 0)}"></label>
        <label>Net Amount (₹) <input id="fin-exp-net" type="number" min="0" value="${escapeHtml(e.NetAmount || '')}"></label>
        <button id="fin-exp-save" class="btn-primary" style="margin-top:10px;">${isCorrection ? 'Resubmit to Treasurer' : 'Save &amp; Send to Treasurer'}</button>
        <button id="fin-exp-cancel" class="btn-secondary">Cancel</button>
        <p class="error-text" id="fin-exp-error"></p>
      `;
      box.querySelector('#fin-exp-cancel').addEventListener('click', () => modal.remove());
      box.querySelector('#fin-exp-save').addEventListener('click', () => saveExpenseEntry(req, modal, container, isCorrection, existing));
    })();
  }

  async function saveExpenseEntry(req, modal, container, isCorrection, existing) {
    const box = modal.querySelector('.ops-qr-box');
    const errEl = box.querySelector('#fin-exp-error');
    const saveBtn = box.querySelector('#fin-exp-save');
    const val = id => box.querySelector(id).value;
    const gross = Number(val('#fin-exp-gross')) || 0;
    const vendor = val('#fin-exp-vendor').trim();
    if (!vendor) { errEl.textContent = 'Vendor is required.'; return; }
    if (gross <= 0) { errEl.textContent = 'Gross Amount must be greater than zero.'; return; }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

    const tabName = isCorrection ? req.ExpenseTab : val('#fin-exp-tab');
    const entryRow = {
      RequestID: req.RequestID,
      SlNo: (existing && existing.row.SlNo) || '',
      Vendor: vendor, InvoiceDate: val('#fin-exp-invdate'), InvoiceNumber: val('#fin-exp-invno'),
      InvoicePeriodPurpose: val('#fin-exp-purpose'), Period: val('#fin-exp-period'),
      GrossAmount: gross, GST: val('#fin-exp-gst'), TDSRate: Number(val('#fin-exp-tdsrate')) || 0,
      TDS: Number(val('#fin-exp-tds')) || 0, LessAdd: Number(val('#fin-exp-lessadd')) || 0,
      NetAmount: Number(val('#fin-exp-net')) || gross,
      NelsonCheck: (existing && existing.row.NelsonCheck) || '', LakshmanCheck: (existing && existing.row.LakshmanCheck) || '',
      ApprovedBy: (existing && existing.row.ApprovedBy) || '', PassedBy: '', UDNumber: '', Date: ''
    };

    try {
      if (isCorrection && existing) {
        await MVOA.sheetsUpdateRow(tabName, existing.rowNumber, objToRow(EXPENSE_COLS, entryRow));
      } else {
        await MVOA.sheetsEnsureTab(tabName, EXPENSE_COLS);
        const existingRows = await MVOA.sheetsRead(tabName);
        entryRow.SlNo = existingRows.length; // header counts as row 1, so this is the new row's position
        await MVOA.sheetsAppend(tabName, objToRow(EXPENSE_COLS, entryRow));
      }
      const updatedReq = Object.assign({}, req, {
        DisbursementStage: 'PendingTreasurer', ExpenseTab: tabName,
        ExpenseRow: isCorrection && existing ? existing.rowNumber : '',
        StageEnteredAt: new Date().toISOString()
      });
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updatedReq));
      await MVOA.logAudit({ module: 'Finance', requestId: req.RequestID, eventType: isCorrection ? 'Expense entry resubmitted' : 'Expense entry logged', comment: '', statusAfter: 'PendingTreasurer' });
      modal.remove();
      await loadAll();
      render(container);
    } catch (err) {
      errEl.textContent = 'Could not save: ' + err.message;
      saveBtn.disabled = false; saveBtn.textContent = isCorrection ? 'Resubmit to Treasurer' : 'Save & Send to Treasurer';
    }
  }

  // ─── Treasurer: Approve or send back ──────────────────────────
  async function treasurerApprove(requestId, container) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req || !req.ExpenseTab) return;
    const user = MVOA.getUser();
    const errEl = document.querySelector(`.fin-treasurer-error[data-request-id="${requestId}"]`);
    try {
      const entry = await readExpenseRow(req.ExpenseTab, requestId);
      if (!entry) throw new Error('Expense Sheet entry not found');
      const updatedEntry = Object.assign({}, entry.row, { PassedBy: `${user.name} · ${new Date().toLocaleDateString()}` });
      await MVOA.sheetsUpdateRow(req.ExpenseTab, entry.rowNumber, objToRow(EXPENSE_COLS, updatedEntry));
      const updatedReq = Object.assign({}, req, { DisbursementStage: 'PendingPayment', ExpenseRow: entry.rowNumber, StageEnteredAt: new Date().toISOString() });
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updatedReq));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Treasurer approved', comment: '', statusAfter: 'PendingPayment' });
      await loadAll();
      render(container);
    } catch (e) {
      if (errEl) errEl.textContent = 'Could not approve: ' + e.message;
    }
  }

  async function treasurerSendBack(requestId, query, container) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req) return;
    const user = MVOA.getUser();
    const errEl = document.querySelector(`.fin-treasurer-error[data-request-id="${requestId}"]`);
    try {
      const existingNoteIds = [];
      const noteId = MVOA.nextId('FNOTE', existingNoteIds);
      await MVOA.sheetsAppend(TAB_NOTES, objToRow(NOTE_COLS, {
        NoteID: noteId, RequestID: requestId, Author: user.name, Timestamp: new Date().toISOString(),
        Note: '⚠️ Sent back for correction: ' + query
      }));
      const updatedReq = Object.assign({}, req, { DisbursementStage: 'NeedsCorrection', StageEnteredAt: new Date().toISOString() });
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updatedReq));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Sent back for correction', comment: query, statusAfter: 'NeedsCorrection' });
      await loadAll();
      render(container);
    } catch (e) {
      if (errEl) errEl.textContent = 'Could not send back: ' + e.message;
    }
  }

  // ─── Disbursement Officer: release payment ────────────────────
  async function disbursePayment(requestId, scopeEl, container) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req || !req.ExpenseTab) return;
    const errEl = scopeEl.querySelector(`.fin-disburse-error[data-request-id="${requestId}"]`);
    const udInput = scopeEl.querySelector(`.fin-ud-number[data-request-id="${requestId}"]`);
    const udNumber = udInput ? udInput.value.trim() : '';
    if (!udNumber) { if (errEl) errEl.textContent = 'Please enter a UD Number / Cheque / UTR reference.'; return; }
    try {
      const entry = await readExpenseRow(req.ExpenseTab, requestId);
      if (!entry) throw new Error('Expense Sheet entry not found');
      const updatedEntry = Object.assign({}, entry.row, { UDNumber: udNumber, Date: new Date().toLocaleDateString() });
      await MVOA.sheetsUpdateRow(req.ExpenseTab, entry.rowNumber, objToRow(EXPENSE_COLS, updatedEntry));
      await markPaid(requestId, udNumber);
      await loadAll();
      render(container);
    } catch (e) {
      if (errEl) errEl.textContent = 'Could not release payment: ' + e.message;
    }
  }

  // ─── Expense Sheet browser — month picker + read-only table ──
  function renderExpenseSheetBrowser(container) {
    const body = document.querySelector('#fin-view-body');
    const tabs = allKnownExpenseTabs();
    body.innerHTML = `
      <button id="fin-exp-browser-back" class="btn-secondary">← Back to Payments</button>
      <div style="margin:12px 0;">
        <label>Month
          <select id="fin-exp-browser-month">
            ${tabs.map(t => `<option value="${t}">${t.replace(EXPENSE_TAB_PREFIX,'')}</option>`).join('')}
          </select>
        </label>
      </div>
      <div id="fin-exp-browser-table" style="overflow-x:auto;"></div>
    `;
    body.querySelector('#fin-exp-browser-back').addEventListener('click', () => renderPayments(body, container));
    const monthSel = body.querySelector('#fin-exp-browser-month');
    const loadMonth = async () => {
      const tableEl = body.querySelector('#fin-exp-browser-table');
      tableEl.innerHTML = `<p class="muted">Loading…</p>`;
      let rows;
      try { rows = await MVOA.sheetsRead(monthSel.value); }
      catch (e) { tableEl.innerHTML = `<p class="muted">No entries yet for this month.</p>`; return; }
      if (rows.length <= 1) { tableEl.innerHTML = `<p class="muted">No entries yet for this month.</p>`; return; }
      const header = EXPENSE_COLS.filter(c => c !== 'RequestID');
      tableEl.innerHTML = `
        <table class="mvoa-table" style="min-width:900px;">
          <thead><tr>${header.map(h => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(1).map(r => {
            const obj = rowToObj(EXPENSE_COLS, r, 0);
            return `<tr>${header.map(h => `<td>${escapeHtml(obj[h] || '')}</td>`).join('')}</tr>`;
          }).join('')}</tbody>
        </table>`;
    };
    monthSel.addEventListener('change', loadMonth);
    loadMonth();
  }

  return { mount };
})();
