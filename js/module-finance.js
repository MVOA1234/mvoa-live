// ═══════════════════════════════════════════════════════════════
// MODULE: Finance Application
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
// DisbursementStage (models the real Schedule D payment-release workflow,
// which only STARTS once Status is already 'Approved' — see
// PAYMENT_PRE_APPROVAL_STAGES for the pre-approval walk that gets it
// there, which as of 27-Aug-2026 itself ends with a Treasurer stage. So a
// Payment Request now sees the Treasurer TWICE: once here in the pre-
// approval chain — before the Accountant ever sees the request — and
// again below, reviewing the Accountant's actual Expense Sheet entry.
// This second, disbursement-pipeline touchpoint works as before: Accountant
// logs the Expense Sheet entry → Treasurer reviews, possibly kicking it
// back for correction over more than one round → Treasurer's approval of
// that entry IS the formal expense-sheet sign-off → Disbursement Officer
// releases payment → Accountant's entry is updated with the Cheque/UTR
// reference):
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
// ("PassedBy" is auto-filled with the Accountant's name/date whenever they
// log or re-log this entry — the preparer sign-off. "ApprovedBy" is
// auto-filled with the Treasurer's name/date when they approve the entry —
// the formal approval, same as the real paper process. UDNumber/Date are
// filled by the Disbursement Officer at the moment of payment.)
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
// helpers below. Petty Cash is one category ("Petty Cash") with an
// internal Type toggle — Expense (deducted live from a ₹15,000 float,
// settles as soon as Approved, never enters Payments/Disbursement) vs
// Replenishment (Secretary admin approval → Payments tab: Accountant
// logs → Treasurer reviews → Disbursement Officer pays out). See
// computeFloatBalance() / isPettyCashExpense().
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('finance', {
  label: 'Finance Application',
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
  // Budget Revision approvals get their OWN sheet, separate from
  // FinanceApprovals — bug found in testing: "My Approvals" and its
  // unread-count badge scan FinanceApprovals globally by ApproverName and
  // expect every RequestID in there to resolve to a real FinanceRequests
  // row (see renderMyApprovals / computeMyApprovalsNewNoteCounts). A
  // Budget Revision's RequestID (e.g. "BREV-0001") never appears in
  // FinanceRequests, so writing its approvals into the shared sheet made
  // it show up there as a permanently-stuck "1 new" phantom card reading
  // "Request no longer available." Same column shape (APPROVAL_COLS),
  // just a different tab so the two chains can never cross-contaminate.
  const TAB_BUDGET_APPROVALS = 'FinanceBudgetApprovals';
  // One-time-agreement registry (Schedule B contracts, Schedule C
  // utility/insurance accounts) — lets a future "Payment Request" flow
  // look up the vendor and check the agreement is still within its valid
  // dates before proceeding, instead of re-approving the spend every time.
  const TAB_CONTRACTS = 'FinanceContracts';
  const CONTRACT_EXPIRY_LEAD_DAYS = 30;
  const TAB_PAYMENT_RULES = 'FinancePaymentRules';
  const EXPENSE_TAB_PREFIX = 'ExpenseSheet_';
  // CORRECTED 27-Aug-2026 per explicit user instruction — was 7.
  const DEFAULT_QUORUM = 6;

  const RULE_COLS = ['RuleID','ExpenseCategory','BudgetStatus','MinAmount','MaxAmount',
    'InitiatedByRole','TechnicalVerificationRole','AdministrativeApprover','FinancialApprover',
    'ECApprovalRequired','AGMApprovalRequired','QuorumOverride','MinimumDocs','Notes',
    // Added after the fact, appended at the very end (matches sheet column
    // order) — distinguishes Petty Cash's two internal request types
    // (Expense / Replenishment) since they share one ExpenseCategory but
    // need different approval routing. Blank for every other category.
    'PettyCashType'];

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
    'StageEnteredAt',
    // Blank until someone individually opens this specific stage-entry
    // (see markStageOpened) — drives the New→Open transition and the
    // per-tab counts shown in the nav bar. Shared across everyone with
    // access (not per-browser) — reset to blank every time StageEnteredAt
    // changes, since a new stage means a fresh "unopened" state.
    'StageOpenedAt',
    // Added after the fact — appended at the end (not inserted earlier in
    // the list) so existing sheet rows/columns stay correctly aligned.
    'PR_Quantity','PR_SuggestedVendor','PR_Urgency',
    // Comparative Statement (FIN-F-001) fields — only populated when the
    // requester used "Fill Comparative Statement in-app" instead of
    // uploading FIN-F-001. Matches the real form field-for-field: up to 3
    // vendor columns (Name/Amount/Delivery/Warranty/Technical Compliance/
    // Previous Performance/Payment Terms/Overall Assessment) plus a
    // recommendation. The Approvals table on the real form is NOT
    // duplicated here — the app's own approval chain covers that.
    'CS_Vendor1Name','CS_Vendor1Amount','CS_Vendor1Delivery','CS_Vendor1Warranty',
    'CS_Vendor1TechCompliance','CS_Vendor1PrevPerformance','CS_Vendor1PaymentTerms','CS_Vendor1OverallAssessment',
    'CS_Vendor2Name','CS_Vendor2Amount','CS_Vendor2Delivery','CS_Vendor2Warranty',
    'CS_Vendor2TechCompliance','CS_Vendor2PrevPerformance','CS_Vendor2PaymentTerms','CS_Vendor2OverallAssessment',
    'CS_Vendor3Name','CS_Vendor3Amount','CS_Vendor3Delivery','CS_Vendor3Warranty',
    'CS_Vendor3TechCompliance','CS_Vendor3PrevPerformance','CS_Vendor3PaymentTerms','CS_Vendor3OverallAssessment',
    'CS_RecommendedVendor','CS_RecommendationReason',
    // Which of Petty Cash's two internal request types this row is —
    // 'Expense' (deducted from the float, no disbursement) or
    // 'Replenishment' (goes to Disbursement Officer for a real payout).
    // Blank for every other category.
    'PettyCashType',
    // Schedule D "New Payment Request" fields — only populated when
    // RequestType === 'PaymentRequest'. ContractID links back to
    // FinanceContracts when the payment was made against a looked-up
    // existing agreement (blank if entered manually / no contract, e.g.
    // Salaries). PaymentStageApprovals aren't stored here — they reuse
    // the existing FinanceApprovals sheet with Stage values
    // FM/OpsHead/Secretary/Treasurer/President instead of
    // Administrative/Financial/EC/AGM. Category holds the Schedule D
    // Payment Type string directly (e.g. "AMC Payments") so every
    // existing Category-based display/report just works unchanged.
    'ContractID',
    // Shared (not per-user) tracking for the Notes thread's "new" flag —
    // same philosophy as StageOpenedAt but kept as its own field since
    // "a new note was added" and "this moved to a new approval stage"
    // are genuinely different kinds of newness and shouldn't clear each
    // other. Blank = an unread note exists (once at least one note has
    // been added); reset to blank every time a note is appended; set to
    // now the first time anyone opens the Notes thread after that.
    'NotesOpenedAt',
    // Only populated when RequestType === 'PaymentRequest' AND no
    // Contract was linked — a direct reference to the RequestID of the
    // Schedule A/B/C Approval-to-Spend request this payment is against,
    // for adhoc/one-off/CAPEX/Miscellaneous payments that never went
    // through the Contracts registry (no Work Order/AMC/agreement sitting
    // behind them). A single Approval-to-Spend can legitimately be linked
    // by more than one Payment Request over time (CAPEX installments, an
    // AMC's multiple payment cycles), so this is never "consumed" by a
    // link — just referenced.
    'LinkedSpendRequestID',
    // Only populated when this Payment Request's Amount exceeds its
    // linked Approval-to-Spend's own approved Amount (see the red flag
    // on New Payment Request) — a required, freeform explanation of why,
    // typed by the requester at submit time. Surfaced to approvers via
    // paymentReferenceLineHtml so whoever approves the payment sees the
    // reason for the overage right alongside the linked ATS reference,
    // not just a bare number mismatch.
    'OverageJustification'];

  const APPROVAL_COLS = ['ApprovalID','RequestID','ApproverName','ApproverRole','Stage','Decision','Comment','Timestamp'];

  const NOTE_COLS = ['NoteID','RequestID','Author','Timestamp','Note'];

  // REWRITTEN 27-Aug-2026: this used to assume a fixed 8-column position
  // order (Name | Role | PIN_Hash | Phone | Email | EC_Member | Active |
  // AdminAccess) — already wrong once already (see git history / the
  // 27-Aug-2026 login-screen bug), and still fragile the same way: any
  // future reorder/insert/delete of a Roles column would silently
  // misread .Active/.Title/etc again with no error, breaking approval
  // routing. Now matches columns by the HEADER ROW'S TEXT (row 1) instead
  // — mirrors the same header-matching rewrite done in shared.js's
  // loadRoles()/writeRolesRow(). This module only ever READS Roles (all
  // writes go through shared.js), so only a read-side mapping is needed.
  //
  // ROLES_FIELD_HEADERS lists, per field, the header text(s) accepted
  // (matched case- and whitespace/underscore-insensitively). "Title" is
  // optional — the live sheet has never had a Title column.
  const ROLES_FIELD_HEADERS = {
    Name: ['name'],
    Role: ['role'],
    PIN_Hash: ['pin_hash', 'pinhash', 'pin hash'],
    Phone: ['phone'],
    Email: ['email'],
    EC_Member: ['ec_member', 'ecmember', 'ec member'],
    Active: ['active'],
    AdminAccess: ['adminaccess', 'admin_access', 'admin access'],
    Title: ['title']
  };
  const ROLES_OPTIONAL_FIELDS = ['Title'];

  function normalizeRolesHeader(h) {
    return String(h || '').trim().toLowerCase().replace(/[\s_]+/g, '');
  }

  // Builds a rowToObj-compatible cols array positioned to match the
  // ACTUAL header row — cols[realIndex] = fieldName, leaving every other
  // index a hole that rowToObj's forEach naturally skips — so rowToObj
  // below keeps working unchanged but now keys off real column positions
  // instead of assumed ones. Throws if a REQUIRED header can't be found,
  // naming exactly which one, instead of silently misreading data.
  function buildRolesCols(headerRow) {
    const normalized = (headerRow || []).map(normalizeRolesHeader);
    const cols = [];
    const missing = [];
    Object.keys(ROLES_FIELD_HEADERS).forEach(field => {
      const candidates = ROLES_FIELD_HEADERS[field].map(normalizeRolesHeader);
      const pos = normalized.findIndex(h => candidates.includes(h));
      if (pos === -1) {
        if (!ROLES_OPTIONAL_FIELDS.includes(field)) missing.push(field);
        return;
      }
      cols[pos] = field;
    });
    if (missing.length) {
      throw new Error('Roles sheet header row is missing expected column(s): ' + missing.join(', ') +
        '. Approval routing cannot work correctly until these headers exist — check row 1 of the Roles sheet.');
    }
    return cols;
  }

  // Mirrors the Association's existing month-by-month Excel Payments
  // sheet column-for-column — see header comment for the workflow this
  // drives.
  const EXPENSE_COLS = ['RequestID','SlNo','Vendor','InvoiceDate','InvoiceNumber',
    'InvoicePeriodPurpose','Period','GrossAmount','GST','TDSRate','TDS','LessAdd','NetAmount',
    'NelsonCheck','LakshmanCheck','ApprovedBy','PassedBy','UDNumber','Date',
    // Added after the fact, appended at the end — which bank account the
    // Disbursement Officer paid from, selected at the moment of release.
    'Bank'];

  // FinanceBudgets — one row per Category × Financial Year, the source of
  // truth for "Total Budget" (this isn't derivable from anything else —
  // it's a real input the EC/Treasurer sets). "Consumed" and "Available"
  // are always computed live from FinanceRequests, never stored, so they
  // can't go stale — see budgetInfoFor().
  const BUDGET_COLS = ['BudgetID','Category','FYYear','TotalBudget','Notes'];
  // FinanceBudgetRevisions — a proposed change to an ALREADY-SET budget
  // line. Approvals for a revision reuse the existing FinanceApprovals
  // sheet (RequestID = RevisionID here, Stage = 'Secretary'/'President'/
  // 'Treasurer') rather than a new table, same philosophy as Schedule D
  // Payment Requests reusing it with their own Stage set. Status only
  // needs to track the one terminal state that can't be re-derived from
  // the approvals log — 'Applied' (the Treasurer has actually written the
  // new TotalBudget back into FinanceBudgets) — everything before that
  // (PendingApproval / fully approved / rejected) is computed live from
  // the approvals log by computeBudgetRevisionState(), same as every
  // other approval chain in this module.
  const TAB_BUDGET_REVISIONS = 'FinanceBudgetRevisions';
  const BUDGET_REVISION_COLS = ['RevisionID','Category','FYYear','CurrentBudget','ProposedBudget',
    'Notes','RequestedBy','RequestedDate','Status','AppliedDate','AppliedBy'];
  const CONTRACT_COLS = ['ContractID','Category','Vendor','VendorDetails','Nature',
    'PO_WO_Number','PolicyNumber','StartDate','EndDate','Status','ApprovedRequestID','Notes'];
  // Schedule D — Payment Approval Authority. A separate table from
  // FinanceApprovalRules on purpose: Schedule A/B/C tier by AMOUNT and
  // walk Administrative→Financial→EC→AGM; Schedule D tiers by PAYMENT
  // TYPE only and walks a fixed FM→OpsHead→Secretary→Treasurer→President
  // chain (each stage skippable per row) — genuinely different shapes,
  // forcing them into one table would mean either fake amount tiers or
  // fake approver columns. See computePaymentRequestState().
  const PAYMENT_RULE_COLS = ['PaymentType','FMRequired','OpsHeadRequired',
    'SecretaryRequired','TreasurerRequired','PresidentRequired','MinimumDocs',
    'RequiresContractLookup','Notes',
    // Which Schedule A/B/C spend Category(ies) this Payment Type is paid
    // against — comma-separated (a single Payment Type can cover several
    // spend categories, e.g. one "Utility Payments" type for several
    // separate utility-account categories). Drives both the Contract/
    // Approval-to-Spend link pickers on New Payment Request (filtered to
    // only show items registered/approved under a matching category) and
    // RequiresContractLookup's enforcement. Left blank for Payment Types
    // with no such upstream spend category (Salaries) or where mapping
    // hasn't been filled in yet — the link pickers fall back to showing
    // everything, unfiltered, rather than silently hiding the right
    // option because of an incomplete mapping.
    'SpendCategory'];

  let rulesCache = [];
  let requestsCache = [];
  let rolesCache = [];
  let budgetsCache = [];
  let budgetRevisionsCache = [];
  let contractsCache = [];
  let paymentRulesCache = [];
  let queueCardsCache = []; // PendingApproval requests THIS user can act on right now — see computeQueueCards()
  let myApprovalsNewNoteCounts = { spend: 0, payment: 0 }; // see computeMyApprovalsNewNoteCounts()
  let currentTopTab = 'home'; // 'home' | 'spend' | 'payment' | 'budget' | 'contracts'
  let currentView = 'mine'; // 'submit' | 'mine' | 'queue' | 'payments' | 'budget'
  let pendingAttachments = []; // up to 3: { name, file, isPhoto, compressedSizeBytes }
  let fillPrInApp = false; // Submit form: Purchase Requisition fill-in-app toggle
  let fillCsInApp = false; // Submit form: Comparative Statement fill-in-app toggle
  let pettyCashType = 'Expense'; // Submit form: Petty Cash's internal Type toggle

  // Financial Year runs Sept–Aug (MVOA's own convention, confirmed by the
  // user — NOT the generic Apr–Mar Indian society/RWA default this used to
  // assume). E.g. "2026-27" runs 1 Sep 2026 – 31 Aug 2027.
  function currentFY() {
    return fyFor(new Date());
  }
  function fyFor(date) {
    const y = date.getFullYear();
    const startYear = date.getMonth() >= 8 ? y : y - 1; // month index 8 = September
    return `${startYear}-${String(startYear + 1).slice(-2)}`;
  }
  function fyDateRange(fy) {
    const startYear = Number(fy.split('-')[0]);
    return { start: new Date(startYear, 8, 1), end: new Date(startYear + 1, 7, 31, 23, 59, 59) };
  }
  function budgetInfoFor(category, fy) {
    const b = budgetsCache.find(x => x.Category === category && x.FYYear === fy);
    if (!b) return null;
    const total = Number(b.TotalBudget) || 0;
    const { start, end } = fyDateRange(fy);
    // "Consumed" = Approved requests against this category that are
    // Budgeted (Unbudgeted spend, by definition, doesn't draw against a
    // budget line) and fall within this FY. Each one starts out counted
    // at its own approved Amount — that's the reservation made the
    // moment the spend is approved, before any payment exists yet.
    //
    // For a one-time expense that later gets a Payment Request directly
    // linked to it (LinkedSpendRequestID) and that payment is itself
    // Approved, the reservation is replaced by the SUM of its linked,
    // Approved payment(s) — the actual committed amount, which can be
    // less (a cheaper final invoice), more (see the over-amount flag on
    // New Payment Request), or split across more than one payment (a
    // multi-installment CAPEX/AMC) than the original spend-approval
    // estimate. A linked payment still PendingApproval or Rejected
    // doesn't replace anything yet — the original estimate keeps
    // reserving the budget until a real payment amount is actually
    // locked in. Recurring/standing categories (linked via ContractID,
    // or not linked to a Payment Request at all) are untouched by this —
    // this only ever fires for requests something actually links back to
    // via LinkedSpendRequestID.
    const consumed = requestsCache
      .filter(r => r.Category === category && r.BudgetStatus === 'Budgeted' && r.Status === 'Approved')
      .filter(r => { const d = new Date(r.RequestedDate); return d >= start && d <= end; })
      .reduce((sum, r) => {
        const linkedApprovedPayments = requestsCache.filter(p =>
          p.RequestType === 'PaymentRequest' && p.LinkedSpendRequestID === r.RequestID && p.Status === 'Approved');
        const actual = linkedApprovedPayments.length
          ? linkedApprovedPayments.reduce((s, p) => s + (Number(p.Amount) || 0), 0)
          : (Number(r.Amount) || 0);
        return sum + actual;
      }, 0);
    return { total, consumed, available: total - consumed, fy };
  }

  // Contracts within CONTRACT_EXPIRY_LEAD_DAYS of their EndDate (or already
  // past it) — mirrors the same "Contract Expiring Soon" pattern already
  // built for Plant Rounds' AMC & Compliance, just with a 30-day lead
  // instead of that module's 14. Status is computed live from EndDate, not
  // trusted from the stored Status column (which is only meant for a
  // manual override like "Terminated" — see FinanceContracts design notes).
  // A blank EndDate means an open-ended commitment (e.g. a utility account
  // with no fixed expiry) — never flagged.
  function computeExpiringContracts() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return contractsCache
      .filter(c => c.EndDate && String(c.Status).toLowerCase() !== 'terminated')
      .map(c => {
        const end = new Date(c.EndDate);
        const daysLeft = Math.round((end - today) / 86400000);
        return Object.assign({}, c, { daysLeft });
      })
      .filter(c => c.daysLeft <= CONTRACT_EXPIRY_LEAD_DAYS)
      .sort((a, b) => a.daysLeft - b.daysLeft);
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
      MVOA.sheetsRead(TAB_RULES, force),
      MVOA.sheetsRead(TAB_REQUESTS, force),
      MVOA.sheetsRead(TAB_ROLES, force)
    ]);
    rulesCache = ruleRows.slice(1).map((r, i) => rowToObj(RULE_COLS, r, i + 2)).filter(r => r.RuleID);
    requestsCache = reqRows.slice(1).map((r, i) => rowToObj(REQUEST_COLS, r, i + 2)).filter(r => r.RequestID);
    if (roleRows.length) {
      const rolesCols = buildRolesCols(roleRows[0]);
      rolesCache = roleRows.slice(1).map((r, i) => rowToObj(rolesCols, r, i + 2)).filter(r => r.Name);
    } else {
      rolesCache = [];
    }
    // Optional tab — Budget Available/Consumed only shows once this exists;
    // fails open so a fresh install without it yet doesn't break anything else.
    try {
      const budgetRows = await MVOA.sheetsRead(TAB_BUDGETS, force);
      budgetsCache = budgetRows.slice(1).map((r, i) => rowToObj(BUDGET_COLS, r, i + 2)).filter(b => b.BudgetID);
    } catch (e) {
      budgetsCache = [];
    }
    // Optional tab — Budget Input/Revise buttons still work without it (a
    // fresh install just won't have any revision history yet); fails open
    // like the other optional tabs above.
    try {
      const revRows = await MVOA.sheetsRead(TAB_BUDGET_REVISIONS, force);
      budgetRevisionsCache = revRows.slice(1).map((r, i) => rowToObj(BUDGET_REVISION_COLS, r, i + 2)).filter(v => v.RevisionID);
    } catch (e) {
      budgetRevisionsCache = [];
    }
    // Optional tab — Contract Expiring Soon banner only shows once this
    // exists; fails open so nothing breaks before it's set up.
    try {
      const contractRows = await MVOA.sheetsRead(TAB_CONTRACTS, force);
      contractsCache = contractRows.slice(1).map((r, i) => rowToObj(CONTRACT_COLS, r, i + 2)).filter(c => c.ContractID);
    } catch (e) {
      contractsCache = [];
    }
    // Optional tab — the "New Payment Request" flow only shows up once
    // this exists; fails open like the others above.
    try {
      const pRuleRows = await MVOA.sheetsRead(TAB_PAYMENT_RULES, force);
      paymentRulesCache = pRuleRows.slice(1).map((r, i) => rowToObj(PAYMENT_RULE_COLS, r, i + 2)).filter(p => p.PaymentType);
    } catch (e) {
      paymentRulesCache = [];
    }
    // Bug found in testing: the "Approval Queue" nav-tab count used to just
    // count ALL PendingApproval requests, while the tab's own "Awaiting
    // your action" list correctly filtered to items THIS user can actually
    // act on — so the count could show "1 open" while the list said
    // "Nothing waiting on you right now" whenever that one item needed a
    // different approver. Both now read from this single cache so they can
    // never disagree.
    //
    // A second bug found alongside it: `force` was accepted by this
    // function but never actually passed to any of the sheetsRead() calls
    // above OR into computeQueueCards() below — so a read immediately
    // after a write (approve/reject/submit/etc.) could still be served a
    // cached snapshot from just before that write, making the count and
    // list BOTH wrong together (consistent with each other, but stale) —
    // exactly the symptom of it clearing up only after leaving and
    // re-entering the module, which forces a genuinely fresh load. Every
    // internal loadAll() call after a mutation now also passes true.
    try {
      queueCardsCache = await computeQueueCards(force);
    } catch (e) {
      queueCardsCache = []; // fail closed on the count rather than showing a wrong number
    }
    // Live count for the "✅ My Approvals" nav button itself — how many
    // requests this user previously approved/rejected now have an
    // unread note (see NotesOpenedAt/hasUnreadNote). Safe to show as a
    // real number here (unlike Sent Back, deliberately left uncounted
    // earlier) since it's now backed by genuine shared tracking, not a
    // heuristic — same underlying data the tab itself displays, so
    // count and content can't disagree.
    try {
      myApprovalsNewNoteCounts = await computeMyApprovalsNewNoteCounts(force);
    } catch (e) {
      myApprovalsNewNoteCounts = { spend: 0, payment: 0 };
    }
    updateBadge();
  }

  async function computeMyApprovalsNewNoteCounts(force) {
    const user = MVOA.getUser();
    const [approvalRows, noteRows] = await Promise.all([
      MVOA.sheetsRead(TAB_APPROVALS, force),
      MVOA.sheetsRead(TAB_NOTES, force)
    ]);
    const allApprovals = approvalRows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2));
    const allNotes = noteRows.slice(1).map((r, i) => rowToObj(NOTE_COLS, r, i + 2));
    const myRequestIds = new Set(allApprovals.filter(a => a.ApproverName === user.name).map(a => a.RequestID));
    let spend = 0, payment = 0;
    myRequestIds.forEach(id => {
      const req = requestsCache.find(r => r.RequestID === id);
      if (!req) return;
      const noteCount = allNotes.filter(n => n.RequestID === id).length;
      if (hasUnreadNote(req, noteCount)) {
        if (req.RequestType === 'PaymentRequest') payment++; else spend++;
      }
    });
    return { spend, payment };
  }

  // Recomputes the badge and patches just its DOM text — deliberately
  // NOT a full render(container), which would blow away whatever notes
  // panel the person just opened to trigger this in the first place.
  async function refreshMyApprovalsBadge(container) {
    try {
      myApprovalsNewNoteCounts = await computeMyApprovalsNewNoteCounts(true);
    } catch (e) {
      return; // leave the badge as-is if this fails — best-effort
    }
    if (currentTopTab !== 'spend' && currentTopTab !== 'payment') return;
    const btn = container.querySelector('.ops-tab-btn[data-view="myapprovals"]');
    if (!btn) return;
    const t = subTabsFor(currentTopTab).find(x => x.view === 'myapprovals');
    if (!t) return;
    const newNoteCount = currentTopTab === 'spend' ? myApprovalsNewNoteCounts.spend : myApprovalsNewNoteCounts.payment;
    btn.innerHTML = `${t.label}${newNoteCount > 0 ? ` <span style="color:#b3261e;">(🆕 ${newNoteCount} new)</span>` : ''}`;
  }

  // One bulk Approvals read (instead of one read per pending request) to
  // work out which PendingApproval requests the CURRENT user can act on
  // right now — same eligibility rules as the Approval Queue view itself.
  // Persists Status:'Approved' for a request whose live-computed state is
  // fullyApproved but whose stored Status hasn't caught up yet. Normally
  // decide() is the only thing that writes Status:'Approved', and it only
  // runs in direct response to a fresh approval action on THAT request —
  // so a request that becomes fully approved WITHOUT a new triggering
  // event (e.g. the 27-Aug-2026 EC-carryover fix made several
  // already-fully-voted requests satisfy quorum retroactively, with no
  // new click to fire decide()) would otherwise sit permanently stuck at
  // PendingApproval: its own trail computes and displays as approved
  // (everything's re-derived live), but every OTHER view keying off the
  // stored Status — My Requests, the Payments/Accountant queue — would
  // never see it, since nothing would ever trigger the write. Called from
  // computeQueueCards on every loadAll() so this can't happen silently.
  async function settleFullyApproved(req, extraFields) {
    if (req.Status !== 'PendingApproval') return; // already settled, or something else — nothing to do
    const now = new Date().toISOString();
    const updated = Object.assign({}, req, extraFields, { Status: 'Approved', StageEnteredAt: now, StageOpenedAt: '' });
    try {
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
      Object.assign(req, updated); // keep requestsCache consistent for the rest of THIS render pass too
      await MVOA.logAudit({ module: 'Finance', requestId: req.RequestID, eventType: 'Auto-settled (already fully approved)', comment: '', statusAfter: 'Approved' });
    } catch (e) { /* best-effort — will retry on the next loadAll() */ }
  }

  async function computeQueueCards(force) {
    const user = MVOA.getUser();
    const person = rolesCache.find(p => p.Name === user.name) || {};
    const pending = requestsCache.filter(r => r.Status === 'PendingApproval');
    if (!pending.length) return [];
    const approvalRows = await MVOA.sheetsRead(TAB_APPROVALS, force);
    const allApprovals = approvalRows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2));
    const cards = [];
    for (const req of pending) {
      const approvals = allApprovals.filter(a => a.RequestID === req.RequestID);
      // Schedule D Payment Requests use their own stage engine (FM→OpsHead
      // →Secretary→Treasurer→President) — genuinely different shape from
      // the Administrative/Financial/EC/AGM chain below, see
      // computePaymentRequestState().
      if (req.RequestType === 'PaymentRequest') {
        const pState = computePaymentRequestState(req, approvals);
        if (pState.fullyApproved) { await settleFullyApproved(req, {}); continue; }
        if (pState.rejected) continue;
        const eligible = pState.stage && pState.stage !== 'Initiator' && roleMatchesToken(person, PAYMENT_STAGE_ROLE_TOKEN[pState.stage]);
        if (eligible) cards.push({ req, state: pState, approvals });
        continue;
      }
      const state = computeRequestState(req, approvals);
      if (state.fullyApproved) { await settleFullyApproved(req, { ECApprovalCount: state.ecCount }); continue; }
      if (state.rejected) continue;
      let eligible = false;
      if (state.stage === 'Administrative' || state.stage === 'Financial') {
        eligible = (state.groups || []).some(g => personMatchesAndGroup(person, g));
      } else if (state.stage === 'EC') {
        // Excludes anyone whose Administrative/Financial/EC approval
        // ALREADY counts toward EC quorum (see ecQualifyingApproverCount)
        // — without this, an EC member who approved earlier at
        // Administrative or Financial would still see a redundant
        // "Approve" card here even though their vote is already counted.
        eligible = isEcMember(person) && !approvals.some(a =>
          ['Administrative', 'Financial', 'EC'].includes(a.Stage) && a.Decision === 'Approved' && a.ApproverName === user.name);
      } else if (state.stage === 'AGM') {
        eligible = isAdmin(person);
      }
      if (eligible) cards.push({ req, state, approvals });
    }
    return cards;
  }

  function updateBadge() {
    const user = MVOA.getUser();
    const count = requestsCache.filter(r => r.Status === 'PendingApproval' && isEligibleForRequest(user, r)).length;
    MVOA.setAppBadge(count);
  }

  async function mount(container) {
    container.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      await loadAll(true);
    } catch (e) {
      container.innerHTML = `<p class="error-text">Could not load Finance Application: ${escapeHtml(e.message)}</p>`;
      return;
    }
    render(container);
  }

  // Sub-tabs for each of the two workflow groups. "Spend Approval" and
  // "Payment Approval" are the two top-level buckets requested — most
  // views (My Requests, My Approvals, Approval Queue) aren't inherently
  // type-specific, so they're offered under BOTH groups for convenience
  // rather than picking one arbitrary home for them. Approval Queue's
  // underlying list IS filtered by type per group (see renderQueue's
  // filterMode param) so each group only shows what's actually relevant
  // to it, even though the raw data is shared.
  function subTabsFor(topTab) {
    if (topTab === 'spend') return [
      { view: 'submit', label: '+ New Request' },
      { view: 'mine', label: 'My Requests' },
      { view: 'sentback', label: '🔁 Sent Back' },
      { view: 'myapprovals', label: '✅ My Approvals' },
      { view: 'queue', label: 'Approval Queue' },
      { view: 'budgetrevisions', label: '🔄 Budget Revisions' }
    ];
    if (topTab === 'payment') return [
      { view: 'payreq', label: '💵 New Payment Request' },
      { view: 'mine', label: 'My Requests' },
      { view: 'sentback', label: '🔁 Sent Back' },
      { view: 'myapprovals', label: '✅ My Approvals' },
      { view: 'queue', label: 'Approval Queue' },
      { view: 'payments', label: '₹ Payments' }
    ];
    return [];
  }
  const TOP_TAB_DEFAULT_VIEW = { spend: 'mine', payment: 'payreq', budget: 'budget', contracts: 'contracts' };

  function render(container) {
    const user = MVOA.getUser();
    const myRequests = requestsCache.filter(r => r.RequestedBy === user.name);
    // Tab-count badge only reflects requests still actually in flight —
    // a fully Paid/Rejected/settled one showing "(N open)" reads as if it
    // still needs attention when it doesn't (see isRequestTerminal). The
    // My Requests LIST itself is unaffected — it still shows every
    // request, Paid ones included, same as before.
    const myRequestsActive = myRequests.filter(r => !isRequestTerminal(r));
    const mineCountsSpend = countNewOpen(myRequestsActive.filter(r => r.RequestType !== 'PaymentRequest'));
    const mineCountsPayment = countNewOpen(myRequestsActive.filter(r => r.RequestType === 'PaymentRequest'));
    const queueCardsSpend = queueCardsCache.filter(c => c.req.RequestType !== 'PaymentRequest');
    const queueCardsPayment = queueCardsCache.filter(c => c.req.RequestType === 'PaymentRequest');
    const queueCountsSpend = countNewOpen(queueCardsSpend.map(c => c.req));
    const queueCountsPayment = countNewOpen(queueCardsPayment.map(c => c.req));
    const paymentsCounts = countNewOpen(paymentsVisibleForCurrentUser());
    const expiringContracts = computeExpiringContracts();
    const countSuffix = (c) => (c.open || c.newCount) ? ` (${c.open} open${c.newCount ? ` · ${c.newCount} new` : ''})` : '';
    const pendingBudgetRevisionsCount = budgetRevisionsCache.filter(r => r.Status !== 'Applied').length;
    const countFor = (view) => {
      if (view === 'mine') return currentTopTab === 'spend' ? mineCountsSpend : mineCountsPayment;
      if (view === 'queue') return currentTopTab === 'spend' ? queueCountsSpend : queueCountsPayment;
      if (view === 'payments') return paymentsCounts;
      if (view === 'budgetrevisions') return { open: pendingBudgetRevisionsCount, newCount: 0 };
      return { open: 0, newCount: 0 };
    };

    const headerHtml = `
      ${expiringContracts.length ? `
        <div class="mvoa-list-item" style="border:1px solid #b3261e;margin-bottom:12px;">
          <p style="margin:0 0 8px;font-weight:600;color:#b3261e;">📄 Contract Expiring Soon</p>
          ${expiringContracts.map(c => `
            <p style="margin:2px 0;">${escapeHtml(c.Vendor)} — ${escapeHtml(c.Nature || c.Category)} — <strong>${c.daysLeft < 0 ? `Expired ${-c.daysLeft} day(s) ago` : `Due in ${c.daysLeft} day(s)`}</strong></p>
          `).join('')}
        </div>` : ''}
      <div class="mvoa-row" style="margin-bottom:6px;">
        <span></span>
        <span class="muted" style="font-size:0.85rem;">Logged in as: <strong>${escapeHtml(user.name)}</strong>${user.role ? ` (${escapeHtml(user.role)})` : ''}</span>
      </div>`;

    if (currentTopTab === 'home') {
      // Home screen — the 4 top-level buckets only. No back button here
      // by design (nothing to go back to); it appears once inside any
      // of these.
      container.innerHTML = `
        ${headerHtml}
        <div class="ops-tabs">
          <button data-toptab="spend" class="ops-tab-btn">📝 Spend Approval</button>
          <button data-toptab="payment" class="ops-tab-btn">💵 Payment Approval</button>
          <button data-toptab="budget" class="ops-tab-btn">📊 Budget</button>
          <button data-toptab="contracts" class="ops-tab-btn">📄 Contracts</button>
        </div>`;
      container.querySelectorAll('.ops-tab-btn[data-toptab]').forEach(btn => {
        btn.addEventListener('click', () => {
          currentTopTab = btn.dataset.toptab;
          currentView = TOP_TAB_DEFAULT_VIEW[currentTopTab];
          if (currentTopTab === 'contracts') contractsSubView = 'list';
          render(container);
        });
      });
      return;
    }

    const subTabs = subTabsFor(currentTopTab);
    const groupLabel = currentTopTab === 'spend' ? '📝 Spend Approval' : currentTopTab === 'payment' ? '💵 Payment Approval' : currentTopTab === 'budget' ? '📊 Budget' : '📄 Contracts';
    const newNoteCount = currentTopTab === 'spend' ? myApprovalsNewNoteCounts.spend : myApprovalsNewNoteCounts.payment;
    const tabLabelHtml = (t) => t.view === 'myapprovals'
      ? `${t.label}${newNoteCount > 0 ? ` <span style="color:#b3261e;">(🆕 ${newNoteCount} new)</span>` : ''}`
      : `${t.label}${countSuffix(countFor(t.view))}`;
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="fin-back-btn" class="btn-secondary">← Back to Finance Application</button>
      </div>
      ${headerHtml}
      <p style="margin:0 0 8px;font-weight:600;color:var(--mvoa-blue);">${groupLabel}</p>
      <div class="ops-tabs">
        ${subTabs.map(t => `<button data-view="${t.view}" class="ops-tab-btn ${currentView===t.view?'active':''}">${tabLabelHtml(t)}</button>`).join('')}
        <button id="fin-refresh-btn" class="ops-tab-btn" title="Reload from sheet" style="margin-left:auto;">↻ Refresh</button>
      </div>
      <div id="fin-view-body"></div>
    `;
    container.querySelectorAll('.ops-tab-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentView = btn.dataset.view;
        render(container);
      });
    });
    container.querySelector('#fin-back-btn').addEventListener('click', () => { currentTopTab = 'home'; render(container); });
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
    else if (currentView === 'payreq') renderPaymentRequestForm(body, container);
    else if (currentView === 'myapprovals') renderMyApprovals(body, container, currentTopTab === 'spend' ? 'spend' : 'payment');
    else if (currentView === 'sentback') renderSentBack(body, container, currentTopTab === 'spend' ? 'spend' : 'payment');
    else if (currentView === 'queue') renderQueue(body, container, currentTopTab === 'spend' ? 'spend' : 'payment');
    else if (currentView === 'payments') renderPayments(body, container);
    else if (currentView === 'budget') renderBudgetStatus(body, container);
    else if (currentView === 'budgetrevisions') {
      const person = currentPerson();
      renderBudgetRevisionsSection(body, container, person, isTreasurerPerson(person) || isAdmin(person));
    }
    else if (currentView === 'contracts') { if (contractsSubView === 'form') renderContractForm(body, container); else renderContractsList(body, container); }
    else renderMine(body, container, currentTopTab === 'spend' ? 'spend' : currentTopTab === 'payment' ? 'payment' : null);
  }

  // ─── Budget Status — Category × FY: Total / Consumed / Available ─
  // Two write paths, both restricted to Treasurer/Admin:
  //   1. "Set Budget" — a category's TotalBudget is still 0 (never
  //      entered) → direct write, nothing to approve yet.
  //   2. "Revise" — a category already has a real budget → opens a
  //      proposal that needs Secretary + President + Treasurer to each
  //      individually approve (see renderBudgetRevisionsSection) before
  //      the Treasurer can apply it.
  function renderBudgetStatus(body, container) {
    const person = currentPerson();
    // Set Budget (first-time, ₹0 → real number, direct write) stays a
    // Treasurer/Admin action. Revise (already-set budget → approval
    // chain) is initiated by the Secretary/Admin instead — see
    // openReviseBudgetModal, which now also auto-records the Secretary's
    // own approval on submit.
    const canManageBudget = isTreasurerPerson(person) || isAdmin(person);
    const canInitiateRevision = isSecretaryPerson(person) || isAdmin(person);
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
      <p class="muted" style="margin-top:14px;font-size:0.85rem;">Pending budget revisions and their approvals are under <strong>📝 Spend Approval → 🔄 Budget Revisions</strong>.</p>
    `;
    function draw() {
      const fy = body.querySelector('#fin-budget-fy').value;
      const rows = budgetsCache.filter(b => b.FYYear === fy);
      const tableEl = body.querySelector('#fin-budget-table');
      if (!rows.length) { tableEl.innerHTML = `<p class="muted">No budget lines for ${escapeHtml(fy)}.</p>`; return; }
      const showActionCol = canManageBudget || canInitiateRevision;
      const totals = rows.reduce((acc, b) => {
        const info = budgetInfoFor(b.Category, fy);
        acc.total += info.total; acc.consumed += info.consumed; acc.available += info.available;
        return acc;
      }, { total: 0, consumed: 0, available: 0 });
      tableEl.innerHTML = `
        <table class="mvoa-table">
          <thead>
            <tr><th>Category</th><th>Total Budget</th><th>Consumed</th><th>Available</th>${showActionCol ? '<th></th>' : ''}</tr>
            <tr style="font-weight:700;background:var(--mvoa-blue-pale,#eef2f7);position:sticky;top:0;">
              <td>Total</td>
              <td>${formatAmount(totals.total)}</td>
              <td>${formatAmount(totals.consumed)}</td>
              <td style="color:${totals.available < 0 ? '#b3261e' : 'green'};">${formatAmount(totals.available)}</td>
              ${showActionCol ? '<td></td>' : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map(b => {
              const info = budgetInfoFor(b.Category, fy);
              const overBudget = info.available < 0;
              const isSet = (Number(b.TotalBudget) || 0) > 0;
              const canActOnRow = isSet ? canInitiateRevision : canManageBudget;
              return `<tr>
                <td>${escapeHtml(b.Category)}</td>
                <td>${formatAmount(info.total)}</td>
                <td>${formatAmount(info.consumed)}</td>
                <td style="color:${overBudget ? '#b3261e' : 'green'};font-weight:700;">${formatAmount(info.available)}</td>
                ${showActionCol ? `<td>${canActOnRow ? `<button class="btn-secondary fin-budget-action-btn" data-budget-id="${escapeHtml(b.BudgetID)}" data-fy="${escapeHtml(fy)}" style="font-size:0.75rem;padding:4px 10px;">${isSet ? '✏️ Revise' : '➕ Set Budget'}</button>` : ''}</td>` : ''}
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
      tableEl.querySelectorAll('.fin-budget-action-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const b = budgetsCache.find(x => x.BudgetID === btn.dataset.budgetId);
          if (!b) return;
          const isSet = (Number(b.TotalBudget) || 0) > 0;
          if (isSet) openReviseBudgetModal(b, btn.dataset.fy, container);
          else openSetBudgetModal(b, btn.dataset.fy, container);
        });
      });
    }
    body.querySelector('#fin-budget-fy').addEventListener('change', draw);
    draw();
  }

  // ─── Budget Input (first time) — direct write, no approval needed,
  // since nothing has been submitted for anyone to revise yet. ───
  function openSetBudgetModal(budgetRow, fy, container) {
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box" style="text-align:left;">
        <h3 style="margin-top:0;">Set Budget — ${escapeHtml(budgetRow.Category)}</h3>
        <p class="muted" style="margin-top:0;">Financial Year ${escapeHtml(fy)}</p>
        <label>Total Budget (₹) <input id="fin-setb-amount" type="number" min="0" step="1" value="${Number(budgetRow.TotalBudget) || ''}"></label>
        <label>Notes (optional) <input id="fin-setb-notes" type="text" value="${escapeHtml(budgetRow.Notes || '')}"></label>
        <p class="error-text" id="fin-setb-error" style="display:none;"></p>
        <div class="mvoa-row" style="margin-top:14px;justify-content:flex-end;gap:8px;">
          <button id="fin-setb-cancel" class="btn-secondary">Cancel</button>
          <button id="fin-setb-save" class="btn-primary">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#fin-setb-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#fin-setb-save').addEventListener('click', async () => {
      const errEl = modal.querySelector('#fin-setb-error');
      const amount = Number(modal.querySelector('#fin-setb-amount').value);
      if (!amount || amount <= 0) { errEl.textContent = 'Enter a budget amount greater than 0.'; errEl.style.display = 'block'; return; }
      const notes = modal.querySelector('#fin-setb-notes').value.trim();
      const btn = modal.querySelector('#fin-setb-save');
      setBtnBusy(btn, 'Saving…');
      try {
        const updated = Object.assign({}, budgetRow, { TotalBudget: amount, Notes: notes });
        await MVOA.sheetsUpdateRow(TAB_BUDGETS, budgetRow.rowNumber, objToRow(BUDGET_COLS, updated));
        await loadAll(true);
        modal.remove();
        render(container);
      } catch (e) {
        errEl.textContent = 'Failed: ' + e.message; errEl.style.display = 'block';
        clearBtnBusy(btn, 'Save');
      }
    });
  }

  // ─── Revise Budget (already set) — creates a proposal. Restricted to
  // Secretary/Admin to INITIATE. The Secretary's act of initiating IS
  // their approval (recorded automatically below as the 'Secretary'
  // stage row) — only President and Treasurer approve after that. The
  // remaining approvals are each gated by role in
  // renderBudgetRevisionsSection below. ───
  function openReviseBudgetModal(budgetRow, fy, container) {
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box" style="text-align:left;">
        <h3 style="margin-top:0;">Revise Budget — ${escapeHtml(budgetRow.Category)}</h3>
        <p class="muted" style="margin-top:0;">Financial Year ${escapeHtml(fy)} · Current: ${formatAmount(budgetRow.TotalBudget)}</p>
        <label>Proposed Total Budget (₹) <input id="fin-revb-amount" type="number" min="0" step="1"></label>
        <label>Reason for revision <input id="fin-revb-notes" type="text" placeholder="e.g. AGM-approved mid-year increase"></label>
        <p class="muted" style="font-size:0.8rem;">Submitting this records your Secretary sign-off automatically. It then needs the President AND Treasurer to approve before it can be applied.</p>
        <p class="error-text" id="fin-revb-error" style="display:none;"></p>
        <div class="mvoa-row" style="margin-top:14px;justify-content:flex-end;gap:8px;">
          <button id="fin-revb-cancel" class="btn-secondary">Cancel</button>
          <button id="fin-revb-submit" class="btn-primary">Submit for Approval</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#fin-revb-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#fin-revb-submit').addEventListener('click', async () => {
      const errEl = modal.querySelector('#fin-revb-error');
      const amount = Number(modal.querySelector('#fin-revb-amount').value);
      if (!amount || amount <= 0) { errEl.textContent = 'Enter a proposed amount greater than 0.'; errEl.style.display = 'block'; return; }
      if (amount === (Number(budgetRow.TotalBudget) || 0)) { errEl.textContent = 'Proposed amount is the same as the current budget.'; errEl.style.display = 'block'; return; }
      const notes = modal.querySelector('#fin-revb-notes').value.trim();
      const btn = modal.querySelector('#fin-revb-submit');
      setBtnBusy(btn, 'Submitting…');
      try {
        const user = MVOA.getUser();
        const existingIds = budgetRevisionsCache.map(r => r.RevisionID);
        const revisionId = MVOA.nextId('BREV', existingIds);
        const now = new Date().toISOString();
        const row = {
          RevisionID: revisionId, Category: budgetRow.Category, FYYear: fy,
          CurrentBudget: Number(budgetRow.TotalBudget) || 0, ProposedBudget: amount,
          Notes: notes, RequestedBy: user.name, RequestedDate: now,
          Status: 'PendingApproval', AppliedDate: '', AppliedBy: ''
        };
        await MVOA.sheetsAppend(TAB_BUDGET_REVISIONS, objToRow(BUDGET_REVISION_COLS, row));
        // The Secretary's initiation IS their approval — record it now so
        // the chain opens straight to President, no separate self-approve
        // click needed.
        const approvalRows = await MVOA.sheetsRead(TAB_BUDGET_APPROVALS).catch(() => []);
        const existingApprovalIds = approvalRows.slice(1).map(r => r[0]);
        const approvalRow = {
          ApprovalID: MVOA.nextId('BAPR', existingApprovalIds), RequestID: revisionId, ApproverName: user.name,
          ApproverRole: user.role || '', Stage: 'Secretary', Decision: 'Approved', Comment: '', Timestamp: now
        };
        await MVOA.sheetsAppend(TAB_BUDGET_APPROVALS, objToRow(APPROVAL_COLS, approvalRow));
        await loadAll(true);
        modal.remove();
        render(container);
      } catch (e) {
        errEl.textContent = 'Failed: ' + e.message; errEl.style.display = 'block';
        clearBtnBusy(btn, 'Submit for Approval');
      }
    });
  }

  // ─── Pending Budget Revisions — lives under Spend Approval (not
  // Budget) so the approval chain sits alongside the rest of the
  // approval work. The Secretary's stage is recorded automatically when
  // they initiate (see openReviseBudgetModal), so President and
  // Treasurer each approve their own remaining stage (role matched via
  // roleMatchesToken, same as the Schedule D payment chain); once both
  // are done, Treasurer/Admin gets an "Apply" button that writes
  // ProposedBudget into FinanceBudgets.
  async function renderBudgetRevisionsSection(el, container, person, canManageBudget) {
    const active = budgetRevisionsCache.filter(r => r.Status !== 'Applied');
    if (!active.length) { el.innerHTML = `<h3 style="margin:0 0 10px;color:var(--mvoa-blue);">🔄 Pending Budget Revisions</h3><p class="muted">No pending budget revisions.</p>`; return; }
    el.innerHTML = `<h3 style="margin:0 0 10px;color:var(--mvoa-blue);">🔄 Pending Budget Revisions</h3><p class="muted">Loading…</p>`;
    let allApprovals = [];
    try {
      const rows = await MVOA.sheetsRead(TAB_BUDGET_APPROVALS);
      allApprovals = rows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2));
    } catch (e) { /* FinanceBudgetApprovals tab not created yet, or a transient read error — render with no votes recorded rather than breaking the whole screen */ }
    // Element may have been replaced by a subsequent render() while this
    // async load was in flight (e.g. user switched tabs) — bail rather
    // than write into a detached node.
    if (!document.body.contains(el)) return;

    el.innerHTML = `<h3 style="margin:0 0 10px;color:var(--mvoa-blue);">🔄 Pending Budget Revisions</h3>` + active.map(rev => {
      const approvals = allApprovals.filter(a => a.RequestID === rev.RevisionID);
      const state = computeBudgetRevisionState(rev, approvals);
      const steps = BUDGET_REVISION_STAGE_ORDER.map(stage => ({
        stage, done: approvals.some(a => a.Stage === stage && a.Decision === 'Approved')
      }));
      const canActOnCurrentStage = !state.rejected && !state.fullyApproved && state.stage &&
        roleMatchesToken(person, BUDGET_REVISION_STAGE_ROLE_TOKEN[state.stage]);
      return `
        <div class="card" style="max-width:600px;margin:0 0 14px 0;">
          <div class="mvoa-row">
            <strong>${escapeHtml(rev.Category)} — FY ${escapeHtml(rev.FYYear)}</strong>
            ${state.rejected ? MVOA.statusBadgeHtml('Rejected') : state.fullyApproved ? MVOA.statusBadgeHtml('Approved') : MVOA.statusBadgeHtml('Pending')}
          </div>
          <p style="margin:6px 0;">${formatAmount(rev.CurrentBudget)} → <strong>${formatAmount(rev.ProposedBudget)}</strong></p>
          ${rev.Notes ? `<p class="muted" style="margin:0 0 6px;font-size:0.85rem;">${escapeHtml(rev.Notes)}</p>` : ''}
          <p class="muted" style="margin:0 0 8px;font-size:0.75rem;">Requested by ${escapeHtml(rev.RequestedBy)} · ${formatDate(rev.RequestedDate)}</p>
          <div class="mvoa-row" style="gap:14px;flex-wrap:wrap;margin-bottom:8px;">
            ${steps.map(s => `<span style="font-size:0.8rem;">${s.done ? '✅' : '⬜️'} ${escapeHtml(s.stage)}</span>`).join('')}
          </div>
          ${canActOnCurrentStage ? `
            <div class="mvoa-row" style="gap:8px;">
              <button class="btn-primary fin-budrev-approve" data-revision-id="${escapeHtml(rev.RevisionID)}" data-stage="${state.stage}">✅ Approve (${escapeHtml(state.stage)})</button>
              <button class="btn-secondary fin-budrev-reject" data-revision-id="${escapeHtml(rev.RevisionID)}" data-stage="${state.stage}">✕ Reject</button>
            </div>
          ` : ''}
          ${state.fullyApproved && canManageBudget ? `<button class="btn-primary fin-budrev-apply" data-revision-id="${escapeHtml(rev.RevisionID)}" style="margin-top:6px;">💾 Apply Revised Budget</button>` : ''}
          <p class="fin-budrev-error error-text" data-revision-id="${escapeHtml(rev.RevisionID)}" style="display:none;"></p>
        </div>
      `;
    }).join('');

    el.querySelectorAll('.fin-budrev-approve, .fin-budrev-reject').forEach(btn => {
      const decision = btn.classList.contains('fin-budrev-approve') ? 'Approved' : 'Rejected';
      btn.addEventListener('click', () => runOnce(btn, decision === 'Approved' ? 'Approving…' : 'Rejecting…',
        () => decideBudgetRevision(btn.dataset.revisionId, btn.dataset.stage, decision, container)));
    });
    el.querySelectorAll('.fin-budrev-apply').forEach(btn => {
      btn.addEventListener('click', () => runOnce(btn, 'Applying…', () => applyBudgetRevision(btn.dataset.revisionId, container)));
    });
  }

  async function decideBudgetRevision(revisionId, stage, decision, container) {
    const errEl = document.querySelector(`.fin-budrev-error[data-revision-id="${revisionId}"]`);
    try {
      const user = MVOA.getUser();
      const approvalRows = await MVOA.sheetsRead(TAB_BUDGET_APPROVALS, true);
      const existingIds = approvalRows.slice(1).map(r => r[0]);
      const approvalId = MVOA.nextId('BAPR', existingIds);
      const row = {
        ApprovalID: approvalId, RequestID: revisionId, ApproverName: user.name, ApproverRole: user.role || '',
        Stage: stage, Decision: decision, Comment: '', Timestamp: new Date().toISOString()
      };
      await MVOA.sheetsAppend(TAB_BUDGET_APPROVALS, objToRow(APPROVAL_COLS, row));
      await loadAll(true);
      render(container);
    } catch (e) {
      if (errEl) { errEl.textContent = 'Failed: ' + e.message; errEl.style.display = 'block'; }
    }
  }

  async function applyBudgetRevision(revisionId, container) {
    const errEl = document.querySelector(`.fin-budrev-error[data-revision-id="${revisionId}"]`);
    try {
      const rev = budgetRevisionsCache.find(r => r.RevisionID === revisionId);
      if (!rev) return;
      const budgetRow = budgetsCache.find(b => b.Category === rev.Category && b.FYYear === rev.FYYear);
      if (!budgetRow) { if (errEl) { errEl.textContent = `No matching FinanceBudgets row found for ${rev.Category} / ${rev.FYYear}.`; errEl.style.display = 'block'; } return; }
      const user = MVOA.getUser();
      const updatedBudget = Object.assign({}, budgetRow, { TotalBudget: Number(rev.ProposedBudget) || 0 });
      await MVOA.sheetsUpdateRow(TAB_BUDGETS, budgetRow.rowNumber, objToRow(BUDGET_COLS, updatedBudget));
      const updatedRev = Object.assign({}, rev, { Status: 'Applied', AppliedDate: new Date().toISOString(), AppliedBy: user.name });
      await MVOA.sheetsUpdateRow(TAB_BUDGET_REVISIONS, rev.rowNumber, objToRow(BUDGET_REVISION_COLS, updatedRev));
      await loadAll(true);
      render(container);
    } catch (e) {
      if (errEl) { errEl.textContent = 'Failed: ' + e.message; errEl.style.display = 'block'; }
    }
  }

  // ─── Contracts registry — list + one form used for BOTH registering a
  // brand-new agreement going forward AND backfilling an existing one.
  // Same form either way; the only difference is whether ApprovedRequestID
  // gets pre-filled (a fresh Schedule B/C approval) or left blank (a
  // legacy agreement that predates the app). ───────────────────────
  let contractsSubView = 'list'; // 'list' | 'form'
  let contractFormPrefill = null;

  function renderContractsList(body, container) {
    contractsSubView = 'list';
    const rows = contractsCache.slice().sort((a, b) => (a.Vendor || '').localeCompare(b.Vendor || ''));
    body.innerHTML = `
      <div style="margin-bottom:12px;">
        <button id="fin-add-contract-btn" class="btn-primary">+ Add Contract</button>
      </div>
      ${rows.length ? `<div id="fin-contracts-table"></div>` : `<p class="muted">No contracts registered yet. Use "+ Add Contract" to register a new agreement, or backfill your existing ones (AMC contracts, utility accounts, insurance policies).</p>`}
    `;
    body.querySelector('#fin-add-contract-btn').addEventListener('click', () => {
      contractFormPrefill = null;
      contractsSubView = 'form';
      renderContractForm(body, container);
    });
    if (rows.length) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      body.querySelector('#fin-contracts-table').innerHTML = `
        <table class="mvoa-table">
          <thead><tr><th>Vendor</th><th>Category</th><th>Nature</th><th>Valid To</th><th>Status</th></tr></thead>
          <tbody>
            ${rows.map(c => {
              const expired = c.EndDate && new Date(c.EndDate) < today;
              const terminated = String(c.Status).toLowerCase() === 'terminated';
              return `<tr>
                <td>${escapeHtml(c.Vendor)}</td>
                <td>${escapeHtml(c.Category)}</td>
                <td>${escapeHtml(c.Nature)}</td>
                <td>${c.EndDate ? escapeHtml(c.EndDate) : 'Open-ended'}</td>
                <td style="color:${(expired || terminated) ? '#b3261e' : 'green'};font-weight:600;">${terminated ? 'Terminated' : expired ? 'Expired' : 'Active'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    }
  }

  function renderContractForm(body, container) {
    contractsSubView = 'form';
    const p = contractFormPrefill || {};
    const categories = selectableCategories(); // same live list New Request already uses, from FinanceApprovalRules
    body.innerHTML = `
      <button id="fin-contract-back-btn" class="btn-secondary" style="margin-bottom:12px;">← Back to Contracts</button>
      <div class="card" style="max-width:560px;margin:0;">
        ${p.ApprovedRequestID ? `<p class="muted" style="margin:0 0 10px;">Registering the agreement just approved as ${escapeHtml(p.ApprovedRequestID)}.</p>` : ''}
        <label>Category
          <select id="fc-category">
            <option value="">— Select —</option>
            ${categories.map(c => `<option value="${escapeHtml(c)}" ${c === p.Category ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </label>
        <label>Vendor <input id="fc-vendor" type="text" value="${escapeHtml(p.Vendor || '')}"></label>
        <label>Vendor Details <input id="fc-vendordetails" type="text" placeholder="Phone, contact person, account/consumer no. etc."></label>
        <label>Nature of Contract <input id="fc-nature" type="text" placeholder="e.g. Annual AMC - DG Set"></label>
        <label>PO / Work Order Number <input id="fc-po" type="text"></label>
        <label>Policy Number <input id="fc-policy" type="text" placeholder="For Insurance — leave blank otherwise"></label>
        <label>Start Date <input id="fc-start" type="date"></label>
        <label>End Date <input id="fc-end" type="date"></label>
        <p class="muted" style="margin:-8px 0 10px;">Leave End Date blank for an open-ended commitment (e.g. an ongoing utility account with no fixed expiry) — it will never be flagged as expiring.</p>
        <label>Status
          <select id="fc-status">
            <option value="Active">Active</option>
            <option value="Terminated">Terminated</option>
          </select>
        </label>
        <label>Notes <textarea id="fc-notes" rows="2"></textarea></label>
        <button id="fc-submit-btn" class="btn-primary">Save Contract</button>
        <p class="error-text" id="fc-form-error"></p>
      </div>
    `;
    body.querySelector('#fin-contract-back-btn').addEventListener('click', () => renderContractsList(body, container));
    body.querySelector('#fc-submit-btn').addEventListener('click', () => submitContract(body, container, p.ApprovedRequestID || ''));
  }

  let isContractSubmitting = false;
  async function submitContract(body, container, approvedRequestId) {
    if (isContractSubmitting) return;
    isContractSubmitting = true;
    try { await doSubmitContract(body, container, approvedRequestId); }
    finally { isContractSubmitting = false; }
  }

  async function doSubmitContract(body, container, approvedRequestId) {
    const submitBtn = body.querySelector('#fc-submit-btn');
    const errEl = body.querySelector('#fc-form-error');
    errEl.textContent = '';
    const val = id => body.querySelector(id).value.trim();
    const category = val('#fc-category');
    const vendor = val('#fc-vendor');
    if (!category) { errEl.textContent = 'Please select a Category.'; return; }
    if (!vendor) { errEl.textContent = 'Please enter a Vendor.'; return; }

    setBtnBusy(submitBtn, 'Saving…');

    const existingIds = contractsCache.map(c => c.ContractID);
    const contractId = MVOA.nextId('AGR', existingIds);
    const row = {
      ContractID: contractId, Category: category, Vendor: vendor,
      VendorDetails: val('#fc-vendordetails'), Nature: val('#fc-nature'),
      PO_WO_Number: val('#fc-po'), PolicyNumber: val('#fc-policy'),
      StartDate: val('#fc-start'), EndDate: val('#fc-end'),
      Status: val('#fc-status') || 'Active', ApprovedRequestID: approvedRequestId || '',
      Notes: val('#fc-notes')
    };

    try {
      await MVOA.sheetsEnsureTab(TAB_CONTRACTS, CONTRACT_COLS);
      await MVOA.sheetsAppend(TAB_CONTRACTS, objToRow(CONTRACT_COLS, row));
    } catch (e) {
      errEl.textContent = 'Could not save contract: ' + e.message;
      clearBtnBusy(submitBtn, 'Save Contract');
      return;
    }

    await loadAll(true);
    contractFormPrefill = null;
    renderContractsList(body, container);
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
  // runOnce() — shared "processing" guard for every submission button
  // in this module (approve/reject/send-back, submitting a new request,
  // Release Payment, Treasurer Approve/Send Back, Resubmit, etc.). Disables
  // the clicked button immediately (so a fast double-click or a slow
  // network round-trip can't submit the same action twice) and swaps its
  // label for a small spinning graphic + busy text, so it's visually
  // obvious the app is working rather than looking like the click didn't
  // register. Only re-enables the button if it's still attached to the
  // DOM and still disabled once the action settles — i.e. only on
  // failure; a successful action normally re-renders and replaces this
  // exact button node, so there's nothing left to re-enable.
  let finSpinnerStyleInjected = false;
  function ensureSpinnerStyle() {
    if (finSpinnerStyleInjected || document.getElementById('fin-spinner-style')) { finSpinnerStyleInjected = true; return; }
    const style = document.createElement('style');
    style.id = 'fin-spinner-style';
    style.textContent = `
      @keyframes finSpin { to { transform: rotate(360deg); } }
      .fin-btn-spinner {
        display:inline-block; width:0.85em; height:0.85em; margin-right:7px;
        border:2px solid rgba(255,255,255,0.45); border-top-color:#fff;
        border-radius:50%; animation:finSpin 0.6s linear infinite;
        vertical-align:-0.15em;
      }
      .fin-btn-spinner.fin-spinner-dark {
        border-color:rgba(0,0,0,0.25); border-top-color:rgba(0,0,0,0.75);
      }
    `;
    document.head.appendChild(style);
    finSpinnerStyleInjected = true;
  }
  function runOnce(btn, busyText, action) {
    if (!btn || btn.disabled) return; // already in flight — ignore a redundant click
    ensureSpinnerStyle();
    const original = btn.innerHTML;
    const dark = btn.classList.contains('btn-secondary');
    btn.disabled = true;
    btn.innerHTML = `<span class="fin-btn-spinner${dark ? ' fin-spinner-dark' : ''}"></span>${escapeHtml(busyText)}`;
    const reset = () => { if (document.body.contains(btn) && btn.disabled) { btn.disabled = false; btn.innerHTML = original; } };
    try {
      Promise.resolve(action()).then(reset, reset);
    } catch (e) {
      reset();
    }
  }
  // For the handful of submit buttons that need their own validation
  // BEFORE going busy (so a bad input shows an error without ever
  // disabling the button) — same spinner/disable treatment as runOnce,
  // just split into two calls instead of wrapping the whole action.
  function setBtnBusy(btn, busyText) {
    if (!btn) return;
    ensureSpinnerStyle();
    if (btn.dataset.finOriginal === undefined) btn.dataset.finOriginal = btn.innerHTML;
    const dark = btn.classList.contains('btn-secondary');
    btn.disabled = true;
    btn.innerHTML = `<span class="fin-btn-spinner${dark ? ' fin-spinner-dark' : ''}"></span>${escapeHtml(busyText)}`;
  }
  function clearBtnBusy(btn, fallbackText) {
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = btn.dataset.finOriginal !== undefined ? btn.dataset.finOriginal : escapeHtml(fallbackText || '');
    delete btn.dataset.finOriginal;
  }

  // ───────────────────────────────────────────────────────────
  // Rule resolution — turns (category, budgetStatus, amount) into
  // the applicable FinanceApprovalRules row, data-driven from the
  // DoFA matrix rather than hardcoded thresholds.
  // ───────────────────────────────────────────────────────────
  function selectableCategories() {
    return [...new Set(rulesCache.filter(r => r.RuleID !== 'R03').map(r => r.ExpenseCategory))].sort((a, b) => a.localeCompare(b));
  }

  function budgetStatusOptionsFor(category) {
    const opts = [...new Set(rulesCache.filter(r => r.ExpenseCategory === category && r.RuleID !== 'R03').map(r => r.BudgetStatus))];
    const real = opts.filter(o => o === 'Budgeted' || o === 'Unbudgeted');
    return real.length > 1 ? real.sort((a, b) => a.localeCompare(b)) : null; // null = no selector needed, rule doesn't branch on budget status
  }

  // Bug found in testing: a category whose rule never branches into
  // Budgeted/Unbudgeted tiers (budgetStatusOptionsFor returns null, so no
  // selector is shown — true of most categories: AMCs, utilities,
  // Security Services, Garbage/Sewage/Pool, Water Tanker Supply,
  // Miscellaneous, etc.) was having its submitted requests saved with
  // BudgetStatus '' (blank) rather than 'Budgeted'. Since budgetInfoFor's
  // Consumed sum only counts rows tagged exactly 'Budgeted', this meant
  // every one of those categories silently never accumulated consumption
  // against their real FinanceBudgets line, and the New Request form's
  // "Budget Available" preview never showed at all for them (it gates on
  // the same 'Budgeted' tag) — even though a budget line genuinely
  // exists for almost all of them. A blank BudgetStatus on a single-tier
  // rule was never meant to mean "don't track this against budget" — it
  // just means the category never needed a Budgeted/Unbudgeted CHOICE.
  // Only a rule explicitly tagged 'Unbudgeted' (no matching 'Budgeted'
  // tier at all — rare, but keeps a true one-off Unbudgeted-only category
  // correctly excluded) opts out; anything else defaults to 'Budgeted'.
  function effectiveBudgetStatus(selectorValue, rule) {
    if (selectorValue) return selectorValue; // an explicit dual-tier choice always wins
    return (rule && rule.BudgetStatus === 'Unbudgeted') ? '' : 'Budgeted';
  }

  function resolveRule(category, budgetStatus, amount, pettyCashType) {
    const amt = Number(amount) || 0;
    const candidates = rulesCache.filter(r =>
      r.ExpenseCategory === category && r.RuleID !== 'R03' &&
      (!budgetStatus || !r.BudgetStatus || r.BudgetStatus === budgetStatus || r.BudgetStatus.indexOf('/') !== -1) &&
      // Petty Cash rows carry a PettyCashType (Expense/Replenishment); every
      // other category leaves it blank, so this filter is a no-op for them.
      (!r.PettyCashType || r.PettyCashType === pettyCashType)
    );
    const match = candidates.find(r => {
      const min = Number(r.MinAmount) || 0;
      const max = (r.MaxAmount === '' || r.MaxAmount === null || r.MaxAmount === undefined) ? Infinity : Number(r.MaxAmount);
      return amt >= min && amt <= max;
    });
    if (match) return { blocked: false, rule: match };

    // Petty Cash Expense over the float ceiling is explicitly blocked (R03)
    if (category === 'Petty Cash' && pettyCashType === 'Expense') {
      const blockRule = rulesCache.find(r => r.RuleID === 'R03');
      if (blockRule && amt >= (Number(blockRule.MinAmount) || 0)) {
        return { blocked: true, message: blockRule.Notes };
      }
    }
    // No rule covers this amount. If this category HAS rules but none of
    // their ranges reach this high, that's a real ceiling — tell the
    // requester plainly instead of silently doing nothing (previously this
    // fell through to a generic "enter an amount" message with no
    // indication anything was wrong).
    if (candidates.length) {
      const highestMax = candidates.reduce((max, r) => {
        const m = (r.MaxAmount === '' || r.MaxAmount === null || r.MaxAmount === undefined) ? Infinity : Number(r.MaxAmount);
        return m > max ? m : max;
      }, -Infinity);
      if (highestMax !== Infinity && amt > highestMax) {
        return {
          blocked: true,
          message: `This amount (${formatAmount(amt)}) exceeds the maximum this app can route for "${category}" (up to ${formatAmount(highestMax)}). It needs EC/AGM-level approval outside this workflow — contact your Secretary or Treasurer.`
        };
      }
    }
    return { blocked: false, rule: null };
  }

  // Purchase Requisition's Procurement Method implies its own minimum
  // number of quotation documents (independent of whatever the DoFA
  // Matrix's MinimumDocs column separately requires) — e.g. "Three
  // Quotations" means 3 quotes need to be attached, not just 1 generic
  // "Rationale" file.
  function quotationCountFor(method) {
    return { 'One Quotation': 1, 'Two Quotations': 2, 'Three Quotations': 3 }[method] || 0;
  }

  function requiredDocsList(rule) {
    if (!rule || !rule.MinimumDocs) return [];
    return rule.MinimumDocs.split('+').map(s => s.trim()).filter(Boolean);
  }
  // A written justification (e.g. "FM Justification", "Emergency
  // Justification Note") is content, not a document that needs scanning
  // and uploading — the requester can just type it in the Description
  // field. Only treated this way when it's the SOLE requirement; if it's
  // combined with something else (a quote, a comparative statement),
  // that other item still needs a real attachment.
  function isJustificationOnly(docs) {
    // Only a PURE justification requirement qualifies — "FM Justification"
    // or "Emergency Justification Note" write straight into Description.
    // A doc like "Quote / Justification" (R02) mentions justification too,
    // but the "/" pairs it with something that genuinely needs attaching —
    // bug found in testing: this used to match on "justification" alone
    // and silently skipped the required quote attachment.
    return docs.length === 1 && /justification/i.test(docs[0]) &&
      !/quote|invoice|comparative|purchase request|rationale|receipt/i.test(docs[0]);
  }
  // Petty Cash Replenishment's requirement ("Original Documents Submitted
  // to Accountant") isn't a file to attach OR text to type — it's a
  // physical hand-off that already happened outside the app (the soft
  // copies are already on file from when each expense was logged). The
  // requester just confirms it via checkbox.
  function isDocsConfirmationOnly(docs) {
    return docs.length === 1 && /original documents submitted/i.test(docs[0]);
  }

  // ───────────────────────────────────────────────────────────
  // Petty Cash Float — live balance, never stored. Expense requests
  // deduct once Approved (no disbursement step — the FM already paid
  // from the float); Replenishment requests add back only once actually
  // paid out (DisbursementStage === 'Paid'), since that's when real cash
  // re-enters the float.
  // ───────────────────────────────────────────────────────────
  const PETTY_CASH_FLOAT_TARGET = 15000;
  const PETTY_CASH_OPERATIONAL_MIN = 2000;
  const PETTY_CASH_REPLENISHMENT_PAYMENT_TYPE = 'Petty Cash Replenishment';
  // Matches a Replenishment either the OLD way (Category='Petty Cash',
  // PettyCashType='Replenishment' — pre-existing rows from before this
  // moved into Payment Requests) or the NEW way (a genuine Payment
  // Request with Category === the Payment Type string above). Both need
  // recognizing everywhere the float logic looks for one, so nothing
  // about already-submitted requests breaks.
  function isReplenishmentRequest(r) {
    return (r.Category === 'Petty Cash' && r.PettyCashType === 'Replenishment') ||
      (r.RequestType === 'PaymentRequest' && r.Category === PETTY_CASH_REPLENISHMENT_PAYMENT_TYPE);
  }
  function computeFloatBalance() {
    const expenseSum = requestsCache
      .filter(r => r.Category === 'Petty Cash' && r.PettyCashType === 'Expense' && r.Status === 'Approved')
      .reduce((sum, r) => sum + (Number(r.Amount) || 0), 0);
    const replenishedSum = requestsCache
      .filter(r => isReplenishmentRequest(r) && r.Status === 'Approved' && r.DisbursementStage === 'Paid')
      .reduce((sum, r) => sum + (Number(r.Amount) || 0), 0);
    return PETTY_CASH_FLOAT_TARGET - expenseSum + replenishedSum;
  }
  // A Petty Cash Expense is fully settled the moment it's Approved — the
  // FM already paid it out of the float, so unlike every other category
  // it never enters the Payments/Disbursement pipeline. (Replenishment
  // requests DO go through Payments as normal — this only excludes
  // Expense.)
  function isPettyCashExpense(r) {
    return r.Category === 'Petty Cash' && r.PettyCashType === 'Expense';
  }
  // A request is fully "done" — nothing further will ever happen to it —
  // once it's Rejected, settled as a Petty Cash Expense, or has actually
  // been paid out (PaymentStatus/DisbursementStage both get set to 'Paid'
  // together, see releasePayment — checking either is belt-and-braces).
  // Used to keep "done" items out of the "N open" tab-count badges (see
  // countNewOpen) — being fully resolved is a different thing from being
  // "not new", and conflating the two made completed/Paid requests read
  // as if they still needed attention.
  function isRequestTerminal(r) {
    if (r.Status === 'Rejected') return true;
    if (r.Status !== 'Approved') return false;
    if (isPettyCashExpense(r)) return true;
    return r.DisbursementStage === 'Paid' || r.PaymentStatus === 'Paid';
  }
  // An Approval-to-Spend (RequestType !== 'PaymentRequest') that has since
  // had a Payment Request created against it (LinkedSpendRequestID) is
  // superseded for disbursement purposes — the real expense-sheet entry
  // happens off that Payment Request's own lifecycle (with its own,
  // possibly different, actual amount) once THAT completes its approval
  // chain, not off the original spend approval's estimated amount.
  // Without this, the ATS itself — already Status:'Approved' the moment
  // its own chain finished, same as any other request — would
  // independently show up in the Accountant's "Log Expense Entry" queue
  // too, pre-filled with the original approved-to-spend amount rather
  // than the real payment amount, and easy to log against by mistake
  // instead of the actual linked Payment Request.
  function isSupersededByPaymentRequest(r) {
    return r.RequestType !== 'PaymentRequest' &&
      requestsCache.some(p => p.RequestType === 'PaymentRequest' && p.LinkedSpendRequestID === r.RequestID);
  }
  // Bug found in testing: nothing stopped a second Replenishment request
  // from being submitted while an earlier one was still in flight (not yet
  // Approved, or Approved but not yet actually Paid out) — so the float
  // could get "double-replenished" on paper, or simply confuse whoever's
  // tracking it, since the real cash top-up for the first request hadn't
  // arrived yet. Returns the existing in-flight Replenishment request, or
  // undefined if there isn't one.
  function inFlightReplenishment() {
    return requestsCache.find(r => isReplenishmentRequest(r) &&
      r.Status !== 'Rejected' && !(r.Status === 'Approved' && r.DisbursementStage === 'Paid'));
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
    // ADDED 27-Aug-2026: 'secretary'/'president' only ever matched via a
    // Title column that has never existed in the live Roles sheet, so
    // these two stages could never auto-skip self-approval. Now also
    // match the SECY/PRES role codes the user added to Shweta's and
    // Varsha's rows, mirroring the existing role-code fallback pattern
    // already used for 'treasurer' (tres) and 'operations head' (ops).
    if (t === 'secretary') return role === 'secy' || title.indexOf('secretary') !== -1;
    if (t === 'president') return role === 'pres' || title.indexOf('president') !== -1;
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
  // Bug found in testing: this didn't accept/pass a `force` param, unlike
  // loadAll() (fixed earlier this session for the exact same reason) — a
  // read immediately after appending a fresh Approval row (right below,
  // in decide()) could return a stale cached snapshot missing that very
  // row, so computeRequestState() would wrongly think the stage wasn't
  // done yet and Status never flipped to Approved even though the
  // approval genuinely went through. This is why two Petty Cash
  // Replenishments stayed stuck at PendingApproval despite their trail
  // correctly showing both stages Approved — a later, unrelated read (My
  // Requests, minutes afterward) no longer hit the stale window and
  // showed the truth, which is what made this look like a display bug
  // rather than a data one.
  async function loadApprovalsFor(requestId, force) {
    const rows = await MVOA.sheetsRead(TAB_APPROVALS, force);
    return rows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2))
      .filter(a => a.RequestID === requestId);
  }

  // Bug found in testing: every one of this file's three ApprovalID
  // generation sites (FM auto-approval on Payment Request submit,
  // decide(), resubmitRequest()) was calling MVOA.nextId('APR', [])
  // with a hardcoded EMPTY array instead of the sheet's real existing
  // IDs — meaning every single approval-log row ever written, across
  // every request and every stage, got assigned the exact same
  // ApprovalID. Harmless to read paths (nothing looks anything up by
  // ApprovalID), but a real data-integrity defect in FinanceApprovals
  // worth fixing outright. Centralized here so all three call the same
  // correct logic.
  async function nextApprovalId() {
    const rows = await MVOA.sheetsRead(TAB_APPROVALS, true);
    const existingIds = rows.slice(1).map(r => r[0]).filter(Boolean);
    return MVOA.nextId('APR', existingIds);
  }

  // ───────────────────────────────────────────────────────────
  // Generic stage-chain walker — replays every approval EVENT
  // (Approved / Rejected / SentBack) in chronological order against an
  // ordered list of stage definitions, so "Send Back" can move the
  // pointer backward by exactly one required stage (or to the
  // Initiator, before the first stage) — and if that stage later
  // approves again, walk forward again from there. This is what makes
  // cascading send-backs "one level at a time, however many times"
  // work correctly without a separate stored position field: position
  // is always fully re-derivable from the approvals log, same
  // philosophy as everything else in this module.
  // stageDefs: ordered array of { key, isDone(approvalsAtThisVisit) }.
  // Returns { position, rejected, fullyApproved, sentBackAt,
  // approvalsAtPosition } — position is a stage key, the literal
  // string 'Initiator', or null (only meaningful when
  // rejected/fullyApproved). sentBackAt is the most recent SentBack
  // event (kept for display even after later events at the SAME
  // position). approvalsAtPosition is whatever's accumulated at the
  // CURRENT stage since last arriving there (e.g. for EC quorum count).
  // ───────────────────────────────────────────────────────────
  function walkStageChain(stageDefs, approvals) {
    if (!stageDefs.length) return { position: null, rejected: false, fullyApproved: true, sentBackAt: null, approvalsAtPosition: [] };
    const sorted = approvals.slice().sort((a, b) => (a.Timestamp || '').localeCompare(b.Timestamp || ''));
    let idx = 0; // index into stageDefs; -1 = with Initiator; stageDefs.length = fully approved
    let rejected = false;
    let approvalsSinceEntry = [];
    let sentBackAt = null;
    for (const a of sorted) {
      if (rejected || idx >= stageDefs.length) continue;
      if (idx < 0) {
        // With the Initiator — only a Resubmitted event moves this forward again.
        if (a.Stage === 'Initiator' && a.Decision === 'Resubmitted') { idx = 0; approvalsSinceEntry = []; }
        continue;
      }
      const def = stageDefs[idx];
      if (a.Stage !== def.key) continue;
      if (a.Decision === 'Rejected') { rejected = true; continue; }
      if (a.Decision === 'SentBack') { sentBackAt = a; idx -= 1; approvalsSinceEntry = []; continue; }
      if (a.Decision === 'Approved') {
        approvalsSinceEntry.push(a);
        if (def.isDone(approvalsSinceEntry)) { idx += 1; approvalsSinceEntry = []; }
      }
    }
    if (rejected) return { position: null, rejected: true, fullyApproved: false, sentBackAt, approvalsAtPosition: [] };
    if (idx >= stageDefs.length) return { position: null, rejected: false, fullyApproved: true, sentBackAt, approvalsAtPosition: [] };
    if (idx < 0) return { position: 'Initiator', rejected: false, fullyApproved: false, sentBackAt, approvalsAtPosition: [] };
    return { position: stageDefs[idx].key, rejected: false, fullyApproved: false, sentBackAt, approvalsAtPosition: approvalsSinceEntry };
  }
  function approvalMatchesGroup(a, orGroup) {
    const person = rolesCache.find(p => p.Name === a.ApproverName) || { Role: a.ApproverRole, Title: a.ApproverRole };
    return personMatchesAndGroup(person, orGroup);
  }
  // Same lookup-with-fallback pattern as approvalMatchesGroup, for
  // membership checks (EC quorum) rather than role/title token matching.
  function personForApproval(a) {
    return rolesCache.find(p => p.Name === a.ApproverName) || { Role: a.ApproverRole, Title: a.ApproverRole, EC_Member: '' };
  }

  // REWRITTEN 27-Aug-2026 per explicit user instruction: "if those who
  // approve are already EC members then their approval should count in
  // quorum." Previously EC quorum only counted approvals cast SPECIFICALLY
  // while the request was already sitting at the EC stage — an EC
  // member's earlier Administrative or Financial approval (which happens
  // chronologically BEFORE the request ever reaches EC) didn't count at
  // all, so the same person effectively had to approve twice: once for
  // their real stage, once again for EC. Now ANY 'Approved' decision at
  // Administrative, Financial, OR EC, cast by someone who IS a CURRENT EC
  // member (checked live against rolesCache, same as everywhere else —
  // if their EC_Member flag changes later, this recomputes accordingly,
  // consistent with this module's "always re-derive from the log, never
  // snapshot" philosophy), counts as one of the distinct votes toward
  // quorum. This can't be expressed with the generic walkStageChain used
  // for every other chain in this file (Payment Request, Budget Revision)
  // — that walker only ever recognizes a stage's OWN Stage-tagged events,
  // and by the time the pointer reaches EC, earlier Administrative/
  // Financial events have already been consumed and are invisible to it.
  // So this keeps its own combined replay instead of delegating, but
  // preserves the exact same SentBack-cascades-one-level-at-a-time and
  // Reject-ends-it-immediately semantics walkStageChain has everywhere
  // else. walkStageChain itself is untouched — Payment Request and Budget
  // Revision chains still use it exactly as before.
  function ecQualifyingApproverCount(approvalsSoFar) {
    return new Set(
      approvalsSoFar
        .filter(a => a.Decision === 'Approved' && ['Administrative', 'Financial', 'EC'].includes(a.Stage))
        .filter(a => isEcMember(personForApproval(a)))
        .map(a => a.ApproverName)
    ).size;
  }
  function walkAtsStageChain(adminGroups, finGroups, ecRequired, agmRequired, quorum, approvals) {
    const stageKeys = [];
    if (adminGroups.length) stageKeys.push('Administrative');
    if (finGroups.length) stageKeys.push('Financial');
    if (ecRequired) stageKeys.push('EC');
    if (agmRequired) stageKeys.push('AGM');
    if (!stageKeys.length) return { position: null, rejected: false, fullyApproved: true, sentBackAt: null, ecCount: 0 };

    const sorted = approvals.slice().sort((a, b) => (a.Timestamp || '').localeCompare(b.Timestamp || ''));
    let idx = 0;
    let rejected = false;
    let approvalsSinceEntry = [];
    let sentBackAt = null;
    const approvalsSoFar = [];

    function isDoneAt(i, visit) {
      const key = stageKeys[i];
      if (key === 'Administrative') return adminGroups.every(g => visit.some(a => approvalMatchesGroup(a, g)));
      if (key === 'Financial') return finGroups.every(g => visit.some(a => approvalMatchesGroup(a, g)));
      if (key === 'EC') return ecQualifyingApproverCount(approvalsSoFar) >= quorum;
      if (key === 'AGM') return visit.length > 0;
      return false;
    }
    // Re-checked after EVERY processed event (not only ones matching the
    // current stage) — because EC's completion depends on the FULL
    // history so far, not just events tagged 'EC', a stage can already be
    // satisfied purely by carry-over the moment we arrive, with no
    // dedicated same-stage event required to trigger it. Harmless no-op
    // for Administrative/Financial/AGM, whose isDone only ever looks at
    // `visit` (the same as before this change).
    function tryAutoAdvance() {
      while (idx >= 0 && idx < stageKeys.length && isDoneAt(idx, approvalsSinceEntry)) {
        idx += 1; approvalsSinceEntry = [];
      }
    }
    tryAutoAdvance();

    for (const a of sorted) {
      if (rejected || idx >= stageKeys.length) continue;
      approvalsSoFar.push(a);
      if (idx < 0) {
        if (a.Stage === 'Initiator' && a.Decision === 'Resubmitted') { idx = 0; approvalsSinceEntry = []; tryAutoAdvance(); }
        continue;
      }
      const key = stageKeys[idx];
      if (a.Stage !== key) { tryAutoAdvance(); continue; }
      if (a.Decision === 'Rejected') { rejected = true; continue; }
      if (a.Decision === 'SentBack') { sentBackAt = a; idx -= 1; approvalsSinceEntry = []; tryAutoAdvance(); continue; }
      if (a.Decision === 'Approved') { approvalsSinceEntry.push(a); tryAutoAdvance(); }
    }

    const ecCount = ecQualifyingApproverCount(approvalsSoFar);
    if (rejected) return { position: null, rejected: true, fullyApproved: false, sentBackAt, ecCount };
    if (idx >= stageKeys.length) return { position: null, rejected: false, fullyApproved: true, sentBackAt, ecCount };
    if (idx < 0) return { position: 'Initiator', rejected: false, fullyApproved: false, sentBackAt, ecCount };
    return { position: stageKeys[idx], rejected: false, fullyApproved: false, sentBackAt, ecCount };
  }

  // Computes the current status of a request from its rule + approvals log.
  // Returns { stage, groups, ecCount, quorum, rejected, fullyApproved, sentBackAt }
  // stage may be 'Administrative' | 'Financial' | 'EC' | 'AGM' | 'Initiator' | null
  function computeRequestState(request, approvals) {
    const rule = rulesCache.find(r => r.RuleID === request.RuleID) || {};
    const adminGroups = parseApproverGroups(rule.AdministrativeApprover);
    const finGroups = parseApproverGroups(rule.FinancialApprover);
    const ecRequired = rule.ECApprovalRequired === 'Yes' || rule.ECApprovalRequired === 'Ratification';
    const agmRequired = rule.AGMApprovalRequired === 'Yes';
    const quorum = Number(request.QuorumRequired) || Number(rule.QuorumOverride) || DEFAULT_QUORUM;

    const result = walkAtsStageChain(adminGroups, finGroups, ecRequired, agmRequired, quorum, approvals);
    return {
      stage: result.position, groups: result.position === 'Administrative' ? adminGroups : result.position === 'Financial' ? finGroups : undefined,
      rejected: result.rejected, fullyApproved: result.fullyApproved,
      ecCount: result.position === 'EC' ? result.ecCount : 0, quorum, sentBackAt: result.sentBackAt
    };
  }

  // ───────────────────────────────────────────────────────────
  // Schedule D — Payment Request stage engine. Separate from
  // computeRequestState() above on purpose (see PAYMENT_RULE_COLS
  // comment) — walks a FIXED FM→OpsHead→Secretary→President→Treasurer
  // chain, skipping any stage this PaymentType doesn't require. No
  // amount tiers, no EC/AGM — Schedule D doesn't use either.
  // ───────────────────────────────────────────────────────────
  const PAYMENT_STAGE_ROLE_TOKEN = { FM: 'fm', OpsHead: 'operations head', Secretary: 'secretary', Treasurer: 'treasurer', President: 'president' };
  const PAYMENT_STAGE_REQUIRED_COL = { FM: 'FMRequired', OpsHead: 'OpsHeadRequired', Secretary: 'SecretaryRequired', Treasurer: 'TreasurerRequired', President: 'PresidentRequired' };
  const PAYMENT_STAGE_LABEL = { FM: 'FM Verification', OpsHead: 'Operations Head — Technical Acceptance', Secretary: 'Secretary — Admin Approval', Treasurer: 'Treasurer — Financial Approval', President: 'President Approval' };
  // REVISED 27-Aug-2026, per explicit user instruction: the workflow now
  // has TWO distinct Treasurer touchpoints, not one. After admin approval
  // (Secretary and/or President, whichever this PaymentType requires),
  // the request now goes to the Treasurer for approval HERE — a genuine
  // Approval Queue stage, same as FM/OpsHead/Secretary/President — before
  // the Accountant ever sees it. Only once that's approved does Status
  // become 'Approved' and the Accountant's "needs an Expense Sheet entry"
  // queue picks it up. The Accountant logs the entry → Treasurer reviews
  // and passes THAT expense sheet entry (the existing, separate
  // disbursement-pipeline touchpoint — see treasurerApprove()) → only
  // then does it move to the Disbursement Officer. So: admin approval →
  // Treasurer → Accountant → Treasurer → Disbursement Officer, exactly as
  // requested. (This reverses an earlier fix — see git history — that had
  // deliberately excluded Treasurer from this pre-approval walk to avoid
  // a double-approval; the user has now confirmed two touchpoints are
  // actually what's wanted.) 'Treasurer' is placed LAST in the order below
  // so it always follows Secretary/President rather than sitting between
  // them.
  const PAYMENT_PRE_APPROVAL_STAGES = ['FM', 'OpsHead', 'Secretary', 'President', 'Treasurer'];
  function paymentRuleFor(paymentType) {
    return paymentRulesCache.find(r => r.PaymentType === paymentType) || {};
  }
  // WCC (FIN-F-002) threshold — per Governance Note 5: mandatory for
  // Repairs & Maintenance / CAPEX works above ₹50,000 per expense, but
  // does NOT apply to procurement of GOODS (as opposed to works/
  // services) where delivery was verified via FIN-F-005 Goods Receipt /
  // Material Receipt instead. This needs its own logic rather than a
  // static MinimumDocs string, since the actual requirement depends on
  // amount AND on whether this is a goods purchase — both only known
  // once the person is filling out the form, not from the rule alone.
  const WCC_THRESHOLD = 50000;
  const WCC_PAYMENT_TYPES = ['Repairs & Maintenance Payments', 'Capital Expenditure (CAPEX) Payments'];
  function isWccPaymentType(paymentType) {
    return WCC_PAYMENT_TYPES.includes(paymentType);
  }
  function effectiveDocsForPayment(paymentType, amount, isGoodsProcurement) {
    if (!isWccPaymentType(paymentType)) return requiredDocsList(paymentRuleFor(paymentType));
    if (isGoodsProcurement) return ['FIN-F-005 Goods Receipt / Material Receipt', 'Vendor Invoice'];
    if ((Number(amount) || 0) > WCC_THRESHOLD) return ['WCC (FIN-F-002)', 'Vendor Invoice'];
    return ['Vendor Invoice'];
  }
  function computePaymentRequestState(request, approvals) {
    const rule = paymentRuleFor(request.Category);
    // 'Treasurer' is included in this pre-approval walk (as of 27-Aug-2026
    // — see PAYMENT_PRE_APPROVAL_STAGES comment above) as a genuine stage
    // this request must clear before Status becomes 'Approved', separate
    // from the Treasurer's later expense-sheet review in the disbursement
    // pipeline.
    const order = PAYMENT_PRE_APPROVAL_STAGES;
    const stageDefs = order.filter(k => rule[PAYMENT_STAGE_REQUIRED_COL[k]] === 'Yes')
      .map(k => ({ key: k, isDone: (visit) => visit.length > 0 }));
    const result = walkStageChain(stageDefs, approvals);
    return { stage: result.position, rejected: result.rejected, fullyApproved: result.fullyApproved, sentBackAt: result.sentBackAt };
  }

  // ───────────────────────────────────────────────────────────
  // Budget Revision stage engine — Secretary AND President AND Treasurer
  // must all individually approve (fixed order, none skippable) before
  // the Treasurer can apply the proposed value. Uses the same
  // walkStageChain() as every other approval chain here, so Reject /
  // re-propose behaves consistently with the rest of the app.
  // ───────────────────────────────────────────────────────────
  const BUDGET_REVISION_STAGE_ORDER = ['Secretary', 'President', 'Treasurer'];
  const BUDGET_REVISION_STAGE_ROLE_TOKEN = { Secretary: 'secretary', President: 'president', Treasurer: 'treasurer' };
  function computeBudgetRevisionState(revision, approvals) {
    const stageDefs = BUDGET_REVISION_STAGE_ORDER.map(k => ({ key: k, isDone: (visit) => visit.length > 0 }));
    const result = walkStageChain(stageDefs, approvals);
    return { stage: result.position, rejected: result.rejected, fullyApproved: result.fullyApproved };
  }
  // A Payment Request with NO required stages at all (shouldn't normally
  // happen — every real Schedule D row needs at least Treasurer — but
  // guards the same way the Schedule A/B/C zero-approver case does)
  function paymentHasNoApprovalStages(paymentType) {
    const rule = paymentRuleFor(paymentType);
    // TreasurerRequired is now included in this check (27-Aug-2026) — see
    // PAYMENT_PRE_APPROVAL_STAGES.
    return PAYMENT_PRE_APPROVAL_STAGES.map(k => PAYMENT_STAGE_REQUIRED_COL[k])
      .every(col => rule[col] !== 'Yes');
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
  // "Since when" — appended to every ongoing (non-final) stage badge so a
  // requester can see how long something's been sitting, not just where.
  // Uses StageEnteredAt (the moment it entered its CURRENT stage, not
  // when it was first submitted) since that's what actually answers
  // "how long has whoever's turn it is had this."
  function sinceText(request) {
    return request.StageEnteredAt ? ` — since ${formatDate(request.StageEnteredAt)}` : '';
  }

  function stageDescription(request, approvals) {
    if (request.Status === 'Rejected') return { text: 'Rejected', cls: 'rejected' };
    if (request.Status === 'PendingApproval') {
      if (request.RequestType === 'PaymentRequest') {
        const state = computePaymentRequestState(request, approvals);
        if (state.stage === 'Initiator') return { text: `🔁 Sent back to you${state.sentBackAt && state.sentBackAt.Comment ? ' — "' + escapeHtml(state.sentBackAt.Comment) + '"' : ''}${sinceText(request)}`, cls: 'rejected' };
        const label = { FM: 'FM Verification', OpsHead: 'Operations Head approval', Secretary: 'Secretary approval', Treasurer: 'Treasurer approval', President: 'President approval' };
        return { text: (state.stage ? `Awaiting ${label[state.stage]}` : 'Pending approval') + sinceText(request), cls: 'pending' };
      }
      const rule = rulesCache.find(r => r.RuleID === request.RuleID) || {};
      const state = computeRequestState(request, approvals);
      if (state.stage === 'Initiator') return { text: `🔁 Sent back to you${state.sentBackAt && state.sentBackAt.Comment ? ' — "' + escapeHtml(state.sentBackAt.Comment) + '"' : ''}${sinceText(request)}`, cls: 'rejected' };
      if (state.stage === 'Administrative') return { text: `Awaiting ${rule.AdministrativeApprover || 'Administrative'} approval${sinceText(request)}`, cls: 'pending' };
      if (state.stage === 'Financial') return { text: `Awaiting ${rule.FinancialApprover || 'Financial'} approval${sinceText(request)}`, cls: 'pending' };
      if (state.stage === 'EC') return { text: `Awaiting EC approval (${state.ecCount} of ${state.quorum})${sinceText(request)}`, cls: 'pending' };
      if (state.stage === 'AGM') return { text: `Awaiting AGM approval${sinceText(request)}`, cls: 'pending' };
      return { text: `Pending approval${sinceText(request)}`, cls: 'pending' };
    }
    // Petty Cash Expense is fully settled the moment it's Approved — no
    // Payments/Disbursement chain follows (already paid from the float).
    if (isPettyCashExpense(request)) return { text: 'Approved — adjusted against Petty Cash Float', cls: 'paid' };
    // An Approval-to-Spend that's been superseded by a linked Payment
    // Request (see isSupersededByPaymentRequest) never gets its OWN
    // DisbursementStage set — the actual expense-sheet entry and payout
    // happen off the Payment Request instead. Without this, the ATS's own
    // badge would sit at "awaiting Expense Sheet entry" forever, even
    // after the linked payment was fully disbursed — bug found in
    // testing (the ATS's detail view showed a stale "awaiting" badge
    // while its own Payment Release checklist correctly stayed all-
    // pending, since neither had actually moved for THIS record).
    if (isSupersededByPaymentRequest(request)) {
      const linked = requestsCache.filter(p => p.RequestType === 'PaymentRequest' && p.LinkedSpendRequestID === request.RequestID);
      const paid = linked.find(p => p.DisbursementStage === 'Paid');
      if (paid) return { text: `Paid via linked Payment Request ${paid.RequestID}${paid.PaymentRef ? ' (Ref: ' + paid.PaymentRef + ')' : ''}`, cls: 'paid' };
      const active = linked[0];
      // Bug found in testing: a linked Payment Request that hasn't even
      // finished ITS OWN pre-approval chain yet (Status still
      // 'PendingApproval' — FM/OpsHead/Secretary/President/Treasurer, per
      // PAYMENT_PRE_APPROVAL_STAGES) was still shown here as "Payment in
      // progress", which reads as active disbursement processing that
      // hasn't actually started (and may never — the Payment Request
      // could still be sent back or rejected). Only call it "in progress"
      // once that Payment Request is itself Approved.
      if (active.Status !== 'Approved') {
        return { text: `Linked Payment Request ${active.RequestID} submitted — awaiting its own approvals`, cls: 'pending' };
      }
      return { text: `Payment in progress — see linked Payment Request ${active.RequestID}`, cls: 'approved' };
    }
    // Status === 'Approved' — now in the Schedule D payment-release chain
    switch (request.DisbursementStage) {
      case 'PendingTreasurer': return { text: `Awaiting Treasurer review (payment release)${sinceText(request)}`, cls: 'approved' };
      case 'NeedsCorrection': return { text: `Sent back by Treasurer for correction — waiting on Accountant${sinceText(request)}`, cls: 'rejected' };
      case 'PendingPayment': return { text: `Treasurer approved — awaiting Disbursement Officer${sinceText(request)}`, cls: 'approved' };
      case 'Paid': return { text: 'Paid' + (request.PaymentRef ? ` (Ref: ${request.PaymentRef})` : ''), cls: 'paid' };
      default: return { text: `Approved — awaiting Expense Sheet entry (Accountant)${sinceText(request)}`, cls: 'approved' };
    }
  }
  function stageBadgeHtml(request, approvals) {
    const s = stageDescription(request, approvals);
    return statusBadge(s.text, s.cls);
  }

  // "🆕 New" indicator — compares each request's StageEnteredAt against
  // when THIS browser last opened the given tab (stored in localStorage).
  // Superseded by the shared StageOpenedAt mechanism below, which the
  // person explicitly asked for (New/Open state visible to everyone,
  // not per-browser) — kept only as unused history in case a per-browser
  // signal is ever wanted again for something else.

  // ───────────────────────────────────────────────────────────
  // New → Open tracking. Shared across everyone with access (stored on
  // the request row itself, not per-browser) — an item is "New" until
  // someone individually opens it, at which point it becomes "Open" for
  // everyone, permanently, until the request moves to its next stage
  // (which resets StageOpenedAt to blank again — see every StageEnteredAt
  // write site). Deliberately NOT triggered just by a tab rendering, since
  // that would mark everything "seen" in bulk the instant the tab opens —
  // the whole point is granular, one-at-a-time acknowledgement.
  // ───────────────────────────────────────────────────────────
  function isItemNew(request) {
    return !request.StageOpenedAt;
  }
  function countNewOpen(list) {
    return { open: list.filter(r => !isItemNew(r)).length, newCount: list.filter(isItemNew).length };
  }
  async function markStageOpened(requestId, container) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req || req.StageOpenedAt) return; // already opened, or not found — no-op
    const now = new Date().toISOString();
    req.StageOpenedAt = now; // optimistic local update so the UI responds instantly
    try {
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, req));
    } catch (e) {
      // Best-effort — if this write fails the item will just show as New
      // again on next full refresh, which is a safe direction to fail in.
    }
  }
  // Same shared-state philosophy as StageOpenedAt, kept as its own field
  // (see REQUEST_COLS comment) — the Notes thread's "new" flag. Marked
  // opened once anyone actually views the thread; reset to unread every
  // time a new note is appended (see the Add Note handler below).
  async function markNotesOpened(requestId) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req || req.NotesOpenedAt) return;
    const now = new Date().toISOString();
    req.NotesOpenedAt = now;
    try {
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, req));
    } catch (e) { /* best-effort, same as markStageOpened */ }
  }
  async function markNotesUnread(requestId) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req) return;
    req.NotesOpenedAt = '';
    try {
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, req));
    } catch (e) { /* best-effort */ }
  }
  // Shared across every card that shows a Notes button (My Requests,
  // Approval Queue, My Approvals) so the "new note" flag looks and
  // behaves identically everywhere.
  function hasUnreadNote(request, noteCount) {
    return noteCount > 0 && !request.NotesOpenedAt;
  }
  function notesButtonHtml(request, noteCount, btnClass, dataAttrs) {
    const flagged = hasUnreadNote(request, noteCount);
    return `<button class="${btnClass} btn-secondary" ${dataAttrs} style="font-size:0.8rem;padding:4px 10px;${flagged ? 'border-color:#b3261e;color:#b3261e;font-weight:600;' : ''}">${flagged ? '🆕' : '💬'} Notes${noteCount ? ` (${noteCount})` : ''}</button>`;
  }
  // A condensed, click-to-open card for a New item — shows just enough to
  // identify it plus the 🆕 badge; clicking it marks it Opened (shared,
  // permanent) and re-renders the tab so it now shows in full with its
  // real action buttons, and the nav-bar counts shift by one.
  function newItemCardHtml(req, summaryLine) {
    return `
      <div class="mvoa-list-item fin-new-item-card" data-request-id="${escapeHtml(req.RequestID)}" style="cursor:pointer;">
        <div class="mvoa-row">
          <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
          <span class="mvoa-badge" style="color:#8a4b00;background:#fff1de;">🆕 New — tap to open</span>
        </div>
        ${summaryLine || ''}
      </div>`;
  }
  function wireNewItemCards(scopeEl, onOpened) {
    scopeEl.querySelectorAll('.fin-new-item-card').forEach(el => {
      el.addEventListener('click', async () => {
        await markStageOpened(el.dataset.requestId);
        onOpened();
      });
    });
  }

  // ───────────────────────────────────────────────────────────
  // SUBMIT — Schedule D "New Payment Request" form. Separate from
  // renderSubmitForm() below (Schedule A/B/C spend requests) — this one
  // picks a Payment Type (not an amount-tiered Category), optionally
  // looks up an existing FinanceContracts row to pull in the vendor and
  // check it's still valid, and routes through the FM→OpsHead→Secretary
  // →Treasurer→President chain instead of Administrative/Financial/EC/AGM.
  // ───────────────────────────────────────────────────────────
  let paymentPendingAttachments = [];
  let selectedContractId = '';
  // The direct "Link to Approval to Spend" counterpart to selectedContractId
  // — mutually exclusive with it (picking one clears the other, see
  // refreshContractPicker/refreshSpendRequestPicker below): a Contract's
  // own ApprovedRequestID already carries the spend-approval reference, so
  // there's nothing meaningful about linking both at once.
  let selectedLinkedSpendRequestId = '';
  let sentBackPendingAttachments = {}; // { [requestId]: pendingAttachment[] } — see renderSentBack
  let paymentIsGoodsProcurement = false;

  // Which Schedule A/B/C spend Category(ies) a Payment Type is paid
  // against — see the SpendCategory column comment on PAYMENT_RULE_COLS.
  function spendCategoriesForPaymentType(paymentType) {
    const rule = paymentRuleFor(paymentType);
    return (rule.SpendCategory || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  // Approval-to-Spend requests eligible for the direct-link picker — any
  // Schedule A/B/C request (never a PaymentRequest itself) that's fully
  // Approved. Not narrowed to "not yet linked to a payment": an AMC or a
  // CAPEX approval can legitimately back more than one payment over its
  // life (installments, a multi-year AMC's several payment cycles), so
  // the same Approval-to-Spend has to stay pickable more than once.
  function eligibleSpendRequestsForLinking() {
    return requestsCache.filter(r => r.RequestType !== 'PaymentRequest' && r.Status === 'Approved')
      .sort((a, b) => (b.RequestedDate || '').localeCompare(a.RequestedDate || ''));
  }

  function renderPaymentRequestForm(body, container) {
    if (!paymentRulesCache.length) {
      body.innerHTML = `<p class="muted">Payment Requests aren't set up yet — add rows to the <strong>FinancePaymentRules</strong> sheet (one per Schedule D Payment Type) to enable this.</p>`;
      return;
    }
    const paymentTypes = [...new Set(paymentRulesCache.map(r => r.PaymentType))].sort((a, b) => a.localeCompare(b));
    body.innerHTML = `
      <div class="card" style="max-width:560px;margin:0;">
        <label>Payment Type
          <select id="pr-type">
            <option value="">— Select —</option>
            ${paymentTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
          </select>
        </label>
        <div id="pr-contract-wrap"></div>
        <div id="pr-spend-wrap"></div>
        <label>Amount (₹)
          <input id="pr-amount" type="number" min="0" step="1" placeholder="0" style="-moz-appearance:textfield;" onwheel="this.blur()">
        </label>
        <div id="pr-spend-amount-note"></div>
        <div id="pr-overage-justification-wrap"></div>
        <label id="pr-vendor-label">Vendor / Payee
          <input id="pr-vendor" type="text" placeholder="e.g. ABC Electricals">
        </label>
        <label>Description
          <textarea id="pr-desc" rows="2" placeholder="What is this payment for?"></textarea>
        </label>
        <div id="pr-wcc-wrap"></div>
        <div id="pr-rule-preview"></div>
        <div style="margin-top:12px;">
          <p class="muted" id="pr-attachments-label" style="margin:0 0 6px;">Attachments</p>
          <div id="pr-attachment-chips"></div>
          <div id="pr-attachment-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;"></div>
        </div>
        <button id="pr-submit-btn" class="btn-primary">Submit Payment Request</button>
        <p class="error-text" id="pr-form-error"></p>
      </div>
    `;
    paymentPendingAttachments = [];
    selectedContractId = '';
    selectedLinkedSpendRequestId = '';
    paymentIsGoodsProcurement = false;
    // Tracks whether the overage-justification textarea is currently on
    // screen — refreshPreview() only rebuilds it when this actually
    // changes (over → not-over or vice versa), never on every amount
    // keystroke, so whatever the requester has already typed into it
    // isn't wiped out mid-sentence by the next digit they type into
    // Amount. Reset fresh each time this form is (re)rendered.
    let overageJustificationVisible = false;
    renderDocAttachmentPicker(body, '#pr-attachment-chips', '#pr-attachment-btns', paymentPendingAttachments, [], 3);

    const typeEl = body.querySelector('#pr-type');
    const amtEl = body.querySelector('#pr-amount');
    const vendorEl = body.querySelector('#pr-vendor');
    const descEl = body.querySelector('#pr-desc');
    const contractWrap = body.querySelector('#pr-contract-wrap');
    const spendWrap = body.querySelector('#pr-spend-wrap');
    const previewEl = body.querySelector('#pr-rule-preview');
    const labelEl = body.querySelector('#pr-attachments-label');

    // Both pickers are filtered to the currently-selected Payment Type's
    // mapped spend Category(ies) (see SpendCategory) — so a payment filed
    // as "AMC Payments" simply can't be linked to a CAPEX-approved
    // Contract or Approval-to-Spend by mistake; the option never appears.
    // If SpendCategory hasn't been filled in yet for this Payment Type,
    // both fall back to showing everything unfiltered rather than
    // silently hiding the right option because of an incomplete mapping.
    function refreshContractPicker() {
      if (!contractsCache.length) { contractWrap.innerHTML = ''; return; }
      const type = typeEl.value;
      const mapped = type ? spendCategoriesForPaymentType(type) : [];
      // Falls back to showing everything whenever the filtered result
      // comes up EMPTY — not just when SpendCategory is blank. A typo'd
      // or not-yet-registered category would otherwise filter down to
      // zero options and silently look like "nothing to link" instead of
      // the mapping being wrong — better to show more than to hide
      // everything and let a real Contract go unlinked because of it.
      const filtered = mapped.length ? contractsCache.filter(c => mapped.includes(c.Category)) : [];
      const pool = filtered.length ? filtered : contractsCache;
      contractWrap.innerHTML = `
        <label>Link to an existing Contract (optional)
          <select id="pr-contract">
            <option value="">— None / enter vendor manually —</option>
            ${pool.slice().sort((a, b) => (a.Vendor || '').localeCompare(b.Vendor || '')).map(c => `<option value="${escapeHtml(c.ContractID)}" ${c.ContractID===selectedContractId?'selected':''}>${escapeHtml(c.Vendor)} — ${escapeHtml(c.Nature || c.Category)}${c.EndDate ? ' (valid to ' + escapeHtml(c.EndDate) + ')' : ' (open-ended)'}</option>`).join('')}
          </select>
        </label>
        ${type && !filtered.length ? `<p class="muted" style="margin:2px 0 6px;font-size:0.75rem;">Showing all contracts — ${mapped.length ? `none are registered under "${escapeHtml(mapped.join(', '))}" yet` : `no spend-category mapping set yet for "${escapeHtml(type)}"`} (FinancePaymentRules.SpendCategory).</p>` : ''}
        <div id="pr-contract-status"></div>`;
      const sel = contractWrap.querySelector('#pr-contract');
      const statusEl = contractWrap.querySelector('#pr-contract-status');
      sel.addEventListener('change', () => {
        selectedContractId = sel.value;
        const c = contractsCache.find(x => x.ContractID === selectedContractId);
        if (!c) { statusEl.innerHTML = ''; return; }
        // Mutually exclusive with the Approval-to-Spend picker below — a
        // Contract's own ApprovedRequestID already carries the spend-
        // approval reference, so linking both at once would be redundant.
        selectedLinkedSpendRequestId = '';
        refreshSpendRequestPicker();
        vendorEl.value = c.Vendor;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const expired = c.EndDate && new Date(c.EndDate) < today;
        const terminated = String(c.Status).toLowerCase() === 'terminated';
        statusEl.innerHTML = (expired || terminated) ? `
          <p class="error-text" style="margin:4px 0;">⚠️ This contract ${terminated ? 'is marked Terminated' : `expired on ${escapeHtml(c.EndDate)}`}. Per Schedule D, payment requires an approved commitment — check with the Secretary/Treasurer before proceeding, or renew the contract via New Request first.</p>
        ` : `<p class="muted" style="margin:4px 0;color:green;">✓ Contract valid${c.EndDate ? ' until ' + escapeHtml(c.EndDate) : ' (open-ended)'}.</p>`;
      });
    }

    // Direct counterpart to refreshContractPicker — for adhoc/one-off/
    // CAPEX/Miscellaneous payments that have a real Approval-to-Spend
    // behind them but never went through the Contracts registry (no
    // Work Order/AMC/agreement to point to instead).
    function refreshSpendRequestPicker() {
      const eligible = eligibleSpendRequestsForLinking();
      if (!eligible.length) { spendWrap.innerHTML = ''; return; }
      const type = typeEl.value;
      const mapped = type ? spendCategoriesForPaymentType(type) : [];
      // Same "never filter down to zero" fallback as refreshContractPicker.
      const filtered = mapped.length ? eligible.filter(r => mapped.includes(r.Category)) : [];
      const pool = filtered.length ? filtered : eligible;
      spendWrap.innerHTML = `
        <label>Link to an Approval to Spend (optional — for payments with no Contract/Work Order)
          <select id="pr-spend-request">
            <option value="">— None —</option>
            ${pool.map(r => `<option value="${escapeHtml(r.RequestID)}" ${r.RequestID===selectedLinkedSpendRequestId?'selected':''}>${escapeHtml(r.RequestID)} — ${escapeHtml(r.Category)} — ${escapeHtml(r.Vendor || '')} — ${formatAmount(r.Amount)} (${formatDate(r.RequestedDate)})</option>`).join('')}
          </select>
        </label>
        ${type && !filtered.length ? `<p class="muted" style="margin:2px 0 6px;font-size:0.75rem;">Showing all approved requests — ${mapped.length ? `none are approved under "${escapeHtml(mapped.join(', '))}" yet` : `no spend-category mapping set yet for "${escapeHtml(type)}"`} (FinancePaymentRules.SpendCategory).</p>` : ''}`;
      const sel = spendWrap.querySelector('#pr-spend-request');
      sel.addEventListener('change', () => {
        selectedLinkedSpendRequestId = sel.value;
        if (selectedLinkedSpendRequestId) {
          // Mutually exclusive with the Contract picker above.
          selectedContractId = '';
          refreshContractPicker();
          const r = requestsCache.find(x => x.RequestID === selectedLinkedSpendRequestId);
          if (r && r.Vendor) vendorEl.value = r.Vendor;
          // Carries over the original spend approval's own Description as
          // a starting point — the requester can edit or overwrite it,
          // same as Vendor above, rather than retyping the same context
          // that's already sitting right there on the linked request.
          if (r && r.Description) descEl.value = r.Description;
        }
        refreshPreview(); // updates the Approved-to-Spend amount note / over-amount flag right away
      });
    }

    function refreshPreview() {
      body.querySelector('#pr-form-error').textContent = '';
      const type = typeEl.value;
      const wccWrap = body.querySelector('#pr-wcc-wrap');
      const vendorLabel = body.querySelector('#pr-vendor-label');
      if (!type) { previewEl.innerHTML = ''; labelEl.textContent = 'Attachments'; wccWrap.innerHTML = ''; if (vendorLabel) vendorLabel.style.display = ''; return; }
      const rule = paymentRuleFor(type);
      let amount = Number(amtEl.value) || 0;
      const isReplenishment = type === PETTY_CASH_REPLENISHMENT_PAYMENT_TYPE;

      // Petty Cash Replenishment: no vendor (internal float top-up), and
      // shows the same Float Balance context New Request used to show
      // when this lived there — moved here since it's purely a
      // payment-release workflow (Secretary→Treasurer→Payments tab), not
      // a spend-approval one.
      if (vendorLabel) vendorLabel.style.display = isReplenishment ? 'none' : '';
      if (isReplenishment) {
        const balance = computeFloatBalance();
        const inFlight = inFlightReplenishment();
        const maxAllowed = Math.max(0, PETTY_CASH_FLOAT_TARGET - balance);
        // Bug found in testing: the amount was only auto-filled once and
        // stayed freely editable afterward, so someone could type in
        // ₹17,000 against a ₹15,000 float — there's no legitimate reason
        // for this to be anything other than exactly the shortfall, so
        // it's now always recomputed and the field disabled rather than
        // just suggested. Also enforces the real trigger condition —
        // Replenishment isn't due at all while the float is still at or
        // above the ₹2,000 operational minimum, not just "whatever amount
        // someone feels like submitting."
        if (inFlight) {
          amtEl.disabled = true;
          wccWrap.innerHTML = `<p class="error-text" style="margin:8px 0;">⚠️ A Replenishment request (${formatAmount(inFlight.Amount)}) is already in progress — please wait for it to be fully paid out before submitting another.</p>`;
        } else if (balance >= PETTY_CASH_OPERATIONAL_MIN) {
          amtEl.disabled = true;
          amtEl.value = '';
          wccWrap.innerHTML = `<p class="error-text" style="margin:8px 0;">⚠️ Float Balance is ${formatAmount(balance)} — still at or above the ₹${PETTY_CASH_OPERATIONAL_MIN.toLocaleString('en-IN')} operational minimum. Replenishment isn't due yet.</p>`;
        } else {
          amtEl.disabled = true;
          amtEl.value = maxAllowed;
          amount = maxAllowed;
          wccWrap.innerHTML = `
            <p class="muted" style="margin:8px 0;">Float Balance: <strong style="color:#b3261e;">${formatAmount(balance)}</strong> of ${formatAmount(PETTY_CASH_FLOAT_TARGET)}</p>
            <p class="muted" style="margin:8px 0;">Amount is fixed at the shortfall needed to restore the float to ${formatAmount(PETTY_CASH_FLOAT_TARGET)} — not editable.</p>`;
        }
      } else {
        amtEl.disabled = false;
        if (isWccPaymentType(type)) {
          // R&M/CAPEX only: goods-procurement toggle changes which documents
          // apply (see effectiveDocsForPayment/Governance Note 5).
          wccWrap.innerHTML = `
            <label style="display:flex;align-items:center;gap:8px;margin:8px 0;">
              <input type="checkbox" id="pr-goods-procurement" ${paymentIsGoodsProcurement ? 'checked' : ''}>
              This is procurement of goods (not works/services), verified via Goods Receipt / Material Receipt (FIN-F-005)
            </label>`;
          wccWrap.querySelector('#pr-goods-procurement').addEventListener('change', (e) => {
            paymentIsGoodsProcurement = e.target.checked;
            refreshPreview();
          });
        } else {
          wccWrap.innerHTML = '';
          paymentIsGoodsProcurement = false;
        }
      }
      // Shows the linked Approval-to-Spend's own approved amount right
      // next to the Amount field, and flags it plainly when this payment
      // is asking for more than that — the requester (and whoever
      // approves it) should see the mismatch before submitting, not
      // discover it later reconciling budget consumption against actual
      // spend. Only meaningful for the direct Approval-to-Spend link —
      // a Contract is an ongoing agreement, not a single fixed amount to
      // compare against.
      const spendNoteEl = body.querySelector('#pr-spend-amount-note');
      const justWrap = body.querySelector('#pr-overage-justification-wrap');
      if (spendNoteEl) {
        const linkedAts = selectedLinkedSpendRequestId ? requestsCache.find(r => r.RequestID === selectedLinkedSpendRequestId) : null;
        if (linkedAts) {
          const atsAmount = Number(linkedAts.Amount) || 0;
          const over = amount > 0 && amount > atsAmount;
          spendNoteEl.innerHTML = `
            <p class="muted" style="margin:4px 0;">Approved to Spend (${escapeHtml(linkedAts.RequestID)}): <strong>${formatAmount(atsAmount)}</strong></p>
            ${over ? `<p class="error-text" style="margin:4px 0;">⚠️ This payment request (${formatAmount(amount)}) is higher than the approved spend (${formatAmount(atsAmount)} — ${escapeHtml(linkedAts.RequestID)}).</p>` : ''}
          `;
          // Only (re)built the moment "over" actually changes — see the
          // overageJustificationVisible comment above. Rebuilding this on
          // every keystroke of Amount would wipe out whatever the
          // requester has already typed here.
          if (justWrap) {
            if (over && !overageJustificationVisible) {
              justWrap.innerHTML = `
                <label>Justification for exceeding approved spend
                  <textarea id="pr-overage-justification" rows="2" placeholder="Why is this payment more than the approved spend amount?"></textarea>
                </label>`;
              overageJustificationVisible = true;
            } else if (!over && overageJustificationVisible) {
              justWrap.innerHTML = '';
              overageJustificationVisible = false;
            }
          }
        } else {
          spendNoteEl.innerHTML = '';
          if (justWrap && overageJustificationVisible) { justWrap.innerHTML = ''; overageJustificationVisible = false; }
        }
      }
      const docs = effectiveDocsForPayment(type, amount, paymentIsGoodsProcurement);
      previewEl.innerHTML = `
        <div class="mvoa-list-item" style="margin-top:10px;">
          <p style="margin:0 0 6px;font-weight:600;">This payment will need:</p>
          ${rule.FMRequired === 'Yes' ? '<p class="muted" style="margin:2px 0;">FM Verification (Receipt / Service Verification)</p>' : ''}
          ${rule.OpsHeadRequired === 'Yes' ? '<p class="muted" style="margin:2px 0;">Operations Head — Technical Acceptance</p>' : ''}
          ${rule.SecretaryRequired === 'Yes' ? '<p class="muted" style="margin:2px 0;">Secretary — Admin Approval</p>' : ''}
          ${rule.PresidentRequired === 'Yes' ? '<p class="muted" style="margin:2px 0;">President Approval</p>' : ''}
          <p class="muted" style="margin:2px 0;">Treasurer — reviews and signs off the Expense Sheet entry once the Accountant logs it</p>
          ${docs.length ? `<p class="muted" style="margin:6px 0 0;">Minimum documents: ${docs.map(escapeHtml).join(', ')}${isWccPaymentType(type) && !paymentIsGoodsProcurement ? (amount > WCC_THRESHOLD ? ' (WCC required — over ₹50,000)' : ' (WCC not required — ₹50,000 or under)') : ''}${isDocsConfirmationOnly(docs) ? ' — confirm with the checkbox below, no attachment needed.' : ''}</p>` : ''}
          ${isDocsConfirmationOnly(docs) ? `
            <label style="display:flex;align-items:center;gap:8px;margin-top:8px;">
              <input type="checkbox" id="pr-docs-confirmed">
              ✅ Original documents submitted to Accountant
            </label>` : ''}
        </div>`;
      // Requires an attachment for each listed document (capped at 3,
      // matching the existing Schedule A/B/C flow's pattern) rather than
      // a flat "1 required" regardless of how many are actually listed —
      // bug found in testing: a payment type listing 3 documents was only
      // asking for 1 attachment. Note: verification-type items in the
      // list (e.g. "Service Verification") count toward this too for now,
      // since there's no reliable way to tell those apart from real
      // documents (invoices, WCC, delivery slips) just from the text —
      // in practice that just means a photo can stand in as evidence.
      // A pure confirmation doc (Petty Cash Replenishment's "Original
      // Documents Submitted to Accountant") needs a checkbox, not a file.
      const minAttachments = isDocsConfirmationOnly(docs) ? 0 : (docs.length === 1 && docs[0].trim() === '-') ? 0 : Math.min(docs.length, 3);
      labelEl.parentElement.style.display = isDocsConfirmationOnly(docs) ? 'none' : '';
      labelEl.textContent = minAttachments > 0 ? `Attachments — at least ${minAttachments} required (see documents needed above)` : 'Attachments (optional)';
      renderDocAttachmentPicker(body, '#pr-attachment-chips', '#pr-attachment-btns', paymentPendingAttachments, docs, 3);
    }

    typeEl.addEventListener('change', () => {
      // Changing Payment Type re-scopes both link pickers to a different
      // spend category — whatever was previously selected may not even
      // be in the new list, so clear both rather than leave a stale,
      // now-invisible selection silently still attached to the request.
      selectedContractId = '';
      selectedLinkedSpendRequestId = '';
      refreshPreview();
      refreshContractPicker();
      refreshSpendRequestPicker();
    });
    amtEl.addEventListener('input', refreshPreview);
    refreshContractPicker();
    refreshSpendRequestPicker();

    body.querySelector('#pr-submit-btn').addEventListener('click', () => submitPaymentRequest(body, container));
  }

  let isPaymentSubmitting = false;
  async function submitPaymentRequest(body, container) {
    if (isPaymentSubmitting) return;
    isPaymentSubmitting = true;
    try { await doSubmitPaymentRequest(body, container); }
    finally { isPaymentSubmitting = false; }
  }

  async function doSubmitPaymentRequest(body, container) {
    const submitBtn = body.querySelector('#pr-submit-btn');
    const errEl = body.querySelector('#pr-form-error');
    errEl.textContent = '';
    const paymentType = body.querySelector('#pr-type').value;
    const amount = Number(body.querySelector('#pr-amount').value) || 0;
    const vendor = body.querySelector('#pr-vendor').value.trim();
    const desc = body.querySelector('#pr-desc').value.trim();

    if (!paymentType) { errEl.textContent = 'Please select a Payment Type.'; return; }
    if (amount <= 0) { errEl.textContent = 'Please enter an amount greater than zero.'; return; }
    const isReplenishment = paymentType === PETTY_CASH_REPLENISHMENT_PAYMENT_TYPE;
    if (!vendor && !isReplenishment) { errEl.textContent = 'Please enter a Vendor / Payee.'; return; }
    if (isReplenishment) {
      const balance = computeFloatBalance();
      const maxAllowed = Math.max(0, PETTY_CASH_FLOAT_TARGET - balance);
      const inFlight = inFlightReplenishment();
      if (inFlight) {
        errEl.textContent = `A Replenishment request (${formatAmount(inFlight.Amount)}, submitted ${formatDate(inFlight.RequestedDate)}) is already in progress — please wait for it to be fully paid out before submitting another.`;
        return;
      }
      if (balance >= PETTY_CASH_OPERATIONAL_MIN) {
        errEl.textContent = `Float Balance is ${formatAmount(balance)} — still at or above the ₹${PETTY_CASH_OPERATIONAL_MIN.toLocaleString('en-IN')} operational minimum. Replenishment isn't due yet.`;
        return;
      }
      if (amount !== maxAllowed) {
        errEl.textContent = `Replenishment amount must restore the float to exactly ${formatAmount(PETTY_CASH_FLOAT_TARGET)} — that's ${formatAmount(maxAllowed)}, not ${formatAmount(amount)}.`;
        return;
      }
    }

    const rule = paymentRuleFor(paymentType);
    const docs = effectiveDocsForPayment(paymentType, amount, paymentIsGoodsProcurement);
    if (isDocsConfirmationOnly(docs)) {
      const confirmBox = body.querySelector('#pr-docs-confirmed');
      if (!confirmBox || !confirmBox.checked) {
        errEl.textContent = 'Please confirm that the original documents have been submitted to the Accountant.';
        return;
      }
    }
    const minAttachments = isDocsConfirmationOnly(docs) ? 0 : (docs.length === 1 && docs[0].trim() === '-') ? 0 : Math.min(docs.length, 3);
    if (paymentPendingAttachments.length < minAttachments) {
      errEl.textContent = `This payment type requires at least ${minAttachments} attachment(s): ${docs.join(', ')}.`;
      return;
    }
    if (rule.RequiresContractLookup === 'Yes' && !selectedContractId && !selectedLinkedSpendRequestId) {
      errEl.textContent = 'This payment type requires linking to a Contract or an Approval to Spend before it can be submitted.';
      return;
    }
    // Mirrors the red flag shown live on this form (see refreshPreview) —
    // re-checked here at submit time too, since the linked request or
    // amount could have changed since the flag last redrew. Required,
    // not optional: a payment that knowingly exceeds what was approved
    // needs an explanation on record, not just a number in a cell.
    const linkedAtsForSubmit = selectedLinkedSpendRequestId ? requestsCache.find(r => r.RequestID === selectedLinkedSpendRequestId) : null;
    const isOverApprovedSpend = !!(linkedAtsForSubmit && amount > (Number(linkedAtsForSubmit.Amount) || 0));
    const overageJustification = isOverApprovedSpend ? (body.querySelector('#pr-overage-justification')?.value || '').trim() : '';
    if (isOverApprovedSpend && !overageJustification) {
      errEl.textContent = 'This payment is higher than the approved spend — please enter a justification before submitting.';
      return;
    }

    setBtnBusy(submitBtn, 'Submitting…');

    const user = MVOA.getUser();
    const existingIds = requestsCache.map(r => r.RequestID);
    // ATP ("Approval To Pay") — distinct from spend approvals' ATS prefix,
    // so an ID quoted on a document unambiguously says which kind of
    // approval it is. Both draw from the same requestsCache id pool;
    // MVOA.nextId only matches its own prefix so this doesn't collide
    // with — or renumber — existing legacy "FIN-####" rows.
    const requestId = MVOA.nextId('ATP', existingIds);
    const now = new Date().toISOString();

    const attachmentUrls = ['', '', ''];
    if (paymentPendingAttachments.length) {
      for (let i = 0; i < Math.min(paymentPendingAttachments.length, 3); i++) {
        const att = paymentPendingAttachments[i];
        try {
          attachmentUrls[i] = await MVOA.uploadPhotoToDrive(att.file, `${requestId}_att${i+1}_${att.name}`);
        } catch (e) {
          errEl.textContent = `Attachment ${i+1} upload failed: ${e.message}`;
          clearBtnBusy(submitBtn, 'Submit Payment Request');
          return;
        }
      }
    }

    // If FM is the only thing this PaymentType requires, auto-approving
    // it above (see below) means there's genuinely nothing left pending
    // — settle straight to Approved. No current Payment Type is FM-only,
    // but this keeps the logic correct if one ever is. TreasurerRequired
    // is included here (27-Aug-2026) now that Treasurer is a real
    // pre-approval gate — otherwise a request could wrongly settle to
    // Approved while Treasurer sign-off was still outstanding.
    const onlyFmRequired = rule.FMRequired === 'Yes' && ['OpsHeadRequired', 'SecretaryRequired', 'PresidentRequired', 'TreasurerRequired'].every(c => rule[c] !== 'Yes');
    const initialStatus = (paymentHasNoApprovalStages(paymentType) || onlyFmRequired) ? 'Approved' : 'PendingApproval';
    const row = {
      RequestID: requestId, RuleID: '', Category: paymentType, BudgetStatus: '',
      Amount: amount, Vendor: vendor, Description: desc, RequestedBy: user.name, RequestedDate: now,
      RequestType: 'PaymentRequest', AttachmentURL_1: attachmentUrls[0], AttachmentURL_2: attachmentUrls[1],
      AttachmentURL_3: attachmentUrls[2], RequiredDocsSnapshot: docs.join(' + '),
      Status: initialStatus, QuorumRequired: '', ECApprovalCount: 0,
      ClosedDate: '', ClosedBy: '', PaymentStatus: 'Unpaid', PaymentDate: '', PaymentRef: '',
      NotifiedAt: '', ReminderSentAt: '', DisbursementStage: '', ExpenseTab: '', ExpenseRow: '',
      StageEnteredAt: now, StageOpenedAt: '', PettyCashType: '', ContractID: selectedContractId,
      LinkedSpendRequestID: selectedLinkedSpendRequestId, OverageJustification: overageJustification
    };

    try {
      await MVOA.sheetsAppend(TAB_REQUESTS, objToRow(REQUEST_COLS, row));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Payment Request Submitted', comment: `${paymentType} — ${formatAmount(amount)}`, statusAfter: initialStatus });
      // FM Verification (Receipt/Service Verification) isn't a separate
      // approval-queue hop requiring someone to log in and click Approve
      // — per Governance Note 3, it's satisfied by the photographic/
      // document evidence itself. Bug found in testing: this was
      // wrongly modeled as its own stage needing a distinct FM-role
      // click, so a request could sit at "Awaiting FM Verification"
      // forever even with the attachment already provided (even when
      // the submitter WAS the FM). Auto-approving it here — crediting
      // whoever submitted, since providing the evidence IS the
      // verification act — means the chain moves straight to Secretary
      // next, while still leaving a real entry in the trail showing
      // who verified and when.
      let fmRow = null;
      if (rule.FMRequired === 'Yes') {
        fmRow = {
          ApprovalID: await nextApprovalId(), RequestID: requestId, ApproverName: user.name, ApproverRole: user.role || '',
          Stage: 'FM', Decision: 'Approved', Comment: 'Verified via attachment at submission', Timestamp: now
        };
        await MVOA.sheetsAppend(TAB_APPROVALS, objToRow(APPROVAL_COLS, fmRow));
      }

      // Same principle, generalized to the remaining stages: if the
      // submitter's own role matches a LATER required stage too (e.g. an
      // Operations Head submitting a payment type that also requires
      // OpsHead sign-off), don't make them separately log an Approve
      // click on their own submission for that stage either — same
      // rationale as the Spend Approval fix in doSubmitRequest. Stops at
      // the first required stage the submitter's role does NOT satisfy;
      // that one still needs someone else for real. Unlike FM (always
      // auto-approved, see above — providing the evidence IS the
      // verification act), these need a genuine role match: a Secretary
      // submitting does not satisfy Operations Head's Technical
      // Acceptance, for instance.
      const person = rolesCache.find(p => p.Name === user.name) || { Name: user.name, Role: user.role };
      const remainingAutoApprovals = [];
      // 'Treasurer' added 27-Aug-2026, now that it's a real pre-approval
      // stage again (see PAYMENT_PRE_APPROVAL_STAGES) — a Treasurer
      // submitting a payment type that also requires Treasurer sign-off
      // shouldn't have to separately approve their own submission here
      // either, same as the other roles below.
      for (const key of ['OpsHead', 'Secretary', 'President', 'Treasurer']) {
        if (rule[PAYMENT_STAGE_REQUIRED_COL[key]] !== 'Yes') continue; // not required for this payment type at all
        if (!roleMatchesToken(person, PAYMENT_STAGE_ROLE_TOKEN[key])) break; // needs someone else — stop here
        remainingAutoApprovals.push({
          ApprovalID: await nextApprovalId(), RequestID: requestId, ApproverName: user.name, ApproverRole: user.role || '',
          Stage: key, Decision: 'Approved', Comment: 'Auto-approved — submitter already holds this role', Timestamp: now
        });
      }
      if (remainingAutoApprovals.length) {
        for (const a of remainingAutoApprovals) await MVOA.sheetsAppend(TAB_APPROVALS, objToRow(APPROVAL_COLS, a));
        await loadAll(true);
        const freshRow = requestsCache.find(r => r.RequestID === requestId);
        if (freshRow) {
          const allNewApprovals = (fmRow ? [fmRow] : []).concat(remainingAutoApprovals);
          const state = computePaymentRequestState(freshRow, allNewApprovals);
          const now2 = new Date().toISOString();
          const updated = state.fullyApproved
            ? Object.assign({}, freshRow, { Status: 'Approved', StageEnteredAt: now2, StageOpenedAt: '' })
            : Object.assign({}, freshRow, { StageEnteredAt: now2, StageOpenedAt: '' });
          await MVOA.sheetsUpdateRow(TAB_REQUESTS, freshRow.rowNumber, objToRow(REQUEST_COLS, updated));
        }
      }
    } catch (e) {
      errEl.textContent = 'Could not save request: ' + e.message;
      clearBtnBusy(submitBtn, 'Submit Payment Request');
      return;
    }

    paymentPendingAttachments = [];
    selectedContractId = '';
    selectedLinkedSpendRequestId = '';
    paymentIsGoodsProcurement = false;
    await loadAll(true);
    currentView = 'mine';
    render(container);
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
        <div id="fin-pettycash-type-wrap"></div>
        <label>Amount (₹)
          <input id="fin-amount" type="number" min="0" step="1" placeholder="0" style="-moz-appearance:textfield;" onwheel="this.blur()">
          <style>#fin-amount::-webkit-outer-spin-button, #fin-amount::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }</style>
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
        <div id="fin-cs-toggle-wrap"></div>
        <div id="fin-cs-fields-wrap"></div>
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
    renderDocAttachmentPicker(body, '#fin-attachment-chips', '#fin-attachment-btns', pendingAttachments, [], 3);

    const catEl = body.querySelector('#fin-category');
    const amtEl = body.querySelector('#fin-amount');
    const bsWrap = body.querySelector('#fin-budget-status-wrap');
    const pcTypeWrap = body.querySelector('#fin-pettycash-type-wrap');

    function refreshPettyCashTypeSelector() {
      if (catEl.value !== 'Petty Cash') {
        pcTypeWrap.innerHTML = '';
        pettyCashType = 'Expense';
        return;
      }
      // Replenishment moved to "New Payment Request" — it's purely a
      // payment-release workflow (Secretary → Treasurer → Payments tab),
      // not a spend-approval one, so it doesn't belong on this form
      // anymore. This form now only ever logs an Expense against the
      // float; pettyCashType is kept (rather than removed outright) only
      // for the doSubmitRequest code path further down that still reads
      // it, and for backward compatibility with the FinanceRequests rows
      // already submitted the old way.
      pettyCashType = 'Expense';
      const balance = computeFloatBalance();
      const inFlight = inFlightReplenishment();
      // One-time setup reminder — shown only until the very first Petty
      // Cash request of any kind has been logged. The live float
      // calculation assumes a fresh ₹15,000 float with nothing spent yet;
      // if the real physical balance on go-live day is already lower, that
      // gap needs a one-off "opening adjustment" Expense entry first, or
      // every balance shown afterwards will be wrong by that amount.
      const isFirstEverPettyCashUse = !requestsCache.some(r => r.Category === 'Petty Cash');
      pcTypeWrap.innerHTML = `
        ${isFirstEverPettyCashUse ? `
          <div class="mvoa-list-item" style="margin:6px 0;background:#fff8e1;">
            <p style="margin:0;font-weight:600;">⚙️ First-time setup</p>
            <p class="muted" style="margin:4px 0 0;">This assumes the float starts at a fresh ₹15,000. If the real physical balance right now is already lower, log a one-off Expense entry first for the gap (e.g. "Opening balance adjustment — pre-app float usage") before relying on the balance below.</p>
          </div>` : ''}
        <div class="mvoa-list-item" style="margin:6px 0;">
          <p style="margin:0 0 6px;font-weight:600;">Float Balance: <span style="color:${balance < PETTY_CASH_OPERATIONAL_MIN ? '#b3261e' : 'green'};">${formatAmount(balance)}</span> of ${formatAmount(PETTY_CASH_FLOAT_TARGET)}</p>
          ${balance < PETTY_CASH_OPERATIONAL_MIN && !inFlight ? `<p class="error-text" style="margin:0 0 6px;">⚠️ Below the ₹${PETTY_CASH_OPERATIONAL_MIN.toLocaleString('en-IN')} operational minimum — submit a Replenishment via <strong>💵 New Payment Request</strong> (Payment Type: "${PETTY_CASH_REPLENISHMENT_PAYMENT_TYPE}").</p>` : ''}
          ${inFlight ? `<p class="muted" style="margin:0 0 6px;">A Replenishment request (${formatAmount(inFlight.Amount)}) is already in progress via New Payment Request — no action needed here.</p>` : ''}
        </div>`;
    }

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

    // Combines the DoFA Matrix's own MinimumDocs requirement with the
    // Purchase Requisition's Procurement Method (if that's being filled
    // in-app) to arrive at one effective attachment minimum + label.
    function refreshAttachmentsLabel() {
      const category = catEl.value;
      const amount = Number(amtEl.value) || 0;
      const result = resolveRule(category, currentBudgetStatus(), amount, pettyCashType);
      const docs = result.rule ? requiredDocsList(result.rule) : [];
      // Same filtering as doSubmitRequest — a doc covered by the in-app
      // Purchase Requisition/Comparative Statement toggle isn't a real
      // attachment to name a button after.
      const docsNeedingUpload = (isJustificationOnly(docs) || isDocsConfirmationOnly(docs)) ? [] : docs.filter(d => {
        if (fillPrInApp && /purchase request/i.test(d)) return false;
        if (fillCsInApp && /comparative statement/i.test(d)) return false;
        return true;
      });
      const docsMin = Math.min(docsNeedingUpload.length, 3);
      const methodEl = body.querySelector('#fin-pr-method');
      const quoteMin = (fillPrInApp && methodEl) ? quotationCountFor(methodEl.value) : 0;
      const min = Math.max(docsMin, quoteMin);
      const label = body.querySelector('#fin-attachments-label');
      if (!label) return;
      if (quoteMin > docsMin) {
        label.textContent = `Attachments — attach ${quoteMin} quotation(s), one per vendor (${quoteMin} required)`;
      } else if (min > 0) {
        label.textContent = `Attachments — at least ${min} required`;
      } else {
        label.textContent = 'Attachments (optional — up to 3)';
      }
      // Named-button picker: quotation labels take priority when the
      // Purchase Requisition's Procurement Method calls for more of them
      // than the DoFA Matrix's own document list does.
      const docLabels = quoteMin > docsMin
        ? Array.from({ length: quoteMin }, (_, i) => `Quotation ${i + 1}`)
        : docsNeedingUpload;
      renderDocAttachmentPicker(body, '#fin-attachment-chips', '#fin-attachment-btns', pendingAttachments, docLabels, 3);
    }

    function refreshRulePreview() {
      body.querySelector('#fin-form-error').textContent = ''; // clear any stale error from a previous category/amount before showing the new preview
      const previewEl = body.querySelector('#fin-rule-preview');
      const category = catEl.value;
      const amount = Number(amtEl.value) || 0;
      if (!category) { previewEl.innerHTML = ''; return; }
      const result = resolveRule(category, currentBudgetStatus(), amount, pettyCashType);
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
      const budgetStatus = effectiveBudgetStatus(currentBudgetStatus(), rule);
      const fy = currentFY();
      const info = (budgetStatus === 'Budgeted' && category !== 'Petty Cash') ? budgetInfoFor(category, fy) : null;
      previewEl.innerHTML = `
        ${(budgetStatus === 'Budgeted' && category !== 'Petty Cash') ? (info ? `
          <div class="mvoa-list-item" style="margin-top:10px;background:${info.available - amount < 0 ? '#fbeaea' : 'var(--card-bg)'};">
            <p style="margin:0;font-weight:600;">Budget Available (FY ${escapeHtml(fy)}): <span style="color:${info.available - amount < 0 ? '#b3261e' : 'green'};">${formatAmount(info.available)}</span> of ${formatAmount(info.total)}</p>
            ${amount > 0 && info.available - amount < 0 ? `<p class="error-text" style="margin:4px 0 0;">⚠️ This request (${formatAmount(amount)}) would exceed the remaining budget for this category.</p>` : ''}
          </div>` : `
          <div class="mvoa-list-item" style="margin-top:10px;">
            <p class="muted" style="margin:0;">No budget line set up yet for "${escapeHtml(category)}" in FY ${escapeHtml(fy)}.</p>
          </div>`) : ''}
        ${category === 'Petty Cash' && pettyCashType === 'Expense' && amount > 0 && amount > computeFloatBalance() ? `
          <div class="mvoa-list-item" style="margin-top:10px;background:#fbeaea;">
            <p class="error-text" style="margin:0;">⚠️ This expense (${formatAmount(amount)}) exceeds the current float balance (${formatAmount(computeFloatBalance())}).</p>
          </div>` : ''}
        <div class="mvoa-list-item" style="margin-top:10px;">
          <p style="margin:0 0 6px;font-weight:600;">This request will need:</p>
          <p class="muted" style="margin:2px 0;">Administrative approval: ${escapeHtml(rule.AdministrativeApprover || '—')}</p>
          <p class="muted" style="margin:2px 0;">Financial approval: ${escapeHtml(rule.FinancialApprover || '—')}</p>
          ${rule.ECApprovalRequired === 'Yes' || rule.ECApprovalRequired === 'Ratification'
            ? `<p class="muted" style="margin:2px 0;">EC ${rule.ECApprovalRequired === 'Ratification' ? 'ratification' : 'approval'} — quorum ${rule.QuorumOverride || DEFAULT_QUORUM}</p>` : ''}
          ${rule.AGMApprovalRequired === 'Yes' ? `<p class="muted" style="margin:2px 0;">AGM approval required</p>` : ''}
          ${docs.length ? `<p class="muted" style="margin:6px 0 0;">Minimum documents: ${docs.map(escapeHtml).join(', ')}${isJustificationOnly(docs) ? ' — write it in the Description field above, no attachment needed.' : isDocsConfirmationOnly(docs) ? ' — confirm with the checkbox below, no attachment needed.' : ' — please attach at least ' + Math.min(docs.length, 3) + ' file(s) below, or fill the Purchase Requisition in-app if offered.'}</p>` : ''}
          ${isDocsConfirmationOnly(docs) ? `
            <label style="display:flex;align-items:center;gap:8px;margin-top:8px;">
              <input type="checkbox" id="fin-pc-docs-confirmed">
              ✅ Original documents submitted to Accountant
            </label>` : ''}
        </div>`;
      refreshAttachmentsLabel();

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

      // Comparative Statement (FIN-F-001) — offered the same way, wherever
      // the Matrix calls for one. This is my best reconstruction of the
      // form's fields (up to 3 vendor quotes + a recommendation) — if it's
      // missing something from the real FIN-F-001, let me know and I'll add it.
      const csToggleWrap = body.querySelector('#fin-cs-toggle-wrap');
      const needsCS = docs.some(d => /comparative statement/i.test(d));
      if (needsCS) {
        csToggleWrap.innerHTML = `
          <label style="display:flex;align-items:center;gap:8px;margin-top:10px;">
            <input type="checkbox" id="fin-cs-fill-toggle" ${fillCsInApp ? 'checked' : ''}>
            📝 Fill the Comparative Statement in-app instead of uploading FIN-F-001
          </label>`;
        csToggleWrap.querySelector('#fin-cs-fill-toggle').addEventListener('change', (e) => {
          fillCsInApp = e.target.checked;
          renderCsFields();
        });
      } else {
        csToggleWrap.innerHTML = '';
        fillCsInApp = false;
      }
      renderCsFields();
    }

    function renderCsFields() {
      const wrap = body.querySelector('#fin-cs-fields-wrap');
      if (!fillCsInApp) { wrap.innerHTML = ''; return; }
      // Field set matches the real FIN-F-001 Vendor Comparison table
      // column-for-column (verified against the actual document).
      const vendorBlock = (n) => `
        <p style="margin:10px 0 4px;font-weight:600;">Vendor ${n}${n === 1 ? '' : ' (optional)'}</p>
        <label>Vendor Name <input id="fin-cs-v${n}-name" type="text"></label>
        <label>Quoted Amount (₹) <input id="fin-cs-v${n}-amount" type="number" min="0"></label>
        <label>Delivery Period <input id="fin-cs-v${n}-delivery" type="text" placeholder="e.g. 7 days"></label>
        <label>Warranty <input id="fin-cs-v${n}-warranty" type="text" placeholder="e.g. 1 year"></label>
        <label>Technical Compliance
          <select id="fin-cs-v${n}-techcompliance">
            <option value="">—</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </label>
        <label>Previous Performance
          <select id="fin-cs-v${n}-prevperf">
            <option value="">—</option>
            <option value="Excellent">Excellent</option>
            <option value="Good">Good</option>
            <option value="Fair">Fair</option>
            <option value="Poor">Poor</option>
          </select>
        </label>
        <label>Payment Terms <input id="fin-cs-v${n}-paymentterms" type="text"></label>
        <label>Overall Assessment <textarea id="fin-cs-v${n}-assessment" rows="2"></textarea></label>`;
      wrap.innerHTML = `
        <div class="mvoa-list-item" style="margin-top:10px;">
          <p style="margin:0 0 8px;font-weight:600;">Comparative Statement details</p>
          <p class="muted" style="margin:0 0 8px;">Enter at least 2 vendor quotes to compare, and which one you're recommending.</p>
          ${vendorBlock(1)}
          ${vendorBlock(2)}
          ${vendorBlock(3)}
          <label style="margin-top:10px;">Recommended Vendor
            <select id="fin-cs-recommended"></select>
          </label>
          <label>Reason for Recommendation <textarea id="fin-cs-reason" rows="2" placeholder="e.g. Lowest cost meeting spec, best warranty, past reliability…"></textarea></label>
        </div>`;
      const refreshRecommendedOptions = () => {
        const sel = wrap.querySelector('#fin-cs-recommended');
        const names = [1, 2, 3].map(n => wrap.querySelector(`#fin-cs-v${n}-name`).value.trim()).filter(Boolean);
        const current = sel.value;
        sel.innerHTML = names.length
          ? names.map(n => `<option value="${escapeHtml(n)}" ${n === current ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')
          : '<option value="">— enter vendor names above first —</option>';
      };
      [1, 2, 3].forEach(n => wrap.querySelector(`#fin-cs-v${n}-name`).addEventListener('input', refreshRecommendedOptions));
      refreshRecommendedOptions();
    }

    function renderPrFields() {
      const wrap = body.querySelector('#fin-pr-fields-wrap');
      if (!fillPrInApp) { wrap.innerHTML = ''; return; }
      wrap.innerHTML = `
        <div class="mvoa-list-item" style="margin-top:10px;">
          <p style="margin:0 0 8px;font-weight:600;">Purchase Requisition details</p>
          <label>Asset / Facility <input id="fin-pr-asset" type="text"></label>
          <label>Location <input id="fin-pr-location" type="text"></label>
          <label>Quantity <input id="fin-pr-qty" type="number" min="1" value="1"></label>
          <label>Reason / Justification
            <select id="fin-pr-reason">
              <option value="Breakdown">Breakdown</option>
              <option value="Preventive Maintenance">Preventive Maintenance</option>
              <option value="Safety">Safety</option>
              <option value="Statutory Compliance">Statutory Compliance</option>
              <option value="Upgrade">Upgrade</option>
              <option value="Wear and Tear">Wear and Tear</option>
              <option value="Other">Other (specify below)</option>
            </select>
          </label>
          <label id="fin-pr-reason-other-wrap" class="hidden">Specify reason <input id="fin-pr-reason-other" type="text"></label>
          <label>Current Condition <textarea id="fin-pr-condition" rows="2"></textarea></label>
          <label>Risk if Work is Deferred <input id="fin-pr-risk" type="text" placeholder="e.g. Safety Risk, Service Interruption…"></label>
          <label>Suggested Vendor / Source (optional) <input id="fin-pr-vendor-suggestion" type="text"></label>
          <label>Urgency
            <select id="fin-pr-urgency">
              <option value="Routine">Routine</option>
              <option value="Urgent">Urgent</option>
              <option value="Emergency">Emergency</option>
            </select>
          </label>
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
      const reasonSel = wrap.querySelector('#fin-pr-reason');
      const otherWrap = wrap.querySelector('#fin-pr-reason-other-wrap');
      reasonSel.addEventListener('change', () => otherWrap.classList.toggle('hidden', reasonSel.value !== 'Other'));
      wrap.querySelector('#fin-pr-method').addEventListener('change', refreshAttachmentsLabel);
      refreshAttachmentsLabel();
    }

    catEl.addEventListener('change', () => { refreshBudgetStatusSelector(); refreshPettyCashTypeSelector(); refreshRulePreview(); });
    amtEl.addEventListener('input', refreshRulePreview);
    refreshBudgetStatusSelector();
    refreshPettyCashTypeSelector();
    fillPrInApp = false;
    fillCsInApp = false;
    pettyCashType = 'Expense';

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

  // Named-document attachment picker — each required document gets its
  // own button (e.g. "📎 Add Vendor Invoice") instead of generic
  // "Add Photo"/"Add Document", so it's clear exactly what each upload is
  // for. One button covers both a camera photo and a file — pickAttachment
  // itself decides how the device offers those options; there's no
  // separate photo-only path here since a named document could reasonably
  // be provided as either. "➕ Add Additional" covers anything beyond the
  // named list (only shown while there's still room under maxCount).
  // Used by both New Request (Schedule A/B/C) and New Payment Request
  // (Schedule D) now that both know their exact required document names.
  function renderDocAttachmentPicker(scope, chipsSelector, btnsSelector, attachments, docLabels, maxCount) {
    const chipsEl = scope.querySelector(chipsSelector);
    const btnsEl = scope.querySelector(btnsSelector);
    if (!chipsEl || !btnsEl) return;
    chipsEl.innerHTML = attachments.map((a, i) => `
      <div class="mvoa-row" style="margin-bottom:4px;">
        <span>${a.isPhoto ? '📷' : '📄'} <strong>${escapeHtml(a.docLabel || 'Additional')}:</strong> ${escapeHtml(a.name)} <span class="muted">(${formatKB(a.compressedSizeBytes)})</span></span>
        <button class="btn-secondary fin-att-remove" data-idx="${i}" style="padding:4px 10px;margin:0;">✕</button>
      </div>
    `).join('');
    chipsEl.querySelectorAll('.fin-att-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        attachments.splice(parseInt(btn.dataset.idx), 1);
        renderDocAttachmentPicker(scope, chipsSelector, btnsSelector, attachments, docLabels, maxCount);
      });
    });
    const filledLabels = new Set(attachments.map(a => a.docLabel).filter(Boolean));
    const remainingNamed = (docLabels || []).filter(l => l && l.trim() !== '-' && !filledLabels.has(l));
    const roomLeft = maxCount - attachments.length;
    if (roomLeft <= 0) {
      btnsEl.innerHTML = `<p class="muted" style="margin:0;">Maximum ${maxCount} attachments reached.</p>`;
      return;
    }
    const namedToShow = remainingNamed.slice(0, roomLeft);
    // Bug found in testing: pickAttachment({photoOnly:false, useCamera:
    // false}) does NOT automatically offer both camera and file, as
    // assumed — it goes straight to a document/file browser with no
    // camera option. Fixed by giving each named document its own
    // explicit Camera / File pair instead of one ambiguous button.
    const pickFor = async (label, useCamera) => {
      const a = await MVOA.pickAttachment({ photoOnly: useCamera, useCamera });
      if (a) {
        a.docLabel = label || '';
        attachments.push(a);
        renderDocAttachmentPicker(scope, chipsSelector, btnsSelector, attachments, docLabels, maxCount);
      }
    };
    const pickerRow = (label) => `
      <div class="mvoa-row" style="gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px;">
        <span style="min-width:120px;">${label ? escapeHtml(label) : '➕ Additional'}:</span>
        <button class="btn-secondary fin-att-named-pick" data-label="${escapeHtml(label || '')}" data-mode="camera" style="padding:6px 10px;margin:0;">📷 Camera</button>
        <button class="btn-secondary fin-att-named-pick" data-label="${escapeHtml(label || '')}" data-mode="file" style="padding:6px 10px;margin:0;">📄 File</button>
      </div>`;
    // Room for something beyond the named list, or there's no named list
    // at all (e.g. Salaries, whose doc is "-")
    const canAddMore = roomLeft > namedToShow.length || namedToShow.length === 0;
    btnsEl.innerHTML = namedToShow.map(pickerRow).join('') + (canAddMore ? pickerRow(null) : '');
    btnsEl.querySelectorAll('.fin-att-named-pick').forEach(btn => {
      btn.addEventListener('click', () => pickFor(btn.dataset.label, btn.dataset.mode === 'camera'));
    });
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
    // Vendor/Payee was previously optional in the UI but not actually
    // enforced, so a request could be submitted with it blank — required
    // for every category except Petty Cash Replenishment, which has no
    // vendor (it's an internal top-up of the float, not a payment to
    // anyone).
    const isReplenishment = category === 'Petty Cash' && pettyCashType === 'Replenishment';
    if (!vendor && !isReplenishment) { errEl.textContent = 'Please enter a Vendor / Payee.'; return; }
    if (isReplenishment) {
      const inFlight = inFlightReplenishment();
      if (inFlight) {
        errEl.textContent = `A Replenishment request (${formatAmount(inFlight.Amount)}, submitted ${formatDate(inFlight.RequestedDate)}) is already in progress — please wait for it to be fully paid out before submitting another.`;
        return;
      }
    }

    const result = resolveRule(category, budgetStatus, amount, pettyCashType);
    if (result.blocked) { errEl.textContent = result.message; return; }
    if (!result.rule) { errEl.textContent = 'No approval rule matches this category/amount combination — contact your Developer.'; return; }
    const rule = result.rule;
    // See effectiveBudgetStatus's comment — a single-tier category (no
    // Budgeted/Unbudgeted selector shown) must still be saved as
    // 'Budgeted' by default, or its FinanceBudgets line never accrues
    // any Consumed amount at all.
    const savedBudgetStatus = effectiveBudgetStatus(budgetStatus, rule);
    const docs = requiredDocsList(rule);
    const justificationOnly = isJustificationOnly(docs);
    const docsConfirmationOnly = isDocsConfirmationOnly(docs);
    if (docsConfirmationOnly) {
      const confirmBox = body.querySelector('#fin-pc-docs-confirmed');
      if (!confirmBox || !confirmBox.checked) {
        errEl.textContent = 'Please confirm that the original documents have been submitted to the Accountant.';
        return;
      }
    }
    // If the Purchase Requisition is being filled in-app, it no longer needs
    // to be one of the uploaded attachments — the in-app fields below stand
    // in for FIN-F-004 directly. Same for a Justification-only requirement —
    // that's written straight into the Description field, no file needed.
    const docsNeedingUpload = (justificationOnly || docsConfirmationOnly) ? [] : docs.filter(d => {
      if (fillPrInApp && /purchase request/i.test(d)) return false;
      if (fillCsInApp && /comparative statement/i.test(d)) return false;
      return true;
    });
    const docsMinAttachments = Math.min(docsNeedingUpload.length, 3);
    // Procurement Method chosen on the Purchase Requisition carries its own
    // attachment requirement (N quotations) — take whichever minimum is
    // stricter.
    const prMethodVal = fillPrInApp ? (body.querySelector('#fin-pr-method') || {}).value : '';
    const quoteMinAttachments = quotationCountFor(prMethodVal);
    const minAttachments = Math.max(docsMinAttachments, quoteMinAttachments);
    if (justificationOnly && !desc) {
      errEl.textContent = `Please describe the reason in the Description field (this category's requirement — "${docs[0]}" — is written there, not attached as a file).`;
      return;
    }
    if (pendingAttachments.length < minAttachments) {
      errEl.textContent = quoteMinAttachments > docsMinAttachments
        ? `"${prMethodVal}" requires ${quoteMinAttachments} quotation attachment(s), one per vendor.`
        : `This category requires at least ${minAttachments} attachment(s): ${docsNeedingUpload.join(', ')}.`;
      return;
    }
    let prFields = {};
    if (fillPrInApp) {
      const val = id => (body.querySelector(id) || { value: '' }).value.trim();
      const reasonSel = val('#fin-pr-reason');
      prFields = {
        PR_AssetFacility: val('#fin-pr-asset'), PR_Location: val('#fin-pr-location'),
        PR_Quantity: val('#fin-pr-qty'),
        PR_ReasonJustification: reasonSel === 'Other' ? val('#fin-pr-reason-other') : reasonSel,
        PR_CurrentCondition: val('#fin-pr-condition'),
        PR_RiskIfDeferred: val('#fin-pr-risk'), PR_SuggestedVendor: val('#fin-pr-vendor-suggestion'),
        PR_Urgency: val('#fin-pr-urgency'), PR_ProcurementMethod: val('#fin-pr-method'),
        PR_ExpectedCompletionDays: val('#fin-pr-days')
      };
      if (!prFields.PR_AssetFacility || !prFields.PR_ReasonJustification) {
        errEl.textContent = 'Please fill in at least Asset/Facility and Reason/Justification on the Purchase Requisition.';
        return;
      }
    }
    let csFields = {};
    if (fillCsInApp) {
      const val = id => (body.querySelector(id) || { value: '' }).value.trim();
      const vendorFields = (n) => ({
        [`CS_Vendor${n}Name`]: val(`#fin-cs-v${n}-name`),
        [`CS_Vendor${n}Amount`]: val(`#fin-cs-v${n}-amount`),
        [`CS_Vendor${n}Delivery`]: val(`#fin-cs-v${n}-delivery`),
        [`CS_Vendor${n}Warranty`]: val(`#fin-cs-v${n}-warranty`),
        [`CS_Vendor${n}TechCompliance`]: val(`#fin-cs-v${n}-techcompliance`),
        [`CS_Vendor${n}PrevPerformance`]: val(`#fin-cs-v${n}-prevperf`),
        [`CS_Vendor${n}PaymentTerms`]: val(`#fin-cs-v${n}-paymentterms`),
        [`CS_Vendor${n}OverallAssessment`]: val(`#fin-cs-v${n}-assessment`)
      });
      csFields = Object.assign(
        vendorFields(1), vendorFields(2), vendorFields(3),
        { CS_RecommendedVendor: val('#fin-cs-recommended'), CS_RecommendationReason: val('#fin-cs-reason') }
      );
      const vendorCount = [1, 2, 3].filter(n => csFields[`CS_Vendor${n}Name`] && csFields[`CS_Vendor${n}Amount`]).length;
      if (vendorCount < 2) {
        errEl.textContent = 'Please enter at least 2 vendor quotes (name + amount) on the Comparative Statement.';
        return;
      }
      if (!csFields.CS_RecommendedVendor || !csFields.CS_RecommendationReason) {
        errEl.textContent = 'Please select a Recommended Vendor and give a Reason for Recommendation.';
        return;
      }
    }

    setBtnBusy(submitBtn, 'Submitting…');

    const user = MVOA.getUser();
    const existingIds = requestsCache.map(r => r.RequestID);
    // ATS ("Approval To Spend") — distinct from payment requests' ATP
    // prefix, so an ID quoted on a Work Order/AMC/agreement unambiguously
    // says which kind of approval it is. See the ATP comment in
    // doSubmitPaymentRequest for why this is safe against existing
    // legacy "FIN-####" rows.
    const requestId = MVOA.nextId('ATS', existingIds);
    const now = new Date().toISOString();

    const attachmentUrls = ['', '', ''];
    if (pendingAttachments.length) {
      for (let i = 0; i < Math.min(pendingAttachments.length, 3); i++) {
        const att = pendingAttachments[i];
        try {
          attachmentUrls[i] = await MVOA.uploadPhotoToDrive(att.file, `${requestId}_att${i+1}_${att.name}`);
        } catch (e) {
          errEl.textContent = `Attachment ${i+1} upload failed: ${e.message}`;
          clearBtnBusy(submitBtn, 'Submit Request');
          return;
        }
      }
    }

    const requestType = category === 'Petty Cash' ? (pettyCashType === 'Replenishment' ? 'PettyCashReplenishment' : 'PettyCashExpense')
      : category === 'Emergency Expenditure' ? 'Emergency' : 'Standard';

    // A rule with no Administrative/Financial/EC/AGM requirement at all
    // (e.g. Petty Cash Expense ≤₹1,000) has nothing left for anyone to
    // click "Approve" on — settle it as Approved immediately rather than
    // leaving it stuck at PendingApproval forever with no path forward.
    const hasNoApprovalStages = parseApproverGroups(rule.AdministrativeApprover).length === 0 &&
      parseApproverGroups(rule.FinancialApprover).length === 0 &&
      rule.ECApprovalRequired !== 'Yes' && rule.ECApprovalRequired !== 'Ratification' &&
      rule.AGMApprovalRequired !== 'Yes';
    const initialStatus = hasNoApprovalStages ? 'Approved' : 'PendingApproval';

    const row = Object.assign({
      RequestID: requestId, RuleID: rule.RuleID, Category: category, BudgetStatus: savedBudgetStatus,
      Amount: amount, Vendor: vendor, Description: desc, RequestedBy: user.name, RequestedDate: now,
      RequestType: requestType, AttachmentURL_1: attachmentUrls[0], AttachmentURL_2: attachmentUrls[1],
      AttachmentURL_3: attachmentUrls[2], RequiredDocsSnapshot: rule.MinimumDocs || '',
      Status: initialStatus, QuorumRequired: rule.QuorumOverride || '', ECApprovalCount: 0,
      ClosedDate: '', ClosedBy: '', PaymentStatus: 'Unpaid', PaymentDate: '', PaymentRef: '',
      NotifiedAt: '', ReminderSentAt: '', DisbursementStage: '', ExpenseTab: '', ExpenseRow: '',
      StageEnteredAt: now, StageOpenedAt: '', PettyCashType: category === 'Petty Cash' ? pettyCashType : ''
    }, prFields, csFields);

    try {
      await MVOA.sheetsAppend(TAB_REQUESTS, objToRow(REQUEST_COLS, row));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Submitted', comment: `${category} — ${formatAmount(amount)}`, statusAfter: initialStatus });
    } catch (e) {
      errEl.textContent = 'Could not save request: ' + e.message;
      clearBtnBusy(submitBtn, 'Submit Request');
      return;
    }

    // Bug found in testing: if the person submitting is ALSO the sole
    // required approver for the Administrative (and/or Financial) stage
    // — e.g. a Secretary raising a request whose matrix lists "Secretary"
    // as the Administrative approver, because the normal initiator
    // wasn't available to do it themselves — the request came back to
    // that SAME person as a fresh pending approval, asking them to
    // approve their own submission. That's a no-op click, not a genuine
    // second opinion, same rationale as the FM auto-approval below in
    // doSubmitPaymentRequest. Auto-credit the submitter for each LEADING
    // stage they single-handedly satisfy, stopping at the first stage
    // that still genuinely needs someone else (e.g. a "Secretary &
    // President" AND-group where only Secretary submitted — President
    // still has to approve for real). EC/AGM are never auto-approved
    // this way — those need a genuine quorum/vote, not one person's say.
    if (!hasNoApprovalStages) {
      const person = rolesCache.find(p => p.Name === user.name) || { Name: user.name, Role: user.role };
      const leadingStages = [
        { key: 'Administrative', groups: parseApproverGroups(rule.AdministrativeApprover) },
        { key: 'Financial', groups: parseApproverGroups(rule.FinancialApprover) }
      ];
      const autoApprovals = [];
      for (const s of leadingStages) {
        if (!s.groups.length) continue; // stage doesn't apply to this rule at all
        if (!s.groups.every(g => personMatchesAndGroup(person, g))) break; // needs someone else too — stop here
        autoApprovals.push({
          ApprovalID: await nextApprovalId(), RequestID: requestId, ApproverName: user.name, ApproverRole: user.role || '',
          Stage: s.key, Decision: 'Approved', Comment: 'Auto-approved — submitter already holds this role', Timestamp: now
        });
      }
      if (autoApprovals.length) {
        try {
          for (const a of autoApprovals) await MVOA.sheetsAppend(TAB_APPROVALS, objToRow(APPROVAL_COLS, a));
          await loadAll(true);
          const freshRow = requestsCache.find(r => r.RequestID === requestId);
          if (freshRow) {
            const state = computeRequestState(freshRow, autoApprovals);
            const now2 = new Date().toISOString();
            const updated = state.fullyApproved
              ? Object.assign({}, freshRow, { Status: 'Approved', ECApprovalCount: state.ecCount, StageEnteredAt: now2, StageOpenedAt: '' })
              : Object.assign({}, freshRow, { StageEnteredAt: now2, StageOpenedAt: '' });
            await MVOA.sheetsUpdateRow(TAB_REQUESTS, freshRow.rowNumber, objToRow(REQUEST_COLS, updated));
          }
        } catch (e) { /* best-effort — the request itself is already safely saved either way */ }
      }
    }

    pendingAttachments = [];
    fillPrInApp = false;
    fillCsInApp = false;
    pettyCashType = 'Expense';
    await loadAll(true);
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
    const c = colors[colorClass] || colors.pending; // never throw on an unrecognized class — worst case, wrong color, not a missing badge
    return `<span class="mvoa-badge" style="color:${c.split(';')[0]};background:${c.split('background:')[1]};">${escapeHtml(text)}</span>`;
  }

  // Who rejected a request and why — shown on the requester's own "My
  // Requests" card. request.ClosedBy is always present (set at rejection
  // time) even if the Approvals sheet read fails; the Stage/Comment come
  // from the matching Approvals row when available, so the requester
  // knows not just THAT it was rejected but by whom, at which stage
  // (rejection can happen at Secretary OR Treasurer level, even after an
  // earlier stage already approved), and what reason was given.
  function rejectionDetailHtml(request, approvals) {
    const rejection = (approvals || []).find(a => a.Decision === 'Rejected');
    const by = (rejection && rejection.ApproverName) || request.ClosedBy || 'Unknown';
    const stage = rejection ? rejection.Stage : '';
    const comment = rejection ? (rejection.Comment || '').trim() : '';
    return `
      <div class="mvoa-list-item" style="margin:6px 0 0;background:#fbeaea;">
        <p style="margin:0;font-weight:600;color:#b3261e;">Rejected by ${escapeHtml(by)}${stage ? ' (' + escapeHtml(stage) + ' stage)' : ''}</p>
        <p class="muted" style="margin:4px 0 0;">${comment ? `"${escapeHtml(comment)}"` : 'No reason given.'}</p>
      </div>`;
  }

  // Full workflow trail for a single request — every stage this
  // request's rule actually requires, in order, with who acted on it and
  // when (or "still pending"), plus the attachments uploaded and, once
  // Approved, where it stands in the Payments pipeline. Shown on "My
  // Requests" so the requester can see the whole picture, not just the
  // current stage.
  function renderRequestTrailHtml(request, approvals) {
    // Rebuilt as a true CHRONOLOGICAL event log rather than grouped by
    // stage — bug found in testing: grouping by stage bunched every
    // Secretary action together even when a Treasurer send-back
    // genuinely happened in between them chronologically, making a
    // correct sequence look wrong. This also naturally surfaces
    // Resubmitted events (previously invisible, since 'Initiator' isn't
    // a real approval stage), which were the missing piece explaining
    // "why did this jump."
    const stageLabels = {};
    if (request.RequestType === 'PaymentRequest') {
      const rule = paymentRuleFor(request.Category);
      ['FM', 'OpsHead', 'Secretary', 'Treasurer', 'President'].forEach(key => {
        if (rule[PAYMENT_STAGE_REQUIRED_COL[key]] === 'Yes') stageLabels[key] = PAYMENT_STAGE_LABEL[key];
      });
    } else {
      const rule = rulesCache.find(r => r.RuleID === request.RuleID) || {};
      if (rule.AdministrativeApprover) stageLabels['Administrative'] = `Administrative — ${rule.AdministrativeApprover}`;
      if (rule.FinancialApprover) stageLabels['Financial'] = `Financial — ${rule.FinancialApprover}`;
      if (rule.ECApprovalRequired === 'Yes' || rule.ECApprovalRequired === 'Ratification') stageLabels['EC'] = 'EC Approval';
      if (rule.AGMApprovalRequired === 'Yes') stageLabels['AGM'] = 'AGM Approval';
    }
    stageLabels['Initiator'] = 'With Requester';

    const sortedApprovals = approvals.slice().sort((a, b) => (a.Timestamp || '').localeCompare(b.Timestamp || ''));
    const eventRowsHtml = sortedApprovals.map(a => {
      const label = stageLabels[a.Stage] || a.Stage;
      const icon = a.Decision === 'Approved' ? '✅' : a.Decision === 'SentBack' ? '🔁' : a.Decision === 'Resubmitted' ? '📤' : '❌';
      const color = a.Decision === 'Approved' ? 'green' : a.Decision === 'SentBack' ? '#8a6d00' : a.Decision === 'Resubmitted' ? '#185fa5' : '#b3261e';
      const verb = a.Decision === 'Resubmitted' ? 'Resubmitted by' : `${a.Decision} by`;
      return `<p style="margin:3px 0;color:${color};">${icon} ${escapeHtml(label)} — ${verb} ${escapeHtml(a.ApproverName)} on ${formatDate(a.Timestamp)}${a.Comment ? ` — "${escapeHtml(a.Comment)}"` : ''}</p>`;
    }).join('');

    // Whatever's currently pending, from the same state engine every
    // other view uses — guarantees this always matches reality rather
    // than being independently (and now correctly) re-derived here.
    const state = request.RequestType === 'PaymentRequest' ? computePaymentRequestState(request, approvals) : computeRequestState(request, approvals);
    // Bug found in testing: EC's running "X of Y" count is computed
    // (state.ecCount / state.quorum) but wasn't actually shown here — so
    // an EC-stage request just read as a flat "pending" no matter how
    // many of the required votes were already in, making it look stuck
    // even when it was correctly waiting on just one or two more people.
    const pendingHtml = (!state.rejected && !state.fullyApproved && state.stage)
      ? `<p class="muted" style="margin:3px 0;">⏳ ${escapeHtml(stageLabels[state.stage] || state.stage)}${state.stage === 'EC' ? ` (${state.ecCount} of ${state.quorum})` : ''} — pending</p>` : '';

    const stageRowsHtml = (eventRowsHtml || pendingHtml) ? (eventRowsHtml + pendingHtml) : '<p class="muted" style="margin:3px 0;">No approval stages required for this request.</p>';

    // Once Approved, the request moves into the Payments pipeline —
    // show that half of the journey too, same trail-style formatting.
    let paymentsTrailHtml = '';
    if (request.Status === 'Approved' && isSupersededByPaymentRequest(request)) {
      // See stageDescription's matching branch — this ATS's own checklist
      // never moves; the real disbursement happened off the linked
      // Payment Request instead.
      const linked = requestsCache.filter(p => p.RequestType === 'PaymentRequest' && p.LinkedSpendRequestID === request.RequestID);
      const paid = linked.find(p => p.DisbursementStage === 'Paid');
      const active = linked[0];
      paymentsTrailHtml = paid
        ? `<p style="margin:10px 0 3px;color:green;">✅ Paid via linked Payment Request ${escapeHtml(paid.RequestID)}${paid.PaymentRef ? ' — Ref: ' + escapeHtml(paid.PaymentRef) : ''}</p>`
        : active.Status !== 'Approved'
          ? `<p style="margin:10px 0 3px;color:#8a6d00;">⏳ Linked Payment Request ${escapeHtml(active.RequestID)} submitted — awaiting its own approvals</p>`
          : `<p style="margin:10px 0 3px;color:#8a6d00;">⏳ Payment in progress — see linked Payment Request ${escapeHtml(active.RequestID)}</p>`;
    } else if (request.Status === 'Approved' && !isPettyCashExpense(request)) {
      const stage = request.DisbursementStage;
      const steps = [
        { done: !!stage, label: 'Expense Sheet entry logged (Accountant)' },
        { done: stage === 'PendingPayment' || stage === 'Paid', label: 'Treasurer review' },
        { done: stage === 'Paid', label: `Payment released${request.PaymentRef ? ' — Ref: ' + escapeHtml(request.PaymentRef) : ''}` }
      ];
      paymentsTrailHtml = `
        <p style="margin:10px 0 3px;font-weight:600;">Payment release:</p>
        ${stage === 'NeedsCorrection' ? '<p style="margin:3px 0;color:#b3261e;">🔁 Sent back by Treasurer for correction — waiting on Accountant</p>' : ''}
        ${steps.map(s => `<p style="margin:3px 0;color:${s.done ? 'green' : 'inherit'};" class="${s.done ? '' : 'muted'}">${s.done ? '✅' : '⏳'} ${s.label}</p>`).join('')}`;
    } else if (isPettyCashExpense(request) && request.Status === 'Approved') {
      paymentsTrailHtml = `<p style="margin:10px 0 3px;color:green;">✅ Adjusted against Petty Cash Float — no separate payment release needed</p>`;
    }

    return `
      <div class="mvoa-list-item" style="margin:8px 0 0;background:var(--bg);">
        ${request.Description ? `<p style="margin:0 0 8px;">${escapeHtml(request.Description)}</p>` : ''}
        <p style="margin:0 0 3px;font-weight:600;">Approval trail:</p>
        ${stageRowsHtml}
        ${paymentsTrailHtml}
        ${attachmentLinksHtml(request) || '<p class="muted" style="margin:8px 0 0;">No attachments.</p>'}
      </div>`;
  }

  function displayStatus(request) {
    if (request.Status === 'Rejected') return statusBadge('Rejected', 'rejected');
    if (request.Status === 'Approved' && isPettyCashExpense(request)) return statusBadge('Settled — Petty Cash Float', 'paid');
    if (request.Status === 'Approved' && request.PaymentStatus === 'Paid') return statusBadge('Paid', 'paid');
    if (request.Status === 'Approved') return statusBadge(`Approved — awaiting payment${sinceText(request)}`, 'approved');
    return statusBadge(`Pending approval${sinceText(request)}`, 'pending');
  }

  // ───────────────────────────────────────────────────────────
  // MY APPROVALS — every decision THIS user has made (Approved or
  // Rejected), across every stage type (Administrative/Financial/EC/AGM
  // for Schedule A/B/C, FM/OpsHead/Secretary/Treasurer/President for
  // Schedule D), newest first. Read-only history — same visual language
  // as My Requests, but from the approver's side of the transaction.
  // ───────────────────────────────────────────────────────────
  async function renderMyApprovals(body, container, filterMode) {
    const user = MVOA.getUser();
    body.innerHTML = `<p class="muted">Loading your approval history…</p>`;
    let allApprovals = [];
    let allNotes = [];
    try {
      const [approvalRows, noteRows] = await Promise.all([
        MVOA.sheetsRead(TAB_APPROVALS),
        MVOA.sheetsRead(TAB_NOTES)
      ]);
      allApprovals = approvalRows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2));
      allNotes = noteRows.slice(1).map((r, i) => rowToObj(NOTE_COLS, r, i + 2));
    } catch (e) {
      body.innerHTML = `<p class="error-text">Could not load approval history: ${escapeHtml(e.message)}</p>`;
      return;
    }
    const mine = allApprovals.filter(a => a.ApproverName === user.name)
      .filter(a => {
        if (!filterMode) return true;
        const req = requestsCache.find(r => r.RequestID === a.RequestID);
        if (!req) return true; // don't hide history just because the request record can't be found
        return filterMode === 'spend' ? req.RequestType !== 'PaymentRequest' : req.RequestType === 'PaymentRequest';
      })
      .sort((a, b) => (b.Timestamp || '').localeCompare(a.Timestamp || ''));
    if (!mine.length) {
      body.innerHTML = `<p class="muted">You haven't approved or rejected anything yet.</p>`;
      return;
    }
    body.innerHTML = mine.map((a, i) => {
      const req = requestsCache.find(r => r.RequestID === a.RequestID);
      const ok = a.Decision === 'Approved';
      // Now uses the same shared NotesOpenedAt tracking as My Requests
      // and Approval Queue (see markNotesOpened/markNotesUnread) — was
      // previously a timestamp-comparison proxy that could never clear
      // once actually viewed. This is the real thing: clears the moment
      // anyone opens the thread, resets the moment a new note lands.
      const noteCount = allNotes.filter(n => n.RequestID === a.RequestID).length;
      return `
        <div class="mvoa-list-item">
          <div class="mvoa-row fin-myapproval-trail-toggle" data-idx="${i}" style="cursor:pointer;">
            <strong>${req ? escapeHtml(req.Category) + ' — ' + formatAmount(req.Amount) : escapeHtml(a.RequestID)}</strong>
            <span class="mvoa-badge" style="color:${ok ? '#0f6e56' : '#a32d2d'};background:${ok ? '#eaf5ef' : '#fbeaea'};" title="This is the specific decision YOU made — not necessarily the request's current stage, which may have moved on since.">${ok ? '✅' : '❌'} You ${a.Decision === 'Approved' ? 'approved' : a.Decision.toLowerCase()}: ${escapeHtml(a.Stage)}</span>
          </div>
          ${req && req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          <p class="muted" style="margin:4px 0;font-size:0.8rem;">${formatDate(a.Timestamp)}${req ? ' · Requested by ' + escapeHtml(req.RequestedBy) : ''}</p>
          ${a.Comment ? `<p style="margin:4px 0;">"${escapeHtml(a.Comment)}"</p>` : ''}
          ${req && hasUnreadNote(req, noteCount) ? `<p style="margin:4px 0;color:#b3261e;font-weight:600;">🆕 New note</p>` : ''}
          ${req ? `<button class="fin-myapproval-trail-toggle-btn btn-secondary" data-idx="${i}" style="font-size:0.8rem;padding:4px 10px;margin-top:6px;">🔍 View Details</button>` : ''}
          ${req ? notesButtonHtml(req, noteCount, 'fin-myapproval-notes-toggle', `data-idx="${i}" style="margin-top:6px;"`) : ''}
          <div class="fin-myapproval-trail-body hidden" data-idx="${i}"></div>
          <div class="fin-myapproval-notes-body hidden" data-idx="${i}"></div>
        </div>`;
    }).join('');

    function toggleTrail(idx) {
      const trailBody = body.querySelector(`.fin-myapproval-trail-body[data-idx="${idx}"]`);
      if (!trailBody) return;
      const isHidden = trailBody.classList.contains('hidden');
      if (!isHidden) { trailBody.classList.add('hidden'); return; }
      const a = mine[idx];
      const req = requestsCache.find(r => r.RequestID === a.RequestID);
      const approvals = allApprovals.filter(x => x.RequestID === a.RequestID);
      try {
        trailBody.innerHTML = req ? renderRequestTrailHtml(req, approvals) : '<p class="muted">Request no longer available.</p>';
      } catch (e) {
        trailBody.innerHTML = `<p class="error-text">Could not load the full trail: ${escapeHtml(e.message)}</p>`;
      }
      trailBody.classList.remove('hidden');
    }
    body.querySelectorAll('.fin-myapproval-trail-toggle, .fin-myapproval-trail-toggle-btn').forEach(el => {
      el.addEventListener('click', () => toggleTrail(el.dataset.idx));
    });
    // Bug found in testing: My Approvals had no way to see or add Notes —
    // an approver who acted on something earlier had no path back to a
    // question someone left later (e.g. Treasurer asking Secretary
    // something after Secretary's part was already done), since it's not
    // in their Approval Queue anymore and they didn't request it either.
    body.querySelectorAll('.fin-myapproval-notes-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = btn.dataset.idx;
        const notesBody = body.querySelector(`.fin-myapproval-notes-body[data-idx="${idx}"]`);
        const isHidden = notesBody.classList.contains('hidden');
        if (!isHidden) { notesBody.classList.add('hidden'); btn.textContent = '💬 Notes'; return; }
        notesBody.classList.remove('hidden');
        await renderNotesThread(notesBody, mine[idx].RequestID, btn, true, container);
      });
    });
  }

  async function renderMine(body, container, filterMode) {
    const user = MVOA.getUser();
    const list = requestsCache.filter(r => r.RequestedBy === user.name)
      .filter(r => !filterMode || (filterMode === 'spend' ? r.RequestType !== 'PaymentRequest' : r.RequestType === 'PaymentRequest'))
      .sort((a, b) => (b.RequestedDate || '').localeCompare(a.RequestedDate || ''));
    if (!list.length) {
      body.innerHTML = `<p class="muted">You haven't submitted any requests yet.</p>`;
      return;
    }
    body.innerHTML = `<p class="muted">Loading current status…</p>`;
    let allApprovals = [];
    let allNotes = [];
    try {
      const [approvalRows, noteRows] = await Promise.all([
        MVOA.sheetsRead(TAB_APPROVALS),
        MVOA.sheetsRead(TAB_NOTES)
      ]);
      allApprovals = approvalRows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2));
      allNotes = noteRows.slice(1).map((r, i) => rowToObj(NOTE_COLS, r, i + 2));
    } catch (e) { /* fall back to coarse status below if this fails */ }

    body.innerHTML = list.map(r => {
      if (isItemNew(r)) return newItemCardHtml(r, r.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(r.Vendor)}</p>` : '');
      const approvals = allApprovals.filter(a => a.RequestID === r.RequestID);
      const noteCount = allNotes.filter(n => n.RequestID === r.RequestID).length;
      let badge;
      try {
        badge = (allApprovals.length || r.Status !== 'PendingApproval') ? stageBadgeHtml(r, approvals) : displayStatus(r);
      } catch (e) {
        // A request whose RuleID no longer matches anything in
        // FinanceApprovalRules (e.g. an older test row from before the
        // rules sheet was rebuilt) shouldn't blank out its badge — fall
        // back to the coarse Status-only badge, which never depends on
        // rule lookups.
        badge = displayStatus(r);
      }
      return `
      <div class="mvoa-list-item" data-request-id="${escapeHtml(r.RequestID)}">
        <div class="mvoa-row fin-mine-trail-toggle" data-request-id="${escapeHtml(r.RequestID)}" style="cursor:pointer;">
          <strong>${escapeHtml(r.Category)} — ${formatAmount(r.Amount)}</strong>
          ${badge}
        </div>
        ${r.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(r.Vendor)}</p>` : ''}
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">Submitted ${formatDate(r.RequestedDate)}</p>
        ${paymentReferenceLineHtml(r)}
        ${r.Status === 'Rejected' ? rejectionDetailHtml(r, approvals) : ''}
        ${hasUnreadNote(r, noteCount) ? `<p style="margin:4px 0;color:#b3261e;font-weight:600;">🆕 New note</p>` : ''}
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="fin-mine-trail-toggle-btn btn-secondary" data-request-id="${escapeHtml(r.RequestID)}" style="font-size:0.8rem;padding:4px 10px;">🔍 View Details</button>
          ${notesButtonHtml(r, noteCount, 'fin-mine-notes-toggle', `data-request-id="${escapeHtml(r.RequestID)}"`)}
        </div>
        <div class="fin-mine-trail-body hidden" data-request-id="${escapeHtml(r.RequestID)}"></div>
        <div class="fin-mine-notes-body hidden" data-request-id="${escapeHtml(r.RequestID)}"></div>
      </div>
    `; }).join('');
    wireNewItemCards(body, () => render(container));

    function toggleTrail(id) {
      const trailBody = body.querySelector(`.fin-mine-trail-body[data-request-id="${id}"]`);
      const isHidden = trailBody.classList.contains('hidden');
      if (!isHidden) { trailBody.classList.add('hidden'); return; }
      const r = list.find(x => x.RequestID === id);
      const approvals = allApprovals.filter(a => a.RequestID === id);
      try {
        trailBody.innerHTML = renderRequestTrailHtml(r, approvals);
      } catch (e) {
        trailBody.innerHTML = `<p class="error-text">Could not load the full trail: ${escapeHtml(e.message)}</p>`;
      }
      trailBody.classList.remove('hidden');
    }
    body.querySelectorAll('.fin-mine-trail-toggle, .fin-mine-trail-toggle-btn').forEach(el => {
      el.addEventListener('click', () => toggleTrail(el.dataset.requestId));
    });

    body.querySelectorAll('.fin-mine-notes-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.requestId;
        const notesBody = body.querySelector(`.fin-mine-notes-body[data-request-id="${id}"]`);
        const isHidden = notesBody.classList.contains('hidden');
        if (!isHidden) { notesBody.classList.add('hidden'); btn.textContent = '💬 Notes'; return; }
        notesBody.classList.remove('hidden');
        await renderNotesThread(notesBody, id, btn, true, container);
      });
    });
  }

  async function renderNotesThread(notesBody, requestId, toggleBtn, canWrite, container, markOpened = true) {
    notesBody.innerHTML = `<p class="muted" style="font-size:0.8rem;padding:8px 0;">Loading notes…</p>`;
    let notes;
    try {
      const rows = await MVOA.sheetsRead(TAB_NOTES);
      notes = rows.slice(1).map((r, i) => rowToObj(NOTE_COLS, r, i + 2)).filter(n => n.RequestID === requestId);
    } catch (e) {
      notesBody.innerHTML = `<p class="error-text">Could not load notes: ${escapeHtml(e.message)}</p>`;
      return;
    }
    // Only mark opened on a genuine "someone viewed this" moment — NOT
    // on the recursive refresh right after posting a note (that call
    // passes markOpened=false), or the poster's own view would
    // immediately clear the flag before anyone else ever saw it.
    if (markOpened && notes.length) {
      await markNotesOpened(requestId);
      // Bug found in testing: the "My Approvals" nav badge only gets
      // recomputed inside loadAll() — opening a notes thread never
      // triggered that, so the badge count stayed stuck even after
      // every flagged item had been viewed. Patches just the badge's
      // DOM text directly (not a full render()), so it doesn't disrupt
      // the notes panel that was just opened.
      if (container) await refreshMyApprovalsBadge(container);
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
        setBtnBusy(submitBtn, 'Saving…');
        try {
          const user = MVOA.getUser();
          const existingIds = [];
          const noteId = MVOA.nextId('NOTE', existingIds);
          const row = { NoteID: noteId, RequestID: requestId, Author: user.name, Timestamp: new Date().toISOString(), Note: text };
          await MVOA.sheetsAppend(TAB_NOTES, objToRow(NOTE_COLS, row));
          await markNotesUnread(requestId);
          textarea.value = '';
          await renderNotesThread(notesBody, requestId, toggleBtn, canWrite, container, false);
        } catch (e) {
          errEl.textContent = 'Could not save note: ' + escapeHtml(e.message);
          clearBtnBusy(submitBtn, 'Add Note');
        }
      });
    }
  }

  // ───────────────────────────────────────────────────────────
  // APPROVAL QUEUE
  // ───────────────────────────────────────────────────────────
  async function renderQueue(body, container, filterMode) {
    // Uses the same queueCardsCache the nav-tab count reads (refreshed in
    // loadAll) so the count and this list can never disagree — see the
    // comment in loadAll for the bug this fixes. filterMode ('spend' |
    // 'payment') scopes this to whichever group's tab it was opened
    // from, since Approval Queue's underlying data spans both.
    const cards = !filterMode ? queueCardsCache
      : filterMode === 'spend' ? queueCardsCache.filter(c => c.req.RequestType !== 'PaymentRequest')
      : queueCardsCache.filter(c => c.req.RequestType === 'PaymentRequest');

    body.innerHTML = `
      <h3 style="color:var(--mvoa-blue);margin:0 0 8px;">Awaiting your action</h3>
      ${cards.length ? '' : '<p class="muted">Nothing waiting on you right now.</p>'}
      <div id="fin-queue-cards"></div>
      <p class="muted" style="margin-top:16px;">Once a request is fully approved, its actual payment release (Expense Sheet entry → Treasurer review → Disbursement Officer) happens in the <strong>₹ Payments</strong> tab, not here.</p>
    `;

    let allNotes = [];
    try {
      const noteRows = await MVOA.sheetsRead(TAB_NOTES);
      allNotes = noteRows.slice(1).map((r, i) => rowToObj(NOTE_COLS, r, i + 2));
    } catch (e) { /* notes flag just won't show if this fails, non-critical */ }

    const cardsEl = body.querySelector('#fin-queue-cards');
    const user = MVOA.getUser();
    const newCards = cards.filter(c => isItemNew(c.req));
    const openCards = cards.filter(c => !isItemNew(c.req));
    cardsEl.innerHTML = newCards.map(({ req, state }) =>
      newItemCardHtml(req, `<p class="muted" style="margin:4px 0;">${escapeHtml(state.stage)} approval${req.Vendor ? ' · To: ' + escapeHtml(req.Vendor) : ''}</p>${paymentReferenceLineHtml(req)}`)
    ).join('');
    wireNewItemCards(cardsEl, () => render(container));

    openCards.forEach(({ req, state, approvals }) => {
      const noteCount = allNotes.filter(n => n.RequestID === req.RequestID).length;
      // A stage can require MORE THAN ONE approver at once (e.g.
      // Administrative = "Secretary & President" — an AND requirement,
      // not either/or). Bug found in testing: after one of the two
      // approves, the stage correctly stays put awaiting the other, but
      // eligibility for the Approve button doesn't exclude someone who's
      // already voted — so that person sees the exact same card again
      // and clicking Approve a second time looks like nothing happened
      // (it's actually just recording a redundant duplicate vote). Now
      // shown as a clear "you already approved, waiting on X" notice
      // instead of a live Approve button once this user has a recorded
      // Approved decision at the CURRENT stage.
      const alreadyVoted = !!(state.stage && approvals.some(a => a.Stage === state.stage && a.Decision === 'Approved' && a.ApproverName === user.name));
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
        ${alreadyVoted ? `<p style="margin:4px 0;color:green;font-size:0.85rem;">✅ You've already approved this stage — waiting on the other required approver before it moves on.</p>` : ''}
        ${paymentReferenceLineHtml(req)}
        ${attachmentLinksHtml(req)}
        ${state.stage === 'EC' ? `<p class="muted" style="margin:4px 0;font-size:0.8rem;">${state.ecCount} of ${state.quorum} EC approvals so far</p>` : ''}
        ${hasUnreadNote(req, noteCount) ? `<p style="margin:4px 0;color:#b3261e;font-weight:600;">🆕 New note</p>` : ''}
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          ${alreadyVoted ? '' : `<button class="btn-primary fin-approve-btn" data-request-id="${escapeHtml(req.RequestID)}" data-stage="${escapeHtml(state.stage)}" style="margin:0;">Approve</button>`}
          <button class="btn-secondary fin-sendback-btn" data-request-id="${escapeHtml(req.RequestID)}" data-stage="${escapeHtml(state.stage)}" style="margin:0;">🔁 Send Back</button>
          ${state.stage !== 'AGM' ? `<button class="btn-secondary fin-reject-btn" data-request-id="${escapeHtml(req.RequestID)}" data-stage="${escapeHtml(state.stage)}" style="margin:0;">Reject</button>` : ''}
          ${notesButtonHtml(req, noteCount, 'fin-queue-notes-toggle', `data-request-id="${escapeHtml(req.RequestID)}"`)}
        </div>
        <p class="error-text fin-queue-error" data-request-id="${escapeHtml(req.RequestID)}" style="min-height:1em;margin-top:4px;"></p>
        <div class="fin-queue-notes-body hidden" data-request-id="${escapeHtml(req.RequestID)}"></div>
      `;
      cardsEl.appendChild(div);
    });

    // Bug found in testing: an AND-group stage (e.g. "Secretary &
    // President") stays put after only one of the two approves, so the
    // card can still be showing a live Approve button at the exact moment
    // the click is registered — a fast double-click (or a second click
    // fired before the first one's async round-trip finishes and
    // re-renders the queue) posted the SAME person's approval twice.
    // Harmless to the final outcome (the stage engine only needs one
    // qualifying approval per group — a duplicate for an already-satisfied
    // group changes nothing) but it's a confusing duplicate log entry and
    // pure waste. Uses the shared runOnce() (defined near formatAmount, so
    // every submission button in this module gets the same spinner/busy
    // treatment) — it disables the clicked button immediately, before the
    // async decide() call even starts, and only re-enables it if decide()
    // left the DOM alone — which is exactly what happens on failure (the
    // catch block in decide() never calls render()); on success, decide()
    // calls render(container), which rebuilds this whole card from fresh
    // data and detaches this exact button node, so there's nothing to
    // re-enable — a genuinely new button (or none, per the fresh
    // "alreadyVoted" state) takes its place.
    cardsEl.querySelectorAll('.fin-approve-btn').forEach(btn => {
      btn.addEventListener('click', () => runOnce(btn, 'Approving…', () => decide(btn.dataset.requestId, btn.dataset.stage, 'Approved', container)));
    });
    cardsEl.querySelectorAll('.fin-sendback-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const comment = prompt('Reason for sending this back one level (required) — e.g. "need one more quotation", "please clarify the invoice date":');
        if (comment && comment.trim()) runOnce(btn, 'Sending…', () => decide(btn.dataset.requestId, btn.dataset.stage, 'SentBack', container, comment.trim()));
      });
    });
    cardsEl.querySelectorAll('.fin-reject-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const comment = prompt('Reason for rejecting (required):');
        if (comment && comment.trim()) runOnce(btn, 'Rejecting…', () => decide(btn.dataset.requestId, btn.dataset.stage, 'Rejected', container, comment.trim()));
      });
    });
    cardsEl.querySelectorAll('.fin-queue-notes-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.requestId;
        const notesBody = cardsEl.querySelector(`.fin-queue-notes-body[data-request-id="${id}"]`);
        const isHidden = notesBody.classList.contains('hidden');
        if (!isHidden) { notesBody.classList.add('hidden'); btn.textContent = '💬 Ask a question'; return; }
        notesBody.classList.remove('hidden');
        await renderNotesThread(notesBody, id, btn, true, container);
      });
    });
  }

  function attachmentLinksHtml(r) {
    const urls = [r.AttachmentURL_1, r.AttachmentURL_2, r.AttachmentURL_3];
    const links = urls.filter(Boolean).map((url, i) => `<a href="${url}" target="_blank" rel="noopener">📎 Attachment ${i + 1}</a>`).join(' · ');
    return links ? `<p class="muted" style="font-size:0.8rem;">${links}</p>` : '';
  }

  // The linked Contract or Approval-to-Spend reference for a Payment
  // Request — shown wherever an approver or the requester reviews one, so
  // "does this payment actually have an approval to spend behind it?" is
  // visible instead of silently stored (ContractID/LinkedSpendRequestID
  // used to be write-only). A payment with neither is flagged, not
  // blocked — legacy agreements and Salaries/Utility/Petty Cash payments
  // legitimately have no such reference.
  function paymentReferenceLineHtml(req) {
    if (req.RequestType !== 'PaymentRequest') return '';
    if (req.ContractID) {
      const c = contractsCache.find(x => x.ContractID === req.ContractID);
      if (c) {
        return `<p style="margin:4px 0;font-size:0.8rem;">🔗 Contract: <strong>${escapeHtml(c.Vendor)}</strong> — ${escapeHtml(c.Nature || c.Category)} (${escapeHtml(c.ContractID)})${c.ApprovedRequestID ? ` — Approval to Spend: <strong>${escapeHtml(c.ApprovedRequestID)}</strong>` : ` — <span style="color:#b8860b;">legacy agreement, no system Approval to Spend on file</span>`}</p>`;
      }
    }
    if (req.LinkedSpendRequestID) {
      const r = requestsCache.find(x => x.RequestID === req.LinkedSpendRequestID);
      const overAmount = r && Number(req.Amount) > (Number(r.Amount) || 0);
      return `<p style="margin:4px 0;font-size:0.8rem;">🔗 Approval to Spend: <strong>${escapeHtml(req.LinkedSpendRequestID)}</strong>${r ? ` — ${escapeHtml(r.Category)} — ${escapeHtml(r.Vendor || '')} — ${formatAmount(r.Amount)} (approved ${formatDate(r.RequestedDate)})` : ''}</p>${
        overAmount ? `<p style="margin:4px 0;font-size:0.8rem;color:#b3261e;">⚠️ This payment (${formatAmount(req.Amount)}) exceeds the approved spend (${formatAmount(r.Amount)})${req.OverageJustification ? ` — <strong>Justification:</strong> ${escapeHtml(req.OverageJustification)}` : ' — no justification on file.'}</p>` : ''
      }`;
    }
    return `<p style="margin:4px 0;font-size:0.8rem;color:#b3261e;">⚠️ No linked Contract or Approval to Spend on file.</p>`;
  }

  // Picks the right stage engine by RequestType — Schedule A/B/C spend
  // requests vs Schedule D Payment Requests use genuinely different
  // engines (see computePaymentRequestState comment).
  function computeAnyRequestState(req, approvals) {
    return req.RequestType === 'PaymentRequest' ? computePaymentRequestState(req, approvals) : computeRequestState(req, approvals);
  }

  async function decide(requestId, stage, decision, container, comment) {
    const user = MVOA.getUser();
    const errEl = document.querySelector(`.fin-queue-error[data-request-id="${requestId}"]`);
    let justApprovedForContractPrompt = null;
    try {
      const req = requestsCache.find(r => r.RequestID === requestId);
      const priorApprovals = await loadApprovalsFor(requestId, true); // BEFORE this decision is appended, for stage comparison below
      const priorState = computeAnyRequestState(req, priorApprovals);

      const approvalId = await nextApprovalId();
      const row = {
        ApprovalID: approvalId, RequestID: requestId, ApproverName: user.name, ApproverRole: user.role || '',
        Stage: stage, Decision: decision, Comment: comment || '', Timestamp: new Date().toISOString()
      };
      await MVOA.sheetsAppend(TAB_APPROVALS, objToRow(APPROVAL_COLS, row));

      let resultingStatus = req.Status;
      const now = new Date().toISOString();
      if (decision === 'Rejected') {
        const updated = Object.assign({}, req, { Status: 'Rejected', ClosedDate: now, ClosedBy: user.name, StageEnteredAt: now, StageOpenedAt: '' });
        await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
        resultingStatus = 'Rejected';
      } else {
        const freshApprovals = await loadApprovalsFor(requestId, true);
        const state = computeAnyRequestState(req, freshApprovals);
        if (state.fullyApproved) {
          // Now entering the payment-release chain — DisbursementStage starts
          // blank (Accountant's "needs an Expense Sheet entry" queue), and
          // StageEnteredAt marks the moment of full approval.
          const updated = Object.assign({}, req, { Status: 'Approved', ECApprovalCount: state.ecCount, StageEnteredAt: now, StageOpenedAt: '' });
          await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
          resultingStatus = 'Approved';
          // Offer to register this as a contract so future payments can
          // reference it (Schedule B/C annual agreements) — skipped for
          // Payment Requests (nothing new to register, they pay AGAINST
          // an existing agreement) and Petty Cash (its own dedicated
          // float mechanism, no contract concept). Deliberately asked for
          // every OTHER approval rather than trying to guess which
          // categories are "recurring commitments" vs one-time
          // purchases — a one-time buy just gets a quick Cancel.
          if (req.RequestType !== 'PaymentRequest' && req.Category !== 'Petty Cash') {
            justApprovedForContractPrompt = { Category: req.Category, Vendor: req.Vendor, RequestID: req.RequestID };
          }
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
          const updated = Object.assign({}, req, { StageEnteredAt: now, StageOpenedAt: '' });
          await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
          resultingStatus = `PendingApproval (next: ${state.stage})`;
        }
      }
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: `${stage} ${decision}`, comment: comment || '', statusAfter: resultingStatus });
      await loadAll(true);
      render(container);
      if (justApprovedForContractPrompt) {
        const p = justApprovedForContractPrompt;
        const wantsContract = confirm(`"${p.Category}" for ${p.Vendor || 'this vendor'} is now fully approved. Register it as a contract so future payments can reference it? (Choose Cancel for a one-time purchase.)`);
        if (wantsContract) {
          contractFormPrefill = { Category: p.Category, Vendor: p.Vendor, ApprovedRequestID: p.RequestID };
          currentTopTab = 'contracts';
          currentView = 'contracts';
          contractsSubView = 'form';
          render(container);
        }
      }
    } catch (e) {
      if (errEl) errEl.textContent = 'Could not save decision: ' + e.message;
    }
  }

  // Requester's action once a request lands back at 'Initiator' (see
  // walkStageChain) — logs a Resubmitted event that moves the pointer
  // forward to the first stage again. Doesn't attempt to support
  // editing the request's fields/attachments in-place; the requester is
  // expected to have already addressed the reason (visible via the
  // Notes thread or the sent-back comment itself) before resubmitting.
  async function resubmitRequest(requestId, container, errElSelector, newDescription, newAttachments) {
    const errEl = errElSelector ? document.querySelector(errElSelector) : null;
    try {
      const req = requestsCache.find(r => r.RequestID === requestId);
      if (!req) return;
      const user = MVOA.getUser();
      // Upload any newly-added attachment(s) into whichever
      // AttachmentURL slot(s) are still empty — never overwrites an
      // existing one, only fills gaps.
      const slots = ['AttachmentURL_1', 'AttachmentURL_2', 'AttachmentURL_3'];
      const emptySlots = slots.filter(s => !req[s]);
      const uploads = (newAttachments || []).slice(0, emptySlots.length);
      const attachmentUpdates = {};
      for (let i = 0; i < uploads.length; i++) {
        const att = uploads[i];
        attachmentUpdates[emptySlots[i]] = await MVOA.uploadPhotoToDrive(att.file, `${requestId}_resubmit${i+1}_${att.name}`);
      }
      const approvalId = await nextApprovalId();
      const row = {
        ApprovalID: approvalId, RequestID: requestId, ApproverName: user.name, ApproverRole: user.role || '',
        Stage: 'Initiator', Decision: 'Resubmitted', Comment: '', Timestamp: new Date().toISOString()
      };
      await MVOA.sheetsAppend(TAB_APPROVALS, objToRow(APPROVAL_COLS, row));
      const now = new Date().toISOString();
      const updated = Object.assign({}, req,
        { StageEnteredAt: now, StageOpenedAt: '' },
        newDescription !== undefined ? { Description: newDescription } : {},
        attachmentUpdates);
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updated));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Resubmitted', comment: '', statusAfter: 'PendingApproval' });
      await loadAll(true);
      render(container);
    } catch (e) {
      if (errEl) errEl.textContent = 'Could not resubmit: ' + e.message;
    }
  }

  // ───────────────────────────────────────────────────────────
  // SENT BACK — items currently sitting at 'Initiator' (see
  // walkStageChain/decide's Send Back action), scoped to the current
  // user's own requests, with a Resubmit action. filterMode ('spend' |
  // 'payment') mirrors the Approval Queue split.
  // ───────────────────────────────────────────────────────────
  async function renderSentBack(body, container, filterMode) {
    const user = MVOA.getUser();
    body.innerHTML = `<p class="muted">Loading…</p>`;
    let allApprovals = [];
    try {
      const rows = await MVOA.sheetsRead(TAB_APPROVALS);
      allApprovals = rows.slice(1).map((r, i) => rowToObj(APPROVAL_COLS, r, i + 2));
    } catch (e) {
      body.innerHTML = `<p class="error-text">Could not load: ${escapeHtml(e.message)}</p>`;
      return;
    }
    const candidates = requestsCache.filter(r => r.RequestedBy === user.name && r.Status === 'PendingApproval')
      .filter(r => filterMode === 'spend' ? r.RequestType !== 'PaymentRequest' : r.RequestType === 'PaymentRequest');
    const sentBack = candidates.map(r => {
      const approvals = allApprovals.filter(a => a.RequestID === r.RequestID);
      const state = computeAnyRequestState(r, approvals);
      return { r, state };
    }).filter(x => x.state.stage === 'Initiator');

    if (!sentBack.length) {
      body.innerHTML = `<p class="muted">Nothing sent back to you right now.</p>`;
      return;
    }
    // Bug/gap found in testing: newly-sent-back items weren't marked
    // "New" at all — StageEnteredAt/StageOpenedAt already get reset
    // correctly on Send Back (see decide()), same shared mechanism used
    // everywhere else in this app, but this tab just wasn't USING it.
    // Now split the same way Approval Queue/Payments already do: a
    // condensed "🆕 New — tap to open" card until opened, then the full
    // edit-and-resubmit form.
    const newOnes = sentBack.filter(x => isItemNew(x.r));
    const openOnes = sentBack.filter(x => !isItemNew(x.r));
    const newCardsHtml = newOnes.map(({ r, state }) => newItemCardHtml(r,
      `<p class="muted" style="margin:4px 0;">${state.sentBackAt && state.sentBackAt.Comment ? `"${escapeHtml(state.sentBackAt.Comment)}"` : 'No reason given.'}</p>`
    )).join('');
    // Bug/gap found in testing: the previous version was a bare
    // "Resubmit" button with no way to actually act on the reason given
    // — the requester could see "need one more quotation" but had no
    // way to add it. Now shows the current Description (editable) and
    // existing attachments, with room to add more (up to the 3-slot
    // cap) before resubmitting. Doesn't support REMOVING an old
    // attachment or changing Amount/Vendor — editing those still needs
    // the Notes thread; this covers the two most common corrections
    // (clarify the description, attach one more document).
    const openCardsHtml = openOnes.map(({ r, state }) => {
      const existingAttachments = [r.AttachmentURL_1, r.AttachmentURL_2, r.AttachmentURL_3].filter(Boolean);
      return `
      <div class="mvoa-list-item" style="border:1px solid #b3261e;">
        <div class="mvoa-row">
          <strong>${escapeHtml(r.Category)} — ${formatAmount(r.Amount)}</strong>
          <span class="mvoa-badge" style="color:#b3261e;background:#fbeaea;">🔁 Sent back</span>
        </div>
        ${r.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(r.Vendor)}</p>` : ''}
        <p style="margin:4px 0;color:#b3261e;">${state.sentBackAt && state.sentBackAt.Comment ? `"${escapeHtml(state.sentBackAt.Comment)}"` : 'No reason given.'}</p>
        <p class="muted" style="margin:4px 0;font-size:0.8rem;">By ${state.sentBackAt ? escapeHtml(state.sentBackAt.ApproverName) : 'unknown'}${state.sentBackAt ? ' · ' + formatDate(state.sentBackAt.Timestamp) : ''}</p>
        <label style="margin-top:8px;">Description
          <textarea class="fin-sb-desc" data-request-id="${escapeHtml(r.RequestID)}" rows="2">${escapeHtml(r.Description || '')}</textarea>
        </label>
        ${existingAttachments.length ? `<p class="muted" style="margin:6px 0 2px;">Existing attachments: ${existingAttachments.map((u, i) => `<a href="${u}" target="_blank" rel="noopener">📎 ${i+1}</a>`).join(' · ')}</p>` : ''}
        ${existingAttachments.length < 3 ? `
          <p class="muted" style="margin:6px 0 2px;">Add another attachment (optional):</p>
          <div class="fin-sb-attachment-chips" data-request-id="${escapeHtml(r.RequestID)}"></div>
          <div class="fin-sb-attachment-btns" data-request-id="${escapeHtml(r.RequestID)}" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;"></div>
        ` : ''}
        <div style="margin-top:10px;">
          <button class="btn-primary fin-resubmit-btn" data-request-id="${escapeHtml(r.RequestID)}" style="margin:0;">Resubmit</button>
        </div>
        <p class="error-text fin-resubmit-error" data-request-id="${escapeHtml(r.RequestID)}" style="min-height:1em;margin-top:4px;"></p>
      </div>`;
    }).join('');
    body.innerHTML = newCardsHtml + openCardsHtml;
    wireNewItemCards(body, () => render(container));
    // One pending-new-attachments array per sent-back card, keyed by
    // RequestID, so multiple cards on screen at once don't collide.
    sentBackPendingAttachments = {};
    openOnes.forEach(({ r }) => {
      const existingCount = [r.AttachmentURL_1, r.AttachmentURL_2, r.AttachmentURL_3].filter(Boolean).length;
      if (existingCount >= 3) return;
      sentBackPendingAttachments[r.RequestID] = [];
      renderDocAttachmentPicker(body,
        `.fin-sb-attachment-chips[data-request-id="${r.RequestID}"]`,
        `.fin-sb-attachment-btns[data-request-id="${r.RequestID}"]`,
        sentBackPendingAttachments[r.RequestID], [], 3 - existingCount);
    });
    body.querySelectorAll('.fin-resubmit-btn').forEach(btn => {
      const id = btn.dataset.requestId;
      btn.addEventListener('click', () => runOnce(btn, 'Resubmitting…', () => {
        const descEl = body.querySelector(`.fin-sb-desc[data-request-id="${id}"]`);
        const newDesc = descEl ? descEl.value.trim() : undefined;
        const newAttachments = sentBackPendingAttachments[id] || [];
        return resubmitRequest(id, container, `.fin-resubmit-error[data-request-id="${id}"]`, newDesc, newAttachments);
      }));
    });
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
      DisbursementStage: 'Paid', ClosedDate: now, ClosedBy: user.name, StageEnteredAt: now, StageOpenedAt: ''
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
  function isSecretaryPerson(person) {
    return roleMatchesToken(person, 'secretary');
  }

  function currentPerson() {
    const user = MVOA.getUser();
    return rolesCache.find(p => p.Name === user.name) || { Name: user.name, Role: user.role, Title: user.title };
  }

  // Bug found in testing: the "Payments" nav-tab count used to tally EVERY
  // request sitting anywhere in the payment pipeline, regardless of which
  // stage — but Accountant/Treasurer/Disbursement Officer each only see
  // their OWN stage's section in the tab itself. A Treasurer could see
  // "(2 open · 1 new)" while "Awaiting your review" was correctly empty,
  // because those 2 were still sitting at the Accountant's stage. This
  // returns exactly the set of requests THIS role can actually see across
  // the sections rendered in renderPayments, so the badge can't disagree
  // with the tab's own content again.
  function paymentsVisibleForCurrentUser() {
    const person = currentPerson();
    const isAcct = isAccountantPerson(person);
    const isTres = isTreasurerPerson(person);
    const isDisb = isDisbursementOfficerPerson(person);
    const isAdminUser = isAdmin(person);
    const seen = new Set();
    const list = [];
    const add = (arr) => arr.forEach(r => { if (!seen.has(r.RequestID)) { seen.add(r.RequestID); list.push(r); } });
    if (isAcct || isAdminUser) {
      add(requestsCache.filter(r => r.Status === 'Approved' && !r.DisbursementStage && !isPettyCashExpense(r) && !isSupersededByPaymentRequest(r)));
      add(requestsCache.filter(r => r.DisbursementStage === 'NeedsCorrection'));
    }
    if (isTres || isAdminUser) add(requestsCache.filter(r => r.DisbursementStage === 'PendingTreasurer'));
    if (isDisb || isAdminUser) add(requestsCache.filter(r => r.DisbursementStage === 'PendingPayment'));
    return list;
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

  async function renderPayments(body, container) {
    const person = currentPerson();
    const isAcct = isAccountantPerson(person);
    const isTres = isTreasurerPerson(person);
    const isDisb = isDisbursementOfficerPerson(person);
    const isAdminUser = isAdmin(person);

    if (!isAcct && !isTres && !isDisb && !isAdminUser) {
      body.innerHTML = `<p class="muted">Payment release (Expense Sheet entry, Treasurer review, Disbursement) is handled by the Accountant, Treasurer and Disbursement Officer. You don't have any actions here.</p>`;
      return;
    }

    const needsExpenseEntry = requestsCache.filter(r => r.Status === 'Approved' && !r.DisbursementStage && !isPettyCashExpense(r) && !isSupersededByPaymentRequest(r));
    const needsCorrection = requestsCache.filter(r => r.DisbursementStage === 'NeedsCorrection');
    const pendingTreasurer = requestsCache.filter(r => r.DisbursementStage === 'PendingTreasurer');
    const pendingPayment = requestsCache.filter(r => r.DisbursementStage === 'PendingPayment');
    const paid = requestsCache.filter(r => r.DisbursementStage === 'Paid')
      .sort((a, b) => (b.ClosedDate || '').localeCompare(a.ClosedDate || '')).slice(0, 10);
    body.innerHTML = `<p class="muted">Loading…</p>`;
    // Gap found in testing: "Sent back for correction" was the one
    // section in the whole app without a new-note flag — its Treasurer
    // query IS a Notes-thread entry same as everywhere else, it just
    // wasn't showing the flag proactively (only once opened). Bulk
    // fetch once here, reused by that section below.
    let allNotes = [];
    try {
      const noteRows = await MVOA.sheetsRead(TAB_NOTES);
      allNotes = noteRows.slice(1).map((r, i) => rowToObj(NOTE_COLS, r, i + 2));
    } catch (e) { /* flag just won't show if this fails, non-critical */ }

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

    // Bug found in testing: the "Log Expense Entry" button used to
    // stretch to fill whatever space was left in the row after the
    // category/amount text — so its width varied card to card depending
    // on how long that text was, instead of staying a uniform size, and
    // in the process squeezed how much room the text itself actually got.
    // Explicitly stopping the right-hand side from growing (flex:0 0
    // auto) fixes both at once: every button/badge now sizes to its own
    // content only (uniform across cards, since the button text is
    // identical every time), and the left text — now the only flexible
    // side — gets first claim on the row's width.
    function baseCard(req, extraRight) {
      return `
        <div class="mvoa-list-item" data-request-id="${escapeHtml(req.RequestID)}">
          <div class="mvoa-row" style="display:flex;align-items:center;gap:10px;">
            <strong style="flex:1 1 auto;min-width:0;">${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
            <span style="flex:0 0 auto;">${extraRight || ''}</span>
          </div>
          ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          <p class="muted" style="margin:4px 0;font-size:0.8rem;">Requested by ${escapeHtml(req.RequestedBy)} · ${formatDate(req.RequestedDate)}</p>
        </div>`;
    }
    const refreshPayments = () => render(container);

    // Bug found in testing: each block below only checked whether its
    // list had items — not whether the template actually created that
    // section's div for THIS role. A Treasurer-only user has no
    // #fin-pay-needentry div (that's Accountant/Admin-only), but if
    // needsExpenseEntry.length was truthy, this crashed trying to write
    // into a div that never existed — and since that happens at the very
    // top of the function, it silently killed everything after it too,
    // including the Treasurer's own "Awaiting your review" section. Every
    // guard below now matches the exact role condition used when building
    // the template, so a role that can't see a section never touches it.
    if ((isAcct || isAdminUser) && needsExpenseEntry.length) {
      const el = body.querySelector('#fin-pay-needentry');
      const [newOnes, openOnes] = [needsExpenseEntry.filter(isItemNew), needsExpenseEntry.filter(r => !isItemNew(r))];
      el.innerHTML = newOnes.map(req => newItemCardHtml(req, req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : '')).join('')
        + openOnes.map(req => baseCard(req,
          `<button class="btn-primary fin-log-entry-btn" data-request-id="${escapeHtml(req.RequestID)}" style="margin:0;">Log Expense Entry</button>`
        )).join('');
      wireNewItemCards(el, refreshPayments);
      el.querySelectorAll('.fin-log-entry-btn').forEach(btn => {
        btn.addEventListener('click', () => openExpenseEntryDialog(btn.dataset.requestId, container, false));
      });
    }
    if ((isAcct || isAdminUser) && needsCorrection.length) {
      const el = body.querySelector('#fin-pay-correction');
      const [newOnes, openOnes] = [needsCorrection.filter(isItemNew), needsCorrection.filter(r => !isItemNew(r))];
      el.innerHTML = newOnes.map(req => newItemCardHtml(req)).join('') + openOnes.map(req => {
        const noteCount = allNotes.filter(n => n.RequestID === req.RequestID).length;
        return `
        <div class="mvoa-list-item" data-request-id="${escapeHtml(req.RequestID)}">
          <div class="mvoa-row">
            <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
            <span class="mvoa-badge" style="color:#a32d2d;background:#fbeaea;">Needs correction</span>
          </div>
          ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          ${hasUnreadNote(req, noteCount) ? `<p style="margin:4px 0;color:#b3261e;font-weight:600;">🆕 New note</p>` : ''}
          ${notesButtonHtml(req, noteCount, 'fin-corr-notes-toggle', `data-request-id="${escapeHtml(req.RequestID)}" style="margin:6px 6px 0 0;"`)}
          <button class="btn-primary fin-edit-entry-btn" data-request-id="${escapeHtml(req.RequestID)}" style="font-size:0.8rem;padding:4px 10px;margin:6px 0 0 0;">Edit &amp; Resubmit</button>
          <div class="fin-corr-notes-body hidden" data-request-id="${escapeHtml(req.RequestID)}"></div>
        </div>`;
      }).join('');
      wireNewItemCards(el, refreshPayments);
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
          await renderNotesThread(notesBody, id, btn, true, container);
        });
      });
    }
    if ((isTres || isAdminUser) && pendingTreasurer.length) {
      const el = body.querySelector('#fin-pay-treasurer');
      // Wrapped in try/catch — previously, if anything in here threw, the
      // section stayed silently blank (badge still said "1 new" with
      // nothing visible to act on, no error shown). Now at minimum an
      // error message appears instead of nothing.
      try {
        const [newOnes, openOnes] = [pendingTreasurer.filter(isItemNew), pendingTreasurer.filter(r => !isItemNew(r))];
        el.innerHTML = newOnes.map(req => newItemCardHtml(req, req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : '')).join('');
        wireNewItemCards(el, refreshPayments);
        openOnes.forEach(async req => {
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
              <span class="mvoa-badge" style="color:#8a6d00;background:#fdf1cf;">Awaiting review</span>
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
          div.querySelector('.fin-treasurer-approve-btn').addEventListener('click', e => runOnce(e.currentTarget, 'Approving…', () => treasurerApprove(req.RequestID, container)));
          div.querySelector('.fin-treasurer-sendback-btn').addEventListener('click', e => {
            const q = prompt('What needs to be corrected? (this will be sent to the Accountant)');
            if (q && q.trim()) runOnce(e.currentTarget, 'Sending…', () => treasurerSendBack(req.RequestID, q.trim(), container));
          });
        });
      } catch (e) {
        el.innerHTML = `<p class="error-text">Could not display items awaiting review: ${escapeHtml(e.message)}. Try ↻ Refresh, or open the browser console for details.</p>`;
      }
    }
    if ((isDisb || isAdminUser) && pendingPayment.length) {
      const el = body.querySelector('#fin-pay-disburse');
      const [newOnes, openOnes] = [pendingPayment.filter(isItemNew), pendingPayment.filter(r => !isItemNew(r))];
      el.innerHTML = newOnes.map(req => newItemCardHtml(req, req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : '')).join('')
        + openOnes.map(req => `
        <div class="mvoa-list-item" data-request-id="${escapeHtml(req.RequestID)}">
          <div class="mvoa-row">
            <strong>${escapeHtml(req.Category)} — ${formatAmount(req.Amount)}</strong>
            <span class="mvoa-badge" style="color:#0f6e56;background:#eaf5ef;">Treasurer approved</span>
          </div>
          ${req.Vendor ? `<p class="muted" style="margin:4px 0;">To: ${escapeHtml(req.Vendor)}</p>` : ''}
          <div style="margin-top:8px;">
            <select class="fin-bank-select" data-request-id="${escapeHtml(req.RequestID)}" style="width:100%;margin-bottom:6px;">
              <option value="">— Select Bank —</option>
              <option value="HDFC">HDFC</option>
              <option value="IOB">IOB</option>
            </select>
            <input type="text" class="fin-ud-number" data-request-id="${escapeHtml(req.RequestID)}" placeholder="UD Number / Cheque / UTR" style="width:100%;margin-bottom:6px;">
            <button class="btn-primary fin-disburse-btn" data-request-id="${escapeHtml(req.RequestID)}" style="margin:0;">Release Payment</button>
          </div>
          <p class="error-text fin-disburse-error" data-request-id="${escapeHtml(req.RequestID)}" style="min-height:1em;margin-top:4px;"></p>
        </div>`).join('');
      wireNewItemCards(el, refreshPayments);
      el.querySelectorAll('.fin-disburse-btn').forEach(btn => {
        btn.addEventListener('click', () => runOnce(btn, 'Releasing…', () => disbursePayment(btn.dataset.requestId, el, container)));
      });
    }
    if (paid.length) {
      const el = body.querySelector('#fin-pay-recent');
      el.innerHTML = paid.map(req => baseCard(req,
        `<span class="mvoa-badge" style="color:#185fa5;background:#e6f1fb;">Paid ${req.PaymentRef ? '· ' + escapeHtml(req.PaymentRef) : ''}</span>`
      )).join('');
    }
  }

  // ─── Accountant: Log / Edit Expense Sheet entry ───────────────
  function openExpenseEntryDialog(requestId, container, isCorrection) {
    const req = requestsCache.find(r => r.RequestID === requestId);
    if (!req) return;
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `<div class="ops-qr-box" style="text-align:left;max-height:85vh;overflow-y:auto;-webkit-overflow-scrolling:touch;"><p class="muted">Loading…</p></div>`;
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
        <style>
          /* Hides the native up/down stepper on TDS Rate (%) — a percentage
             typed once doesn't benefit from click-to-increment, and it was
             easy to bump by mistake. */
          .fin-no-spinner::-webkit-outer-spin-button,
          .fin-no-spinner::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
          .fin-no-spinner { -moz-appearance: textfield; }
        </style>
        <button id="fin-exp-cancel-top" class="btn-secondary" style="position:sticky;top:0;float:right;z-index:1;">✕ Close</button>
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
        <label>TDS Rate (%) <input id="fin-exp-tdsrate" class="fin-no-spinner" type="number" min="0" value="${escapeHtml(e.TDSRate || 0)}"></label>
        <label>TDS (₹) <input id="fin-exp-tds" type="number" min="0" value="${escapeHtml(e.TDS || 0)}"></label>
        <p class="muted" id="fin-exp-tds-note" style="margin:-6px 0 0;font-size:0.8rem;"></p>
        <label>Less / Add (₹, +/-) <input id="fin-exp-lessadd" type="number" value="${escapeHtml(e.LessAdd || 0)}"></label>
        <label>Net Amount (₹) <input id="fin-exp-net" type="number" min="0" readonly style="background:#eee;" value="${escapeHtml(e.NetAmount || '')}"></label>
        <button id="fin-exp-save" class="btn-primary" style="margin-top:10px;">${isCorrection ? 'Resubmit to Treasurer' : 'Save &amp; Send to Treasurer'}</button>
        <button id="fin-exp-cancel" class="btn-secondary">Cancel</button>
        <p class="error-text" id="fin-exp-error"></p>
      `;
      box.querySelector('#fin-exp-cancel-top').addEventListener('click', () => modal.remove());
      box.querySelector('#fin-exp-cancel').addEventListener('click', () => modal.remove());
      box.querySelector('#fin-exp-save').addEventListener('click', () => saveExpenseEntry(req, modal, container, isCorrection, existing));

      // Live TDS / Net Amount calculation. TDS (₹) is auto-derived ONLY
      // when GST Applicable = Yes — the Gross Amount is GST-inclusive in
      // that case, so TDS is computed on the pre-GST base (Gross / 1.18),
      // not on the GST-inclusive figure — and becomes read-only so it
      // can't drift out of sync with that formula by manual edit. When
      // GST = No, TDS (₹) goes back to a plain manual entry (no reliable
      // base to derive it from). Net Amount = Gross − TDS(₹) − Less/Add
      // is unconditional and always read-only, per explicit instruction.
      const grossEl = box.querySelector('#fin-exp-gross');
      const gstEl = box.querySelector('#fin-exp-gst');
      const tdsRateEl = box.querySelector('#fin-exp-tdsrate');
      const tdsEl = box.querySelector('#fin-exp-tds');
      const lessAddEl = box.querySelector('#fin-exp-lessadd');
      const netEl = box.querySelector('#fin-exp-net');
      const tdsNoteEl = box.querySelector('#fin-exp-tds-note');
      const round2 = n => Math.round(Number(n) || 0);
      function recalc() {
        const gross = Number(grossEl.value) || 0;
        const gstApplicable = gstEl.value === 'Yes';
        if (gstApplicable) {
          const baseAmount = gross / 1.18; // Gross Amount is GST-inclusive — TDS applies to the pre-GST base
          tdsEl.value = round2(baseAmount * (Number(tdsRateEl.value) || 0) / 100);
          tdsEl.readOnly = true;
          tdsEl.style.background = '#eee';
          tdsNoteEl.textContent = 'Auto-calculated: (Gross ÷ 1.18) × TDS Rate — GST Applicable is Yes.';
        } else {
          tdsEl.readOnly = false;
          tdsEl.style.background = '';
          tdsNoteEl.textContent = '';
        }
        netEl.value = round2(gross - (Number(tdsEl.value) || 0) - (Number(lessAddEl.value) || 0));
      }
      [grossEl, tdsRateEl, tdsEl, lessAddEl].forEach(el => el.addEventListener('input', recalc));
      gstEl.addEventListener('change', recalc);
      recalc();
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
    setBtnBusy(saveBtn, 'Saving…');

    const tabName = isCorrection ? req.ExpenseTab : val('#fin-exp-tab');
    // "Passed By" records the Accountant who logged (or re-logged, after a
    // correction) this Expense Sheet entry — refreshed on every save by
    // the Accountant. "Approved By" is a separate sign-off, populated only
    // when the Treasurer approves it (see treasurerApprove below).
    const preparer = MVOA.getUser();
    const passedByStamp = `${preparer.name} · ${new Date().toLocaleDateString()}`;
    const entryRow = {
      RequestID: req.RequestID,
      SlNo: (existing && existing.row.SlNo) || '',
      Vendor: vendor, InvoiceDate: val('#fin-exp-invdate'), InvoiceNumber: val('#fin-exp-invno'),
      InvoicePeriodPurpose: val('#fin-exp-purpose'), Period: val('#fin-exp-period'),
      GrossAmount: gross, GST: val('#fin-exp-gst'), TDSRate: Number(val('#fin-exp-tdsrate')) || 0,
      TDS: Number(val('#fin-exp-tds')) || 0, LessAdd: Number(val('#fin-exp-lessadd')) || 0,
      NetAmount: Number(val('#fin-exp-net')) || gross,
      NelsonCheck: (existing && existing.row.NelsonCheck) || '', LakshmanCheck: (existing && existing.row.LakshmanCheck) || '',
      ApprovedBy: (existing && existing.row.ApprovedBy) || '', PassedBy: passedByStamp, UDNumber: '', Date: ''
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
        StageEnteredAt: new Date().toISOString(), StageOpenedAt: ''
      });
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updatedReq));
      await MVOA.logAudit({ module: 'Finance', requestId: req.RequestID, eventType: isCorrection ? 'Expense entry resubmitted' : 'Expense entry logged', comment: '', statusAfter: 'PendingTreasurer' });
      modal.remove();
      await loadAll(true);
      render(container);
    } catch (err) {
      errEl.textContent = 'Could not save: ' + err.message;
      clearBtnBusy(saveBtn, isCorrection ? 'Resubmit to Treasurer' : 'Save & Send to Treasurer');
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
      // Treasurer's approval of the Expense Sheet entry auto-populates
      // "Approved By" — "Passed By" (the Accountant who logged the entry)
      // is left untouched here.
      const approvalStamp = `${user.name} · ${new Date().toLocaleDateString()}`;
      const updatedEntry = Object.assign({}, entry.row, { ApprovedBy: approvalStamp });
      await MVOA.sheetsUpdateRow(req.ExpenseTab, entry.rowNumber, objToRow(EXPENSE_COLS, updatedEntry));
      const updatedReq = Object.assign({}, req, { DisbursementStage: 'PendingPayment', ExpenseRow: entry.rowNumber, StageEnteredAt: new Date().toISOString(), StageOpenedAt: '' });
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updatedReq));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Treasurer approved', comment: '', statusAfter: 'PendingPayment' });
      await loadAll(true);
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
    // Bug found in testing: a failed attempt (e.g. a network timeout)
    // left its error text sitting in this element — clicking the button
    // again to retry ran a genuinely new attempt, but with no visible
    // change until it either succeeded (full re-render replaces
    // everything, including this text) or failed again with the exact
    // same message, it looked indistinguishable from "nothing happened."
    // Clearing it here, right before the retry actually starts, makes a
    // fresh attempt visibly distinct from a stale leftover error.
    if (errEl) errEl.textContent = 'Sending…';
    try {
      const existingNoteIds = [];
      const noteId = MVOA.nextId('FNOTE', existingNoteIds);
      await MVOA.sheetsAppend(TAB_NOTES, objToRow(NOTE_COLS, {
        NoteID: noteId, RequestID: requestId, Author: user.name, Timestamp: new Date().toISOString(),
        Note: '⚠️ Sent back for correction: ' + query
      }));
      const updatedReq = Object.assign({}, req, { DisbursementStage: 'NeedsCorrection', StageEnteredAt: new Date().toISOString(), StageOpenedAt: '' });
      await MVOA.sheetsUpdateRow(TAB_REQUESTS, req.rowNumber, objToRow(REQUEST_COLS, updatedReq));
      await MVOA.logAudit({ module: 'Finance', requestId, eventType: 'Sent back for correction', comment: query, statusAfter: 'NeedsCorrection' });
      await loadAll(true);
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
    const bankSelect = scopeEl.querySelector(`.fin-bank-select[data-request-id="${requestId}"]`);
    const udNumber = udInput ? udInput.value.trim() : '';
    const bank = bankSelect ? bankSelect.value : '';
    if (!bank) { if (errEl) errEl.textContent = 'Please select which Bank this was paid from.'; return; }
    if (!udNumber) { if (errEl) errEl.textContent = 'Please enter a UD Number / Cheque / UTR reference.'; return; }
    try {
      const entry = await readExpenseRow(req.ExpenseTab, requestId);
      if (!entry) throw new Error('Expense Sheet entry not found');
      const updatedEntry = Object.assign({}, entry.row, { UDNumber: udNumber, Date: new Date().toLocaleDateString(), Bank: bank });
      await MVOA.sheetsUpdateRow(req.ExpenseTab, entry.rowNumber, objToRow(EXPENSE_COLS, updatedEntry));
      await markPaid(requestId, udNumber);
      await loadAll(true);
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
      // Display-only column selection/order for this read-only browser —
      // independent of EXPENSE_COLS, which stays untouched since it's the
      // actual physical column order of the live sheet (writes/reads
      // elsewhere still rely on it positionally). Nelson Check / Lakshman
      // Check are hidden from view here per explicit request. UDNumber
      // (the UTR/Cheque/UD reference) and Date (the Disbursement Officer's
      // payment-release date — distinct from Passed By/Approved By's own
      // dates) are moved to display together, right after Bank.
      const HIDDEN_COLS = new Set(['RequestID', 'NelsonCheck', 'LakshmanCheck', 'UDNumber', 'Date']);
      const header = EXPENSE_COLS.filter(c => !HIDDEN_COLS.has(c));
      header.push('UDNumber', 'Date');
      // Columns holding money — display with Indian comma grouping
      // (1,00,000 style: thousands, then lakhs/crores) rather than the
      // raw digit string.
      const AMOUNT_COLS = new Set(['GrossAmount', 'TDS', 'LessAdd', 'NetAmount']);
      // Columns storing a "Name · date" stamp — show name and date on
      // two separate lines within the same cell instead of one long line.
      const PERSON_DATE_COLS = new Set(['ApprovedBy', 'PassedBy']);
      const formatAmountPlain = n => {
        const num = Number(n);
        return isFinite(num) && n !== '' ? num.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '';
      };
      const cellHtml = (h, raw) => {
        if (AMOUNT_COLS.has(h)) return formatAmountPlain(raw);
        if (PERSON_DATE_COLS.has(h) && raw) return String(raw).split(' · ').map(escapeHtml).join('<br>');
        return escapeHtml(raw || '');
      };
      tableEl.innerHTML = `
        <table class="mvoa-table" style="min-width:900px;text-align:center;">
          <thead><tr>${header.map(h => `<th style="text-align:center;">${h}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(1).map(r => {
            const obj = rowToObj(EXPENSE_COLS, r, 0);
            return `<tr>${header.map(h => `<td style="text-align:center;">${cellHtml(h, obj[h])}</td>`).join('')}</tr>`;
          }).join('')}</tbody>
        </table>`;
    };
    monthSel.addEventListener('change', loadMonth);
    loadMonth();
  }

  return { mount };
})();
