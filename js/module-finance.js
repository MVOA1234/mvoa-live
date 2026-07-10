// ═══════════════════════════════════════════════════════════════
// MODULE: Approvals & Payments
// Sheet tabs used: FinanceApprovalRules | FinanceRequests |
//   FinanceApprovals | FinanceRequestNotes | Roles (existing)
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
//   NotifiedAt | ReminderSentAt
//
// FinanceApprovals columns: ApprovalID | RequestID | ApproverName |
//   ApproverRole | Stage | Decision | Comment | Timestamp
//
// FinanceRequestNotes columns: NoteID | RequestID | Author | Timestamp | Note
//
// STATUS values on FinanceRequests: PendingApproval | Approved | Rejected
// PaymentStatus values: Unpaid | Paid
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
  const DEFAULT_QUORUM = 7;

  const RULE_COLS = ['RuleID','ExpenseCategory','BudgetStatus','MinAmount','MaxAmount',
    'InitiatedByRole','TechnicalVerificationRole','AdministrativeApprover','FinancialApprover',
    'ECApprovalRequired','AGMApprovalRequired','QuorumOverride','MinimumDocs','Notes'];

  const REQUEST_COLS = ['RequestID','RuleID','Category','BudgetStatus','Amount','Vendor',
    'Description','RequestedBy','RequestedDate','RequestType','AttachmentURL_1','AttachmentURL_2',
    'AttachmentURL_3','RequiredDocsSnapshot','Status','QuorumRequired','ECApprovalCount',
    'ClosedDate','ClosedBy','PaymentStatus','PaymentDate','PaymentRef','NotifiedAt','ReminderSentAt'];

  const APPROVAL_COLS = ['ApprovalID','RequestID','ApproverName','ApproverRole','Stage','Decision','Comment','Timestamp'];

  const NOTE_COLS = ['NoteID','RequestID','Author','Timestamp','Note'];

  const ROLE_COLS = ['Name','Role','PIN_Hash','Phone','Email','Active','EC_Member','Title','AdminAccess'];

  let rulesCache = [];
  let requestsCache = [];
  let rolesCache = [];
  let currentView = 'mine'; // 'submit' | 'mine' | 'queue'
  let pendingAttachments = []; // up to 3: { name, file, isPhoto, compressedSizeBytes }

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
        <button id="fin-refresh-btn" class="ops-tab-btn" title="Reload from sheet" style="margin-left:auto;">↻ Refresh</button>
      </div>
      <div id="fin-view-body"></div>
    `;
    container.querySelectorAll('.ops-tab-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => { currentView = btn.dataset.view; render(container); });
    });
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
    else renderMine(body, container);
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
      previewEl.innerHTML = `
        <div class="mvoa-list-item" style="margin-top:10px;">
          <p style="margin:0 0 6px;font-weight:600;">This request will need:</p>
          <p class="muted" style="margin:2px 0;">Administrative approval: ${escapeHtml(rule.AdministrativeApprover || '—')}</p>
          <p class="muted" style="margin:2px 0;">Financial approval: ${escapeHtml(rule.FinancialApprover || '—')}</p>
          ${rule.ECApprovalRequired === 'Yes' || rule.ECApprovalRequired === 'Ratification'
            ? `<p class="muted" style="margin:2px 0;">EC ${rule.ECApprovalRequired === 'Ratification' ? 'ratification' : 'approval'} — quorum ${rule.QuorumOverride || DEFAULT_QUORUM}</p>` : ''}
          ${rule.AGMApprovalRequired === 'Yes' ? `<p class="muted" style="margin:2px 0;">AGM approval required</p>` : ''}
          ${docs.length ? `<p class="muted" style="margin:6px 0 0;">Minimum documents: ${docs.map(escapeHtml).join(', ')} — please attach at least ${Math.min(docs.length, 3)} file(s) below.</p>` : ''}
        </div>`;
      body.querySelector('#fin-attachments-label').textContent =
        docs.length ? `Attachments — at least ${Math.min(docs.length, 3)} required` : 'Attachments (optional — up to 3)';
    }

    catEl.addEventListener('change', () => { refreshBudgetStatusSelector(); refreshRulePreview(); });
    amtEl.addEventListener('input', refreshRulePreview);
    refreshBudgetStatusSelector();

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
    const minAttachments = Math.min(docs.length, 3);
    if (pendingAttachments.length < minAttachments) {
      errEl.textContent = `This category requires at least ${minAttachments} attachment(s): ${docs.join(', ')}.`;
      return;
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

    const row = {
      RequestID: requestId, RuleID: rule.RuleID, Category: category, BudgetStatus: budgetStatus,
      Amount: amount, Vendor: vendor, Description: desc, RequestedBy: user.name, RequestedDate: now,
      RequestType: requestType, AttachmentURL_1: attachmentUrls[0], AttachmentURL_2: attachmentUrls[1],
      AttachmentURL_3: attachmentUrls[2], RequiredDocsSnapshot: rule.MinimumDocs || '',
      Status: 'PendingApproval', QuorumRequired: rule.QuorumOverride || '', ECApprovalCount: 0,
      ClosedDate: '', ClosedBy: '', PaymentStatus: 'Unpaid', PaymentDate: '', PaymentRef: '',
      NotifiedAt: '', ReminderSentAt: ''
    };

    try {
      await MVOA.sheetsAppend(TAB_REQUESTS, objToRow(REQUEST_COLS, row));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Submitted', comment: `${category} — ${formatAmount(amount)}`, statusAfter: 'PendingApproval' });
    } catch (e) {
      errEl.textContent = 'Could not save request: ' + e.message;
      submitBtn.disabled = false; submitBtn.textContent = 'Submit Request';
      return;
    }

    pendingAttachments = [];
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

  function renderMine(body, container) {
    const user = MVOA.getUser();
    const list = requestsCache.filter(r => r.RequestedBy === user.name)
      .sort((a, b) => (b.RequestedDate || '').localeCompare(a.RequestedDate || ''));
    if (!list.length) {
      body.innerHTML = `<p class="muted">You haven't submitted any requests yet.</p>`;
      return;
    }
    body.innerHTML = list.map(r => `
      <div class="mvoa-list-item" data-request-id="${escapeHtml(r.RequestID)}">
        <div class="mvoa-row">
          <strong>${escapeHtml(r.Category)} — ${formatAmount(r.Amount)}</strong>
          ${displayStatus(r)}
        </div>
        ${r.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(r.Vendor)}</p>` : ''}
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">Submitted ${formatDate(r.RequestedDate)}</p>
        <button class="fin-mine-notes-toggle btn-secondary" data-request-id="${escapeHtml(r.RequestID)}" style="font-size:0.8rem;padding:4px 10px;margin-top:6px;">💬 Notes</button>
        <div class="fin-mine-notes-body hidden" data-request-id="${escapeHtml(r.RequestID)}"></div>
      </div>
    `).join('');

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

    const paymentEligible = person.Role === 'TRES' || (person.Title || '').toLowerCase().indexOf('secretary') !== -1 || isAdmin(person);

    body.innerHTML = `
      <h3 style="color:var(--mvoa-blue);margin:0 0 8px;">Awaiting your action</h3>
      ${cards.length ? '' : '<p class="muted">Nothing waiting on you right now.</p>'}
      <div id="fin-queue-cards"></div>
      ${paymentEligible ? `
        <h3 style="color:var(--mvoa-blue);margin:20px 0 8px;">Approved — ready for payment</h3>
        ${approved.length ? '' : '<p class="muted">Nothing awaiting payment.</p>'}
        <div id="fin-payment-cards"></div>` : ''}
    `;

    const cardsEl = body.querySelector('#fin-queue-cards');
    cards.forEach(({ req, state }) => {
      const div = document.createElement('div');
      div.className = 'mvoa-list-item';
      div.innerHTML = `
        <div class="mvoa-row">
          <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
          <span class="mvoa-badge" style="color:#185fa5;background:#e6f1fb;">${escapeHtml(state.stage)} approval</span>
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

    if (paymentEligible) {
      const paymentCardsEl = body.querySelector('#fin-payment-cards');
      approved.forEach(req => {
        const div = document.createElement('div');
        div.className = 'mvoa-list-item';
        div.innerHTML = `
          <div class="mvoa-row">
            <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
            ${displayStatus(req)}
          </div>
          ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          <div style="margin-top:8px;">
            <input type="text" class="fin-payment-ref" data-request-id="${escapeHtml(req.RequestID)}" placeholder="Payment reference / UTR (optional)" style="width:100%;margin-bottom:6px;">
            <button class="btn-primary fin-mark-paid-btn" data-request-id="${escapeHtml(req.RequestID)}">Mark as Paid</button>
          </div>
        `;
        paymentCardsEl.appendChild(div);
      });
      paymentCardsEl.querySelectorAll('.fin-mark-paid-btn').forEach(btn => {
        btn.addEventListener('click', () => markPaid(btn.dataset.requestId, body, container));
      });
    }
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
      const existingIds = [];
      const approvalId = MVOA.nextId('APR', existingIds);
      const row = {
        ApprovalID: approvalId, RequestID: requestId, ApproverName: user.name, ApproverRole: user.role || '',
        Stage: stage, Decision: decision, Comment: comment || '', Timestamp: new Date().toISOString()
      };
      await MVOA.sheetsAppend(TAB_APPROVALS, objToRow(APPROVAL_COLS, row));

      const req = requestsCache.find(r => r.RequestID === requestId);
      let resultingStatus = req.Status;
      if (decision === 'Rejected') {
        const updated = Object.assign({}, req, { Status: 'Rejected', ClosedDate: new Date().toISOString(), ClosedBy: user.name });
        await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
        resultingStatus = 'Rejected';
      } else {
        const freshApprovals = await loadApprovalsFor(requestId);
        const state = computeRequestState(req, freshApprovals);
        if (state.fullyApproved) {
          const updated = Object.assign({}, req, { Status: 'Approved', ECApprovalCount: state.ecCount });
          await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
          resultingStatus = 'Approved';
        } else if (stage === 'EC') {
          const updated = Object.assign({}, req, { ECApprovalCount: state.ecCount });
          await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
          resultingStatus = `PendingApproval (${state.ecCount}/${state.quorum} EC)`;
        } else {
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

  async function markPaid(requestId, body, container) {
    const refInput = body.querySelector(`.fin-payment-ref[data-request-id="${requestId}"]`);
    const paymentRef = refInput ? refInput.value.trim() : '';
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req) return;
    const user = MVOA.getUser();
    try {
      const updated = Object.assign({}, req, {
        PaymentStatus: 'Paid', PaymentDate: new Date().toISOString(), PaymentRef: paymentRef,
        ClosedDate: new Date().toISOString(), ClosedBy: user.name
      });
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Paid', comment: paymentRef, statusAfter: 'Paid' });
      await loadAll();
      render(container);
    } catch (e) {
      alert('Could not mark as paid: ' + e.message);
    }
  }

  return { mount };
})();
