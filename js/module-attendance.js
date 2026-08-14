// ═══════════════════════════════════════════════════════════════
// STAFF ATTENDANCE — Google-Sheets-backed rebuild of the standalone
// MVOA_Staff_Attendance.html app, integrated as a normal MVOA module
// (registered tile, opens inline in the app shell — same as every
// other module, no separate page/new tab).
//
// PHASING (large rewrite, built in phases — this file currently
// implements PHASE 1 only):
//   Phase 1 (THIS FILE, now)  — Agencies: add/edit/deactivate the
//                                 service-provider agencies whose staff
//                                 attend site (Security, Housekeeping,
//                                 Landscaping, etc.)
//   Phase 2 (next)            — Staff: enroll staff per agency, photo +
//                                 Aadhaar stored in Google Drive (via
//                                 MVOA.uploadPhotoToDrive, same as
//                                 every other module's photo handling —
//                                 no base64-in-Sheets), 4-digit QR code
//                                 generated via MVOA.nextId-style scheme
//   Phase 3 (after)           — Settings (retention days for old scan
//                                 photos). NOTE: there is no separate
//                                 app PIN — access is controlled by the
//                                 same login + PermissionsMatrix_* model
//                                 as Daily Ops / Plant Rounds (see below)
//   Phase 4 (last, largest)   — Attendance Logs: QR scan check-in/out,
//                                 daily/monthly registers. Confirmed
//                                 rules for this phase: a 3rd scan in a
//                                 day must NOT be allowed to overwrite
//                                 an existing check-out; real status
//                                 tracking (not just "has a log row");
//                                 deleting an agency deletes its staff's
//                                 attendance history too (not orphaned).
//
// ACCESS MODEL (all phases): no standalone PIN screen like the old app.
// Access is gated per-Section by PermissionsMatrix_Attendance, exactly
// like Plant Rounds' PermissionsMatrix_PlantRounds — Section|Title|
// AccessLevel rows, edited directly in the Sheet. A Title with no row
// for a Section has NO access to it; 'Edit' vs 'ReadOnly' controls
// whether they can change data. DEV role always has full access. This
// phase only touches the 'Agencies' section.
// ═══════════════════════════════════════════════════════════════
(function () {
  const AGENCY_COLS = ['AgencyID', 'Name', 'Type', 'Active', 'CreatedDate', 'CreatedBy'];
  const SECTION_AGENCIES = 'Agencies';

  let agenciesCache = [];

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function rowsToObjs(rows, cols) {
    return rows.slice(1).map((r, i) => {
      const o = { rowNumber: i + 2 };
      cols.forEach((c, ci) => o[c] = r[ci] !== undefined ? r[ci] : '');
      return o;
    }).filter(o => o[cols[0]]);
  }
  function isActive(v) {
    return v === 'TRUE' || v === 'true' || v === true || v === '1';
  }

  async function loadAgencies(force) {
    const [rows] = await Promise.all([
      MVOA.sheetsRead(MVOA.TABS.attAgencies),
      MVOA.loadAttendancePermissionsMatrix(force)
    ]);
    agenciesCache = rowsToObjs(rows, AGENCY_COLS).filter(a => isActive(a.Active));
  }

  function canEdit(user) { return MVOA.canEditAttendanceSection(SECTION_AGENCIES, user); }
  function canView(user) { return MVOA.canViewAttendanceSection(SECTION_AGENCIES, user); }

  async function mount(container) {
    container.innerHTML = '<p class="muted">Loading…</p>';
    const user = MVOA.getUser();
    if (!canView(user)) {
      container.innerHTML = `
        <div class="card">
          <p class="muted">You don't have access to Staff Attendance. Ask an admin to add your Title to the PermissionsMatrix_Attendance sheet.</p>
        </div>
      `;
      return;
    }
    try {
      await loadAgencies();
    } catch (e) {
      container.innerHTML = `<p class="error-text">Could not load Staff Attendance: ${escapeHtml(e.message)}</p>`;
      return;
    }
    renderAgenciesList(container, user);
  }

  function renderAgenciesList(container, user) {
    const editable = canEdit(user);
    const rows = agenciesCache.slice().sort((a, b) => a.Name.localeCompare(b.Name));
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <strong>🪪 Staff Attendance — Agencies</strong>
      </div>
      <div class="card">
        <p class="muted" style="margin:0 0 10px;">
          Service-provider agencies whose staff attend site (Security, Housekeeping, Landscaping, etc.).
          Staff enrollment, QR scanning and attendance registers are being added in the next phases.
        </p>
        ${editable ? '<button id="att-agency-add" class="btn-primary" style="margin-bottom:12px;">+ Add Agency</button>' : ''}
        <table class="mvoa-table">
          <thead><tr><th>Name</th><th>Type</th>${editable ? '<th></th>' : ''}</tr></thead>
          <tbody>
            ${rows.length ? rows.map(a => `
              <tr>
                <td>${escapeHtml(a.Name)}</td>
                <td>${escapeHtml(a.Type)}</td>
                ${editable ? `
                  <td style="white-space:nowrap;">
                    <button class="btn-secondary att-agency-edit" data-id="${escapeHtml(a.AgencyID)}" style="font-size:0.8rem;padding:4px 10px;">Edit</button>
                    <button class="btn-secondary att-agency-delete" data-id="${escapeHtml(a.AgencyID)}" style="font-size:0.8rem;padding:4px 10px;">Deactivate</button>
                  </td>` : ''}
              </tr>
            `).join('') : `<tr><td colspan="${editable ? 3 : 2}" class="muted">No agencies yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
    if (editable) {
      container.querySelector('#att-agency-add').addEventListener('click', () => renderAgencyForm(container, null, user));
      container.querySelectorAll('.att-agency-edit').forEach(btn => btn.addEventListener('click', () => {
        const a = agenciesCache.find(x => x.AgencyID === btn.dataset.id);
        if (a) renderAgencyForm(container, a, user);
      }));
      container.querySelectorAll('.att-agency-delete').forEach(btn => btn.addEventListener('click', () => confirmDeleteAgency(container, btn.dataset.id, user)));
    }
  }

  function renderAgencyForm(container, agency, user) {
    const isEdit = !!agency;
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <strong>🪪 ${isEdit ? 'Edit Agency' : 'Add Agency'}</strong>
      </div>
      <div class="card">
        <label>Name
          <input type="text" id="att-agency-name" value="${isEdit ? escapeHtml(agency.Name) : ''}" placeholder="e.g. ABC Security Services">
        </label>
        <label>Type
          <input type="text" id="att-agency-type" value="${isEdit ? escapeHtml(agency.Type) : ''}" placeholder="e.g. Security, Housekeeping, Landscaping">
        </label>
        <div class="mvoa-row" style="margin-top:12px;">
          <button id="att-agency-save" class="btn-primary">Save</button>
          <button id="att-agency-cancel" class="btn-secondary">Cancel</button>
        </div>
        <p class="error-text" id="att-agency-form-error"></p>
      </div>
    `;
    container.querySelector('#att-agency-cancel').addEventListener('click', () => renderAgenciesList(container, user));
    container.querySelector('#att-agency-save').addEventListener('click', async () => {
      const name = container.querySelector('#att-agency-name').value.trim();
      const type = container.querySelector('#att-agency-type').value.trim();
      const errEl = container.querySelector('#att-agency-form-error');
      errEl.textContent = '';
      if (!name) { errEl.textContent = 'Name is required.'; return; }
      const btn = container.querySelector('#att-agency-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (isEdit) {
          await MVOA.sheetsUpdateRow(MVOA.TABS.attAgencies, agency.rowNumber,
            [agency.AgencyID, name, type, agency.Active, agency.CreatedDate, agency.CreatedBy]);
        } else {
          const existingRows = await MVOA.sheetsRead(MVOA.TABS.attAgencies);
          const existingIds = existingRows.slice(1).map(r => r[0]).filter(Boolean);
          const agencyId = MVOA.nextId('AGY', existingIds);
          const now = new Date().toISOString();
          await MVOA.sheetsAppend(MVOA.TABS.attAgencies, [agencyId, name, type, 'TRUE', now, (user && user.name) || '']);
        }
        await loadAgencies(true);
        renderAgenciesList(container, user);
      } catch (e) {
        errEl.textContent = 'Save failed: ' + e.message;
        btn.disabled = false; btn.textContent = 'Save';
      }
    });
  }

  async function confirmDeleteAgency(container, agencyId, user) {
    const agency = agenciesCache.find(a => a.AgencyID === agencyId);
    if (!agency) return;
    if (!confirm(`Deactivate "${agency.Name}"? It will be hidden from Staff Attendance but its record stays in the sheet.`)) return;
    try {
      await MVOA.sheetsUpdateRow(MVOA.TABS.attAgencies, agency.rowNumber,
        [agency.AgencyID, agency.Name, agency.Type, 'FALSE', agency.CreatedDate, agency.CreatedBy]);
      await loadAgencies(true);
      renderAgenciesList(container, user);
    } catch (e) {
      alert('Deactivate failed: ' + e.message);
    }
  }

  MVOA.registerModule('attendance', {
    label: 'Staff Attendance',
    icon: '🪪',
    roles: ['ALL'],
    init: mount
  });
})();
