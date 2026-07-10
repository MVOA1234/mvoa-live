// ═══════════════════════════════════════════════════════════════
// MODULE: Approvals & Payments
// STATUS: placeholder registration only — full UI/logic to be built next.
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('finance', {
  label: 'Approvals & Payments',
  icon: '💳',
  roles: ['ALL'],   // TESTING: opened to all roles temporarily — revert to real roles once finalized
  init: function (container) {
    container.innerHTML = `
      <p class="muted">Approvals &amp; Payments module — coming next.</p>
      <p class="muted">Planned: submit a request (vendor/amount/purpose/attachment) → routed for approval by role (e.g. EC/Treasurer) → approve/reject with comment → mark as paid, with a running ledger and status filters (Pending / Approved / Paid / Rejected).</p>
    `;
  }
});
