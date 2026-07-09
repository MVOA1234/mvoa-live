// ═══════════════════════════════════════════════════════════════
// MODULE: Plant Rounds & Compliance
// STATUS: placeholder registration only — full UI/logic to be built next.
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('hs', {
  label: 'Plant Rounds & Compliance',
  icon: '🛟',
  roles: ['ALL'],   // TESTING: opened to all roles temporarily — revert to ['FM','SEC','DEV'] once roles are finalized
  init: function (container) {
    container.innerHTML = `
      <p class="muted">Plant Rounds &amp; Compliance module — coming next.</p>
      <p class="muted">Planned: DG/Pump/Panel operation logs, FM daily rounds, and monthly/quarterly HSE checkpoints — recurring checklist templates, due/overdue engine, per-item Pass/Fail/Text/Dropdown inputs, auto-flagging (Option A).</p>
    `;
  }
});
