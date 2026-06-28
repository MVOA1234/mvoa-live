// ═══════════════════════════════════════════════════════════════
// MODULE: Health & Safety
// STATUS: placeholder registration only — full UI/logic to be built next.
// ═══════════════════════════════════════════════════════════════

MVOA.registerModule('hs', {
  label: 'Health & Safety',
  icon: '🛟',
  roles: ['FM', 'SEC', 'DEV'],   // SEC = Security/Tech staff filling specific checklists
  init: function (container) {
    container.innerHTML = `
      <p class="muted">Health &amp; Safety module — coming next.</p>
      <p class="muted">Planned: recurring checklist templates, due/overdue engine, per-item Pass/Fail/Text/Dropdown inputs, auto-flagging (Option A).</p>
    `;
  }
});
