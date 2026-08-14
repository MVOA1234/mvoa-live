// ═══════════════════════════════════════════════════════════════
// STAFF ATTENDANCE — Google-Sheets-backed rebuild of the standalone
// MVOA_Staff_Attendance.html app, integrated as a normal MVOA module
// (registered tile, opens inline in the app shell — same as every
// other module, no separate page/new tab).
//
// PHASING (large rewrite, built in phases):
//   Phase 1 (done)            — Agencies: add/edit/deactivate the
//                                 service-provider agencies whose staff
//                                 attend site (Security, Housekeeping,
//                                 Landscaping, etc.)
//   Phase 2 (THIS UPDATE)     — Staff: enrol staff per agency. Staff
//                                 photo (required) + Aadhaar number/
//                                 photo (optional) are stored via
//                                 MVOA.uploadPhotoToDrive — Drive, not
//                                 base64-in-Sheets, same as every other
//                                 module's photo handling. Each staff
//                                 member gets a StaffID (STF-0001 style,
//                                 via MVOA.nextId) AND a separate unique
//                                 4-digit numeric Code, for gate entry
//                                 without a phone — mirrors the original
//                                 standalone app's scheme exactly.
//   Phase 3 (done)             — Settings: a single "Retention (days)"
//                                 value. Attendance records (who/when/
//                                 status) are kept forever — only the
//                                 CheckIn/CheckOutPhotoURL photos on old
//                                 AttLog rows are cleaned up once they pass
//                                 this age, run passively (best-effort,
//                                 once per session) whenever the module
//                                 opens: the actual Drive file is deleted
//                                 via MVOA.deletePhotoFromDrive (reclaims
//                                 storage — needs a 'delete' action added
//                                 to the photoUploadUrl Apps Script; see
//                                 deployment notes), then the link is
//                                 cleared from the Sheet either way. NOTE:
//                                 there is no separate app PIN — access is
//                                 controlled by the same login +
//                                 PermissionsMatrix_* model as Daily Ops /
//                                 Plant Rounds (see below)
//   Phase 4 (done)            — Attendance Logs: QR scan check-in/out
//                                 (plus a 4-digit code fallback for staff
//                                 without a badge in hand), a live daily
//                                 register with real per-staff status
//                                 ('Not scanned' / 'On-site' / 'Checked
//                                 out' — a genuine Status column on each
//                                 AttLog row, not just derived from
//                                 whether a row exists). A 3rd scan in a
//                                 day is rejected outright rather than
//                                 silently overwriting the checkout —
//                                 re-checked against a fresh read right
//                                 before writing, so two gate stations
//                                 scanning the same person moments apart
//                                 still can't both "win". Agencies/Staff
//                                 now also have a genuine hard "Delete"
//                                 (admin-only, separate from the existing
//                                 "Deactivate") that cascades: deleting an
//                                 agency deletes its staff AND all of
//                                 their attendance history, deleting a
//                                 staff member deletes their attendance
//                                 history too — nothing is orphaned the
//                                 way the original standalone app left
//                                 attendance logs behind after a delete.
//
// ACCESS MODEL (all phases): no standalone PIN screen like the old app.
// Access is gated per-Section by PermissionsMatrix_Attendance, exactly
// like Plant Rounds' PermissionsMatrix_PlantRounds — Section|Title|
// AccessLevel rows, edited directly in the Sheet. A Title with no row
// for a Section has NO access to it; 'Edit' vs 'ReadOnly' controls
// whether they can change data. DEV role always has full access.
// Four independent Sections exist: 'Agencies', 'Staff', 'Logs' (the
// scan/register screen), 'Settings' — e.g. Security can be given Edit on
// Logs (so they can run the scan station) but no access to Agencies/
// Staff/Settings at all.
// Separately, the new hard-Delete actions (as opposed to Deactivate) are
// further restricted to MVOA.isAdmin(user) regardless of the matrix —
// permanently destroying attendance history is treated like the app's
// other admin-only actions (PIN Management, unmasked config), not just
// gated by ordinary section Edit access.
// ═══════════════════════════════════════════════════════════════
(function () {
  const AGENCY_COLS = ['AgencyID', 'Name', 'Type', 'Active', 'CreatedDate', 'CreatedBy'];
  const STAFF_COLS = ['StaffID', 'AgencyID', 'Name', 'Role', 'Phone', 'AadhaarNumber', 'AadhaarPhotoURL', 'Code', 'PhotoURL', 'Active', 'CreatedDate', 'CreatedBy'];
  const LOG_COLS = ['LogID', 'StaffID', 'Date', 'CheckInTime', 'CheckInPhotoURL', 'CheckOutTime', 'CheckOutPhotoURL', 'Status', 'LoggedBy'];
  const SETTINGS_COLS = ['Key', 'Value'];
  const SECTION_AGENCIES = 'Agencies';
  const SECTION_STAFF = 'Staff';
  const SECTION_LOGS = 'Logs';
  const SECTION_SETTINGS = 'Settings';
  const NAV_TABS = [
    { key: SECTION_AGENCIES, label: 'Agencies' },
    { key: SECTION_STAFF, label: 'Staff' },
    { key: SECTION_LOGS, label: 'Attendance Log' },
    { key: SECTION_SETTINGS, label: 'Settings' }
  ];

  let allAgenciesCache = [];   // every agency, active or not — used for name lookups so a
                                // staff member's agency name still resolves even after that
                                // agency is deactivated
  let agenciesCache = [];      // active agencies only — used for lists/dropdowns
  let allStaffCache = [];      // every staff row, active or not — used for StaffID/Code
                                // uniqueness checks (a deactivated staff member's code must
                                // still be treated as taken, not recycled) and QR/code lookup
  let staffCache = [];         // active staff only — used for the list/table and the register
  let allLogsCache = [];       // every AttLog row, all dates — filtered client-side per date;
                                // re-read fresh (not from this cache) at the moment of an
                                // actual scan, see processAttendanceScan()
  let attSettingsCache = {};   // Key -> Value map from AttSettings, e.g. {RetentionDays: '90'}
  let retentionCleanupRan = false; // throttle: run the passive photo-link cleanup at most
                                    // once per session, not on every mount()

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
  function formatKB(bytes) {
    return bytes > 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }
  function isoDateLocal(d) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function canEditSection(section, user) { return MVOA.canEditAttendanceSection(section, user); }
  function canViewSection(section, user) { return MVOA.canViewAttendanceSection(section, user); }

  async function loadAll(force) {
    const [agencyRows, staffRows, logRows, settingsRows] = await Promise.all([
      MVOA.sheetsRead(MVOA.TABS.attAgencies),
      MVOA.sheetsRead(MVOA.TABS.attStaff),
      MVOA.sheetsRead(MVOA.TABS.attLog),
      MVOA.sheetsRead(MVOA.TABS.attSettings),
      MVOA.loadAttendancePermissionsMatrix(force)
    ]);
    allAgenciesCache = rowsToObjs(agencyRows, AGENCY_COLS);
    agenciesCache = allAgenciesCache.filter(a => isActive(a.Active));
    allStaffCache = rowsToObjs(staffRows, STAFF_COLS);
    staffCache = allStaffCache.filter(s => isActive(s.Active));
    allLogsCache = rowsToObjs(logRows, LOG_COLS);
    attSettingsCache = {};
    rowsToObjs(settingsRows, SETTINGS_COLS).forEach(o => { attSettingsCache[o.Key] = o.Value; });
  }

  function agencyName(agencyId) {
    const a = allAgenciesCache.find(x => x.AgencyID === agencyId);
    return a ? a.Name : agencyId;
  }
  function staffById(staffId) {
    return allStaffCache.find(s => s.StaffID === staffId);
  }

  // ─────────────────────────────────────────────
  // MOUNT / SHELL — a small tab bar between Agencies and Staff, each
  // independently gated by canViewSection. If a user only has access
  // to one section, that tab is shown alone with no bar at all.
  // ─────────────────────────────────────────────
  async function mount(container) {
    container.innerHTML = '<p class="muted">Loading…</p>';
    const user = MVOA.getUser();
    try {
      await loadAll();
    } catch (e) {
      container.innerHTML = `<p class="error-text">Could not load Staff Attendance: ${escapeHtml(e.message)}</p>`;
      return;
    }
    if (!retentionCleanupRan) {
      retentionCleanupRan = true;
      runPhotoRetentionCleanup(); // fire-and-forget, best-effort — see its own comment
    }
    const accessibleTabs = NAV_TABS.filter(t => canViewSection(t.key, user));
    if (!accessibleTabs.length) {
      container.innerHTML = `
        <div class="card">
          <p class="muted">You don't have access to Staff Attendance. Ask an admin to add your Title to the PermissionsMatrix_Attendance sheet.</p>
        </div>
      `;
      return;
    }
    renderShell(container, user, accessibleTabs[0].key);
  }

  function renderShell(container, user, activeTab) {
    const accessibleTabs = NAV_TABS.filter(t => canViewSection(t.key, user));
    container.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <strong>🪪 Staff Attendance</strong>
      </div>
      ${accessibleTabs.length > 1 ? `
        <div class="mvoa-row" style="margin-bottom:12px;gap:6px;">
          ${accessibleTabs.map(t => `<button class="${t.key === activeTab ? 'btn-primary' : 'btn-secondary'} att-tab-btn" data-tab="${t.key}" style="flex:1;min-width:0;padding:8px 4px;font-size:0.85rem;">${t.label}</button>`).join('')}
        </div>
      ` : ''}
      <div id="att-tab-body"></div>
    `;
    container.querySelectorAll('.att-tab-btn').forEach(btn => btn.addEventListener('click', () => renderShell(container, user, btn.dataset.tab)));
    const host = container.querySelector('#att-tab-body');
    if (activeTab === SECTION_STAFF) renderStaffList(host, user);
    else if (activeTab === SECTION_LOGS) renderAttendanceLogs(host, user);
    else if (activeTab === SECTION_SETTINGS) renderSettings(host, user);
    else renderAgenciesList(host, user);
  }

  // ─────────────────────────────────────────────
  // AGENCIES (Phase 1 — same logic as before, now rendering into the
  // tab body `host` instead of the whole module container)
  // ─────────────────────────────────────────────
  function renderAgenciesList(host, user) {
    const editable = canEditSection(SECTION_AGENCIES, user);
    const canHardDelete = editable && MVOA.isAdmin(user);
    const rows = agenciesCache.slice().sort((a, b) => a.Name.localeCompare(b.Name));
    host.innerHTML = `
      <div class="card">
        <p class="muted" style="margin:0 0 10px;">
          Service-provider agencies whose staff attend site (Security, Housekeeping, Landscaping, etc.).
        </p>
        ${editable ? '<button id="att-agency-add" class="btn-primary" style="margin-bottom:12px;">+ Add Agency</button>' : ''}
        <div style="overflow-x:auto;">
        <table class="mvoa-table">
          <thead><tr><th>Name</th><th>Type</th>${editable ? '<th></th>' : ''}</tr></thead>
          <tbody>
            ${rows.length ? rows.map(a => `
              <tr>
                <td>${escapeHtml(a.Name)}</td>
                <td>${escapeHtml(a.Type)}</td>
                ${editable ? `
                  <td>
                    <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
                      <button class="btn-secondary att-agency-edit" data-id="${escapeHtml(a.AgencyID)}" style="font-size:0.8rem;padding:4px 10px;white-space:nowrap;">Edit</button>
                      <button class="btn-secondary att-agency-delete" data-id="${escapeHtml(a.AgencyID)}" style="font-size:0.8rem;padding:4px 10px;white-space:nowrap;">Deactivate</button>
                      ${canHardDelete ? `<button class="btn-secondary att-agency-harddelete" data-id="${escapeHtml(a.AgencyID)}" style="font-size:0.8rem;padding:4px 10px;white-space:nowrap;color:#b3261e;">Delete</button>` : ''}
                    </div>
                  </td>` : ''}
              </tr>
            `).join('') : `<tr><td colspan="${editable ? 3 : 2}" class="muted">No agencies yet.</td></tr>`}
          </tbody>
        </table>
        </div>
      </div>
    `;
    if (editable) {
      host.querySelector('#att-agency-add').addEventListener('click', () => renderAgencyForm(host, null, user));
      host.querySelectorAll('.att-agency-edit').forEach(btn => btn.addEventListener('click', () => {
        const a = agenciesCache.find(x => x.AgencyID === btn.dataset.id);
        if (a) renderAgencyForm(host, a, user);
      }));
      host.querySelectorAll('.att-agency-delete').forEach(btn => btn.addEventListener('click', () => confirmDeleteAgency(host, btn.dataset.id, user)));
      host.querySelectorAll('.att-agency-harddelete').forEach(btn => btn.addEventListener('click', () => confirmHardDeleteAgency(host, btn.dataset.id, user)));
    }
  }

  function renderAgencyForm(host, agency, user) {
    const isEdit = !!agency;
    host.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="att-agency-form-back" class="btn-secondary">← Back to Agencies</button>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">${isEdit ? 'Edit Agency' : 'Add Agency'}</h3>
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
    host.querySelector('#att-agency-form-back').addEventListener('click', () => renderAgenciesList(host, user));
    host.querySelector('#att-agency-cancel').addEventListener('click', () => renderAgenciesList(host, user));
    host.querySelector('#att-agency-save').addEventListener('click', async () => {
      const name = host.querySelector('#att-agency-name').value.trim();
      const type = host.querySelector('#att-agency-type').value.trim();
      const errEl = host.querySelector('#att-agency-form-error');
      errEl.textContent = '';
      if (!name) { errEl.textContent = 'Name is required.'; return; }
      const btn = host.querySelector('#att-agency-save');
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
        await loadAll(true);
        renderAgenciesList(host, user);
      } catch (e) {
        errEl.textContent = 'Save failed: ' + e.message;
        btn.disabled = false; btn.textContent = 'Save';
      }
    });
  }

  async function confirmDeleteAgency(host, agencyId, user) {
    const agency = agenciesCache.find(a => a.AgencyID === agencyId);
    if (!agency) return;
    const staffCount = staffCache.filter(s => s.AgencyID === agencyId).length;
    if (!confirm(`Deactivate "${agency.Name}"?${staffCount ? ` It has ${staffCount} active staff member(s) — they will stay enrolled but you should deactivate or reassign them separately.` : ''} The agency record stays in the sheet.`)) return;
    try {
      await MVOA.sheetsUpdateRow(MVOA.TABS.attAgencies, agency.rowNumber,
        [agency.AgencyID, agency.Name, agency.Type, 'FALSE', agency.CreatedDate, agency.CreatedBy]);
      await loadAll(true);
      renderAgenciesList(host, user);
    } catch (e) {
      alert('Deactivate failed: ' + e.message);
    }
  }

  // Permanent, cascading delete — admin-only (see canHardDelete above).
  // Removes the agency row itself, every staff row under it, and every
  // AttLog row belonging to that staff — the fix for the original app's
  // orphaned-logs bug, where deleting an agency deleted its staff but
  // left their attendance history behind pointing at nothing.
  async function confirmHardDeleteAgency(host, agencyId, user) {
    const agency = allAgenciesCache.find(a => a.AgencyID === agencyId);
    if (!agency) return;
    const agencyStaff = allStaffCache.filter(s => s.AgencyID === agencyId);
    const staffIds = agencyStaff.map(s => s.StaffID);
    const logCount = allLogsCache.filter(l => staffIds.includes(l.StaffID)).length;
    const msg = agencyStaff.length
      ? `Agency "${agency.Name}" has ${agencyStaff.length} staff member(s) enrolled${logCount ? `, with ${logCount} attendance record(s) between them` : ''}.\n\nPermanently deleting this agency will ALSO permanently delete all of its staff and their attendance history. This cannot be undone.\n\nContinue?`
      : `Permanently delete agency "${agency.Name}"? This cannot be undone.`;
    if (!confirm(msg)) return;
    try {
      if (agencyStaff.length) {
        const logRows = await MVOA.sheetsRead(MVOA.TABS.attLog);
        const logRowNumbers = rowsToObjs(logRows, LOG_COLS).filter(l => staffIds.includes(l.StaffID)).map(l => l.rowNumber);
        if (logRowNumbers.length) await MVOA.sheetsDeleteRows(MVOA.TABS.attLog, logRowNumbers);
        await MVOA.sheetsDeleteRows(MVOA.TABS.attStaff, agencyStaff.map(s => s.rowNumber));
      }
      await MVOA.sheetsDeleteRows(MVOA.TABS.attAgencies, [agency.rowNumber]);
      await loadAll(true);
      renderAgenciesList(host, user);
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  // ─────────────────────────────────────────────
  // STAFF (Phase 2 — NEW)
  // ─────────────────────────────────────────────
  // Unique 4-digit numeric code, separate from StaffID — mirrors the
  // original standalone app's genCode(): a memorable fallback so staff
  // can check in/out by typing 4 digits if a QR scan isn't possible.
  function genStaffCode(existingCodes) {
    const used = new Set(existingCodes.filter(Boolean));
    let code;
    do {
      code = String(1000 + Math.floor(Math.random() * 9000));
    } while (used.has(code));
    return code;
  }

  function renderStaffList(host, user) {
    const editable = canEditSection(SECTION_STAFF, user);
    const canHardDelete = editable && MVOA.isAdmin(user);
    const rows = staffCache.slice().sort((a, b) => agencyName(a.AgencyID).localeCompare(agencyName(b.AgencyID)) || a.Name.localeCompare(b.Name));
    host.innerHTML = `
      <div class="card">
        <p class="muted" style="margin:0 0 10px;">
          Staff enrolled per agency, with photo, Aadhaar and a 4-digit attendance code for gate entry.
          Use "ID Card" to view/print a staff member's printable badge.
        </p>
        ${editable ? `
          <button id="att-staff-add" class="btn-primary" style="margin-bottom:12px;" ${agenciesCache.length ? '' : 'disabled'}>+ Add Staff</button>
          ${agenciesCache.length ? '' : '<p class="muted" style="margin:0 0 12px;">Add an agency first (Agencies tab) before enrolling staff.</p>'}
        ` : ''}
        <div style="overflow-x:auto;">
        <table class="mvoa-table">
          <thead><tr><th>Name</th><th>Agency</th><th>Role</th><th>Code</th><th></th></tr></thead>
          <tbody>
            ${rows.length ? rows.map(s => `
              <tr>
                <td>${escapeHtml(s.Name)}</td>
                <td>${escapeHtml(agencyName(s.AgencyID))}</td>
                <td>${escapeHtml(s.Role)}</td>
                <td style="font-family:ui-monospace,Menlo,monospace;letter-spacing:2px;">${escapeHtml(s.Code)}</td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
                    <button class="btn-secondary att-staff-qr" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;white-space:nowrap;">ID Card</button>
                    ${editable ? `
                      <button class="btn-secondary att-staff-edit" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;white-space:nowrap;">Edit</button>
                      <button class="btn-secondary att-staff-delete" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;white-space:nowrap;">Deactivate</button>
                      ${canHardDelete ? `<button class="btn-secondary att-staff-harddelete" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;white-space:nowrap;color:#b3261e;">Delete</button>` : ''}
                    ` : ''}
                  </div>
                </td>
              </tr>
            `).join('') : `<tr><td colspan="5" class="muted">No staff enrolled yet.</td></tr>`}
          </tbody>
        </table>
        </div>
      </div>
    `;
    host.querySelectorAll('.att-staff-qr').forEach(btn => btn.addEventListener('click', () => {
      const s = staffCache.find(x => x.StaffID === btn.dataset.id);
      if (s) showStaffIdCard(s);
    }));
    if (editable) {
      const addBtn = host.querySelector('#att-staff-add');
      if (addBtn) addBtn.addEventListener('click', () => renderStaffForm(host, null, user));
      host.querySelectorAll('.att-staff-edit').forEach(btn => btn.addEventListener('click', () => {
        const s = staffCache.find(x => x.StaffID === btn.dataset.id);
        if (s) renderStaffForm(host, s, user);
      }));
      host.querySelectorAll('.att-staff-delete').forEach(btn => btn.addEventListener('click', () => confirmDeleteStaff(host, btn.dataset.id, user)));
      host.querySelectorAll('.att-staff-harddelete').forEach(btn => btn.addEventListener('click', () => confirmHardDeleteStaff(host, btn.dataset.id, user)));
    }
  }

  function renderStaffForm(host, staff, user) {
    const isEdit = !!staff;
    let pendingPhoto = null;        // {name, dataUrl, file, ...} from MVOA.capturePhoto(), set once picked
    let pendingAadhaarPhoto = null;
    const existingPhotoUrl = isEdit ? staff.PhotoURL : '';
    const existingAadhaarUrl = isEdit ? staff.AadhaarPhotoURL : '';
    // Shown immediately (not just "generated on save") so the field
    // never looks like an unresponsive button — re-checked for
    // collisions against the freshest data at actual save time below.
    const previewCode = isEdit ? staff.Code : genStaffCode(allStaffCache.map(s => s.Code));

    host.innerHTML = `
      <div class="mvoa-row" style="margin-bottom:10px;">
        <button id="att-staff-form-back" class="btn-secondary">← Back to Staff</button>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">${isEdit ? 'Edit Staff' : 'Enrol Staff'}</h3>
        <label>Full name
          <input type="text" id="att-staff-name" value="${isEdit ? escapeHtml(staff.Name) : ''}" placeholder="e.g. Ravi Kumar">
        </label>
        <label>Agency / service provider
          <select id="att-staff-agency">
            <option value="">— Select —</option>
            ${agenciesCache.slice().sort((a, b) => a.Name.localeCompare(b.Name)).map(a => `<option value="${escapeHtml(a.AgencyID)}" ${isEdit && staff.AgencyID === a.AgencyID ? 'selected' : ''}>${escapeHtml(a.Name)}</option>`).join('')}
          </select>
        </label>
        <label>Role (optional)
          <input type="text" id="att-staff-role" value="${isEdit ? escapeHtml(staff.Role) : ''}" placeholder="e.g. Security guard, Housekeeper">
        </label>
        <label>Phone (optional)
          <input type="tel" id="att-staff-phone" value="${isEdit ? escapeHtml(staff.Phone) : ''}" placeholder="e.g. 98400 12345">
        </label>
        <label>Aadhaar card number (optional)
          <input type="text" id="att-staff-aadhaar-num" value="${isEdit ? escapeHtml(staff.AadhaarNumber) : ''}" placeholder="e.g. 1234 5678 9012" inputmode="numeric" maxlength="14">
        </label>

        <label>Aadhaar card photo (optional)</label>
        <div class="mvoa-row" style="margin:4px 0 12px;gap:10px;">
          <button type="button" id="att-aadhaar-pick" class="btn-secondary">📷 ${existingAadhaarUrl ? 'Replace' : 'Add'} Aadhaar Photo</button>
          <span id="att-aadhaar-status" class="muted" style="font-size:0.85rem;">
            ${existingAadhaarUrl ? `<a href="${existingAadhaarUrl}" target="_blank" rel="noopener">📎 View current</a>` : 'No photo captured yet'}
          </span>
        </div>

        <label>4-digit attendance code</label>
        <div class="mvoa-row" style="margin:4px 0 12px;">
          <input type="text" id="att-staff-code" readonly value="${escapeHtml(previewCode)}" style="max-width:110px;font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:700;letter-spacing:4px;text-align:center;">
          <span class="muted" style="font-size:0.8rem;">Auto-generated (not clickable) · staff uses this to check in/out without a phone</span>
        </div>

        <label>Staff photo (required)</label>
        <div class="mvoa-row" style="margin:4px 0 12px;gap:10px;">
          <button type="button" id="att-photo-pick" class="btn-secondary">📷 ${existingPhotoUrl ? 'Replace' : 'Add'} Staff Photo</button>
          <span id="att-photo-status" class="muted" style="font-size:0.85rem;">
            ${existingPhotoUrl ? `<a href="${existingPhotoUrl}" target="_blank" rel="noopener">📎 View current</a>` : 'No photo captured yet'}
          </span>
        </div>

        <div class="mvoa-row" style="margin-top:12px;">
          <button id="att-staff-save" class="btn-primary">Save</button>
          <button id="att-staff-cancel" class="btn-secondary">Cancel</button>
        </div>
        <p class="error-text" id="att-staff-form-error"></p>
      </div>
    `;

    host.querySelector('#att-staff-form-back').addEventListener('click', () => renderStaffList(host, user));
    host.querySelector('#att-staff-cancel').addEventListener('click', () => renderStaffList(host, user));

    host.querySelector('#att-photo-pick').addEventListener('click', async () => {
      const p = await MVOA.capturePhoto({ useCamera: true });
      if (p) {
        pendingPhoto = p;
        host.querySelector('#att-photo-status').innerHTML =
          `<img src="${p.dataUrl}" style="height:40px;width:40px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:6px;">${escapeHtml(p.name)} (${formatKB(p.compressedSizeBytes)})`;
      }
    });
    host.querySelector('#att-aadhaar-pick').addEventListener('click', async () => {
      const p = await MVOA.capturePhoto({ useCamera: true });
      if (p) {
        pendingAadhaarPhoto = p;
        host.querySelector('#att-aadhaar-status').innerHTML =
          `<img src="${p.dataUrl}" style="height:40px;width:40px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:6px;">${escapeHtml(p.name)} (${formatKB(p.compressedSizeBytes)})`;
      }
    });

    host.querySelector('#att-staff-save').addEventListener('click', async () => {
      const name = host.querySelector('#att-staff-name').value.trim();
      const agencyId = host.querySelector('#att-staff-agency').value;
      const role = host.querySelector('#att-staff-role').value.trim();
      const phone = host.querySelector('#att-staff-phone').value.trim();
      const aadhaarNum = host.querySelector('#att-staff-aadhaar-num').value.trim();
      const errEl = host.querySelector('#att-staff-form-error');
      errEl.textContent = '';
      if (!name) { errEl.textContent = 'Full name is required.'; return; }
      if (!agencyId) { errEl.textContent = 'Please select an agency.'; return; }
      if (!pendingPhoto && !existingPhotoUrl) { errEl.textContent = 'Staff photo is required.'; return; }

      const btn = host.querySelector('#att-staff-save');
      btn.disabled = true; btn.textContent = 'Saving…';

      try {
        let staffId, code;
        if (isEdit) {
          staffId = staff.StaffID;
          code = staff.Code;
        } else {
          const existingRows = await MVOA.sheetsRead(MVOA.TABS.attStaff);
          const existingIds = existingRows.slice(1).map(r => r[0]).filter(Boolean);
          const existingCodes = existingRows.slice(1).map(r => r[7]).filter(Boolean); // Code column
          staffId = MVOA.nextId('STF', existingIds);
          // Reuse the code already shown on screen unless someone else just
          // took it in the meantime (rare) — avoids the displayed code
          // silently differing from what actually gets saved.
          code = existingCodes.includes(previewCode) ? genStaffCode(existingCodes) : previewCode;
        }

        let photoUrl = existingPhotoUrl;
        if (pendingPhoto) {
          errEl.textContent = 'Uploading staff photo…';
          photoUrl = await MVOA.uploadPhotoToDrive(pendingPhoto.file, `${staffId}_photo_${pendingPhoto.name}`);
        }
        let aadhaarUrl = existingAadhaarUrl;
        if (pendingAadhaarPhoto) {
          errEl.textContent = 'Uploading Aadhaar photo…';
          aadhaarUrl = await MVOA.uploadPhotoToDrive(pendingAadhaarPhoto.file, `${staffId}_aadhaar_${pendingAadhaarPhoto.name}`);
        }
        errEl.textContent = '';

        if (isEdit) {
          await MVOA.sheetsUpdateRow(MVOA.TABS.attStaff, staff.rowNumber,
            [staffId, agencyId, name, role, phone, aadhaarNum, aadhaarUrl, code, photoUrl, staff.Active, staff.CreatedDate, staff.CreatedBy]);
        } else {
          const now = new Date().toISOString();
          await MVOA.sheetsAppend(MVOA.TABS.attStaff,
            [staffId, agencyId, name, role, phone, aadhaarNum, aadhaarUrl, code, photoUrl, 'TRUE', now, (user && user.name) || '']);
        }
        await loadAll(true);
        renderStaffList(host, user);
      } catch (e) {
        errEl.textContent = 'Save failed: ' + e.message;
        btn.disabled = false; btn.textContent = 'Save';
      }
    });
  }

  async function confirmDeleteStaff(host, staffId, user) {
    const staff = staffCache.find(s => s.StaffID === staffId);
    if (!staff) return;
    if (!confirm(`Deactivate "${staff.Name}"? They will be hidden from Staff Attendance and unable to check in/out. Their record and any attendance history stays in the sheet.`)) return;
    try {
      await MVOA.sheetsUpdateRow(MVOA.TABS.attStaff, staff.rowNumber,
        [staff.StaffID, staff.AgencyID, staff.Name, staff.Role, staff.Phone, staff.AadhaarNumber, staff.AadhaarPhotoURL, staff.Code, staff.PhotoURL, 'FALSE', staff.CreatedDate, staff.CreatedBy]);
      await loadAll(true);
      renderStaffList(host, user);
    } catch (e) {
      alert('Deactivate failed: ' + e.message);
    }
  }

  // Permanent delete — admin-only (see canHardDelete above). Also removes
  // every AttLog row for this staff member, so nothing is left pointing
  // at a StaffID that no longer exists.
  async function confirmHardDeleteStaff(host, staffId, user) {
    const staff = allStaffCache.find(s => s.StaffID === staffId);
    if (!staff) return;
    const logCount = allLogsCache.filter(l => l.StaffID === staffId).length;
    const msg = logCount
      ? `Permanently delete "${staff.Name}" AND all ${logCount} of their attendance record(s)? This cannot be undone.`
      : `Permanently delete "${staff.Name}"? This cannot be undone.`;
    if (!confirm(msg)) return;
    try {
      const logRows = await MVOA.sheetsRead(MVOA.TABS.attLog);
      const logRowNumbers = rowsToObjs(logRows, LOG_COLS).filter(l => l.StaffID === staffId).map(l => l.rowNumber);
      if (logRowNumbers.length) await MVOA.sheetsDeleteRows(MVOA.TABS.attLog, logRowNumbers);
      await MVOA.sheetsDeleteRows(MVOA.TABS.attStaff, [staff.rowNumber]);
      await loadAll(true);
      renderStaffList(host, user);
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  // ID CARD — printable staff badge: MVOA logo, name, agency, QR code
  // (the same 'MVOA-ATT:' payload the scanner expects, via the same
  // public QR-image API used elsewhere — no new QR-generation library
  // needed client-side), and the 4-digit fallback code. Card background
  // is the deeper brand green (#2e5e1e) the user specified. The logo is
  // the SAME assets/logo.png this app already uses elsewhere (see
  // MVOA.logoSvg() in shared.js) — resolved to an absolute URL via
  // window.location.href so it still loads correctly inside the
  // separate about:blank print window below, which has no base URL of
  // its own to resolve a relative path against.
  const ID_CARD_GREEN = '#2e5e1e';

  // Staff photos are stored in Drive (via uploadPhotoToDrive) and PhotoURL
  // holds the normal Drive "view" page link (drive.google.com/file/d/ID/view)
  // — that page URL does NOT serve raw image bytes, so it can't be dropped
  // straight into an <img src>. Converting to the Drive thumbnail endpoint
  // (which DOES serve an actual image, and works for anyone-with-link files,
  // same sharing level uploadPhotoToDrive already sets) is what makes the
  // photo actually render on the card. onerror on the <img> falls back to a
  // "No photo" placeholder rather than a broken-image icon if the thumbnail
  // ever 404s (e.g. file was deleted by retention cleanup).
  function driveFileIdFromUrl(url) {
    if (!url) return null;
    let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    return null;
  }
  function drivePhotoThumbUrl(url, sizePx) {
    const id = driveFileIdFromUrl(url);
    return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w${sizePx || 200}` : '';
  }

  // Horizontal (landscape) layout: logo + staff photo on the left, name/
  // agency/role/code in the middle, QR on the right — standard ID-badge
  // proportions rather than the earlier portrait design.
  function idCardInnerHtml(staff, logoUrl, qrUrl) {
    const photoThumb = staff.PhotoURL ? drivePhotoThumbUrl(staff.PhotoURL, 200) : '';
    const photoBox = `
      <div style="width:84px;height:84px;border-radius:10px;background:#fff;overflow:hidden;display:flex;align-items:center;justify-content:center;flex:0 0 auto;">
        ${photoThumb ? `
          <img src="${photoThumb}" alt="${escapeHtml(staff.Name)}" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <div style="display:none;width:100%;height:100%;align-items:center;justify-content:center;color:#9ca3af;font-size:0.6rem;text-align:center;padding:4px;box-sizing:border-box;">No photo</div>
        ` : `
          <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:0.6rem;text-align:center;padding:4px;box-sizing:border-box;">No photo</div>
        `}
      </div>
    `;
    // Grid layout matching the requested arrangement: logo (top-left) and
    // photo (below it) share a narrow left column across both rows;
    // "STAFF ID" heads the middle column on row 1 with the name/agency/
    // code/role/StaffID stack below it on row 2; the QR code sits in its
    // own column on the right, spanning the full height of both rows (the
    // same named grid-area 'qr' repeated in both template rows merges into
    // one tall cell — that's what makes it span, not a manual row-span).
    return `
      <div style="width:min(440px,94vw);background:${ID_CARD_GREEN};border-radius:18px;padding:18px 20px;color:#fff;font-family:-apple-system,Arial,sans-serif;margin:0 auto;box-sizing:border-box;display:grid;grid-template-columns:92px 1fr auto;grid-template-areas:'logo staffid qr' 'photo info qr';gap:8px 16px;align-items:center;">
        <div style="grid-area:logo;display:flex;justify-content:center;">
          <div style="background:#fff;border-radius:8px;padding:6px 10px;">
            <img src="${logoUrl}" alt="MVOA" style="height:44px;display:block;">
          </div>
        </div>
        <div style="grid-area:staffid;align-self:end;text-align:center;font-size:0.7rem;font-weight:700;letter-spacing:2px;opacity:0.9;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.35);">STAFF ID</div>
        <div style="grid-area:photo;display:flex;justify-content:center;">${photoBox}</div>
        <div style="grid-area:info;min-width:0;align-self:start;padding-top:2px;">
          <div style="font-size:1.05rem;font-weight:700;line-height:1.25;overflow-wrap:break-word;">${escapeHtml(staff.Name)}</div>
          <div style="font-size:0.78rem;opacity:0.92;overflow-wrap:break-word;margin-top:1px;">${escapeHtml(agencyName(staff.AgencyID))}</div>
          <div style="font-family:ui-monospace,Menlo,monospace;font-size:0.95rem;font-weight:700;letter-spacing:3px;margin-top:3px;">${escapeHtml(staff.Code)}</div>
          <div style="font-size:0.72rem;opacity:0.82;margin-top:3px;min-height:1em;">${staff.Role ? escapeHtml(staff.Role) : ''}</div>
          <div style="font-size:0.6rem;opacity:0.7;margin-top:3px;">${escapeHtml(staff.StaffID)}</div>
        </div>
        <div style="grid-area:qr;align-self:center;justify-self:center;background:#fff;border-radius:10px;padding:8px;">
          <img src="${qrUrl}" alt="QR" style="width:96px;height:96px;display:block;">
        </div>
      </div>
    `;
  }

  function showStaffIdCard(staff) {
    const logoUrl = new URL('assets/logo.png', window.location.href).href;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent('MVOA-ATT:' + staff.StaffID)}`;
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box" style="width:min(480px,96vw);max-width:none;">
        ${idCardInnerHtml(staff, logoUrl, qrUrl)}
        <div class="mvoa-row" style="margin-top:16px;justify-content:center;gap:10px;">
          <button id="att-badge-print" class="btn-primary">🖨 Print ID Card</button>
          <button id="att-badge-close" class="btn-secondary">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#att-badge-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#att-badge-print').addEventListener('click', () => printStaffIdCard(staff, logoUrl, qrUrl));
  }

  function printStaffIdCard(staff, logoUrl, qrUrl) {
    const win = window.open('', '_blank');
    win.document.write(`
      <html>
      <head>
        <title>ID Card — ${escapeHtml(staff.Name)}</title>
        <style>
          body { margin:0; padding:24px; display:flex; align-items:center; justify-content:center; min-height:100vh; font-family:-apple-system, Arial, sans-serif; background:#f2f2f2; box-sizing:border-box; }
          @media print { body { background:#fff; padding:0; } @page { size: landscape; } }
        </style>
      </head>
      <body>
        ${idCardInnerHtml(staff, logoUrl, qrUrl)}
        <script>
          window.onload = () => { window.print(); };
        </script>
      </body>
      </html>
    `);
    win.document.close();
  }

  // ─────────────────────────────────────────────
  // ATTENDANCE LOG (Phase 4 — NEW): live daily register + QR / 4-digit
  // code scan check-in/check-out.
  // ─────────────────────────────────────────────
  function logsForDate(dateStr) {
    return allLogsCache.filter(l => l.Date === dateStr);
  }

  function renderAttendanceLogs(host, user, dateStr) {
    const editable = canEditSection(SECTION_LOGS, user);
    const date = dateStr || isoDateLocal(new Date());
    const dayLogs = logsForDate(date);
    const rows = staffCache.slice().sort((a, b) => agencyName(a.AgencyID).localeCompare(agencyName(b.AgencyID)) || a.Name.localeCompare(b.Name));
    // One row per SESSION, not per staff member — a staff member can have
    // more than one session on the same Date (shifts crossing midnight, or
    // two separate shifts in one day), and every one of them stays visible
    // here, not just the latest. Staff with no session that date get a
    // single "Not scanned" row instead.
    const tableRows = [];
    rows.forEach(s => {
      const sessions = dayLogs.filter(x => x.StaffID === s.StaffID).sort((a, b) => a.CheckInTime.localeCompare(b.CheckInTime));
      if (!sessions.length) { tableRows.push({ s, l: null }); return; }
      sessions.forEach(l => tableRows.push({ s, l }));
    });

    // Person-level summary (not session-level): "on-site" means currently
    // has an open session anywhere, regardless of what date it started on
    // — matches the "Currently checked in" panel below, not just this
    // date's rows.
    const openStaffIds = new Set(allLogsCache.filter(l => l.CheckInTime && !l.CheckOutTime).map(l => l.StaffID));
    const scannedTodayIds = new Set(dayLogs.map(l => l.StaffID));
    const onsite = rows.filter(s => openStaffIds.has(s.StaffID)).length;
    const checkedOut = rows.filter(s => scannedTodayIds.has(s.StaffID) && !openStaffIds.has(s.StaffID)).length;
    const notScanned = rows.length - onsite - checkedOut;

    // Shifts cross midnight, so someone can be genuinely on-site right now
    // with their session's Date attributed to YESTERDAY (the day they
    // checked in) — they'd otherwise vanish from today's table entirely.
    // This panel always shows every open session, regardless of the date
    // filter above, so nobody currently on-site is ever invisible.
    const openNow = allLogsCache.filter(l => l.CheckInTime && !l.CheckOutTime)
      .map(l => ({ l, s: staffById(l.StaffID) }))
      .filter(r => r.s)
      .sort((a, b) => a.l.CheckInTime.localeCompare(b.l.CheckInTime));

    host.innerHTML = `
      <div class="card">
        ${openNow.length ? `
          <div style="margin-bottom:14px;padding:10px 12px;background:#e3f1eb;border-radius:8px;">
            <strong style="font-size:0.85rem;">🟢 Currently checked in (${openNow.length})</strong>
            <div class="muted" style="font-size:0.82rem;margin-top:4px;">
              ${openNow.map(({ l, s }) => `${escapeHtml(s.Name)} (${escapeHtml(agencyName(s.AgencyID))}) — since ${escapeHtml(formatTime(l.CheckInTime))}${l.Date !== isoDateLocal(new Date()) ? ' on ' + escapeHtml(l.Date) : ''}`).join('<br>')}
            </div>
          </div>
        ` : ''}
        <div class="mvoa-row" style="margin-bottom:10px;flex-wrap:wrap;gap:10px;align-items:flex-end;">
          <label style="margin:0;">Date
            <input type="date" id="att-log-date" value="${date}" max="${isoDateLocal(new Date())}">
          </label>
          <span class="muted" style="font-size:0.85rem;">On-site (since this date): <strong>${onsite}</strong> · Checked out: <strong>${checkedOut}</strong> · Not scanned: <strong>${notScanned}</strong> · Total active: <strong>${rows.length}</strong></span>
        </div>
        <div class="mvoa-row" style="margin-bottom:14px;gap:10px;flex-wrap:wrap;">
          ${editable ? `
            <button id="att-log-scan" class="btn-primary">📷 Scan QR</button>
            <button id="att-log-code" class="btn-secondary">🔢 Enter Code</button>
          ` : ''}
          <button id="att-log-report" class="btn-secondary">📊 Monthly Report</button>
        </div>
        <div style="max-height:60vh;overflow:auto;">
          <table class="mvoa-table">
            <thead><tr><th>Name</th><th>Agency</th><th>Check-in</th><th>Check-out</th><th>Status</th></tr></thead>
            <tbody>
              ${tableRows.length ? tableRows.map(({ s, l }) => {
                const status = !l ? 'Not scanned' : (l.Status === 'CheckedOut' ? 'Checked out' : 'On-site');
                const statusColor = !l ? '#6b7280' : (l.Status === 'CheckedOut' ? '#41464b' : '#1e6b33');
                return `
                  <tr>
                    <td>${escapeHtml(s.Name)}</td>
                    <td>${escapeHtml(agencyName(s.AgencyID))}</td>
                    <td>${l && l.CheckInTime ? escapeHtml(formatTime(l.CheckInTime)) + (l.CheckInPhotoURL ? ` <a href="${l.CheckInPhotoURL}" target="_blank" rel="noopener">📷</a>` : '') : '—'}</td>
                    <td>${l && l.CheckOutTime ? escapeHtml(formatTime(l.CheckOutTime)) + (l.CheckOutPhotoURL ? ` <a href="${l.CheckOutPhotoURL}" target="_blank" rel="noopener">📷</a>` : '') : '—'}</td>
                    <td style="color:${statusColor};font-weight:600;">${status}</td>
                  </tr>
                `;
              }).join('') : `<tr><td colspan="5" class="muted">No active staff enrolled yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
    host.querySelector('#att-log-date').addEventListener('change', (e) => renderAttendanceLogs(host, user, e.target.value));
    if (editable) {
      host.querySelector('#att-log-scan').addEventListener('click', () => openAttendanceScanner(host, user));
      host.querySelector('#att-log-code').addEventListener('click', () => openCodeEntry(host, user));
    }
    host.querySelector('#att-log-report').addEventListener('click', () => renderMonthlyReport(host, user));
  }

  // Monthly Attendance Report — read-only, so available to anyone who can
  // view the Logs section at all (not gated to `editable`). Lets the user
  // pick a month and optionally narrow to one agency, then shows per-staff
  // Days Present / Sessions / Total Hours for that month, with a
  // "Print to PDF" button using the browser's native print-to-PDF (same
  // pattern as module-hs.js's printTablePdf).
  // Day-of-month helpers shared by the two grid-style reports below.
  function ordinalDay(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function daysInMonthFor(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }
  // How many days of the selected month have actually elapsed — a future
  // month shows no P/A marks at all, the current month stops at today
  // (later days haven't happened yet), and a past month is shown in full.
  function capDayFor(month) {
    const [y, m] = month.split('-').map(Number);
    const today = new Date();
    if (y === today.getFullYear() && m === today.getMonth() + 1) return today.getDate();
    if (y > today.getFullYear() || (y === today.getFullYear() && m > today.getMonth() + 1)) return 0;
    return daysInMonthFor(month);
  }

  // Summary view (original report): one row per staff member with totals
  // for the month.
  function buildSummaryReportHtml(monthLabel, staffPool, monthLogs) {
    const rows = staffPool.map(s => {
      const sessions = monthLogs.filter(l => l.StaffID === s.StaffID);
      const daysPresent = new Set(sessions.map(l => l.Date)).size;
      let totalMs = 0;
      sessions.forEach(l => {
        if (l.CheckInTime && l.CheckOutTime) {
          const ms = new Date(l.CheckOutTime) - new Date(l.CheckInTime);
          if (ms > 0) totalMs += ms;
        }
      });
      const totalHours = totalMs / 3600000;
      return { Name: s.Name, Agency: agencyName(s.AgencyID), Days: daysPresent, Sessions: sessions.length, Hours: totalHours ? totalHours.toFixed(1) : '0.0' };
    });
    return `
      <table class="mvoa-table">
        <thead>
          <tr><th colspan="5" style="text-align:center;">Monthly Attendance Summary — ${escapeHtml(monthLabel)}</th></tr>
          <tr><th>Name</th><th>Agency</th><th>Days Present</th><th>Sessions</th><th>Total Hours</th></tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(r => `
            <tr><td>${escapeHtml(r.Name)}</td><td>${escapeHtml(r.Agency)}</td><td>${r.Days}</td><td>${r.Sessions}</td><td>${r.Hours}</td></tr>
          `).join('') : `<tr><td colspan="5" class="muted">No staff.</td></tr>`}
        </tbody>
      </table>
    `;
  }

  // "Attendance Record" — a P/A grid, one column per day of the month, one
  // row per staff member (grouped visually by agency, agency name shown
  // only on the first row of each group — matches the layout the user
  // asked for). P = at least one session logged that day; A = none, but
  // only for days that have actually happened (see capDayFor).
  function buildAttendancePAGridHtml(month, monthLabel, staffPool, monthLogs) {
    const daysInMonth = daysInMonthFor(month);
    const capDay = capDayFor(month);
    const [y, m] = month.split('-').map(Number);
    const dayHeaders = [];
    for (let d = 1; d <= daysInMonth; d++) dayHeaders.push(ordinalDay(d));

    let lastAgency = null;
    const bodyRows = staffPool.map(s => {
      const ag = agencyName(s.AgencyID);
      const showAgency = ag !== lastAgency;
      lastAgency = ag;
      const sessions = monthLogs.filter(l => l.StaffID === s.StaffID);
      const datesPresent = new Set(sessions.map(l => l.Date));
      const cells = [];
      for (let d = 1; d <= daysInMonth; d++) {
        if (d > capDay) { cells.push('<td></td>'); continue; }
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const present = datesPresent.has(iso);
        cells.push(`<td style="color:${present ? '#1e6b33' : '#b3261e'};font-weight:700;text-align:center;">${present ? 'P' : 'A'}</td>`);
      }
      return `<tr><td>${showAgency ? escapeHtml(ag) : ''}</td><td>${escapeHtml(s.Name)}</td>${cells.join('')}</tr>`;
    });

    return `
      <table class="mvoa-table">
        <thead>
          <tr><th colspan="${2 + daysInMonth}" style="text-align:center;">Attendance Record for the Month of ${escapeHtml(monthLabel)}</th></tr>
          <tr><th>Agency</th><th>Staff Name</th>${dayHeaders.map(h => `<th style="text-align:center;">${h}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${bodyRows.length ? bodyRows.join('') : `<tr><td colspan="${2 + daysInMonth}" class="muted">No staff.</td></tr>`}
        </tbody>
        <tfoot>
          <tr><td colspan="${2 + daysInMonth}" style="font-weight:400;font-size:0.78rem;">
            <span style="color:#1e6b33;font-weight:700;">P</span> = Present (logged in that day) &nbsp;&nbsp;
            <span style="color:#b3261e;font-weight:700;">A</span> = Absent (no login that day)
          </td></tr>
        </tfoot>
      </table>
    `;
  }

  // "Check-in/Check-out Times" — Agency / Staff Name, then a Check-in and
  // Check-out sub-column per day. If a staff member has more than one
  // session on the same day (an overnight shift plus a same-day shift),
  // every session's times are stacked on separate lines within that day's
  // two cells rather than only showing one.
  function buildCheckInOutGridHtml(month, monthLabel, staffPool, monthLogs) {
    const daysInMonth = daysInMonthFor(month);
    const capDay = capDayFor(month);
    const [y, m] = month.split('-').map(Number);
    const dayHeaders = [];
    for (let d = 1; d <= daysInMonth; d++) dayHeaders.push(ordinalDay(d));

    let lastAgency = null;
    const bodyRows = staffPool.map(s => {
      const ag = agencyName(s.AgencyID);
      const showAgency = ag !== lastAgency;
      lastAgency = ag;
      const sessions = monthLogs.filter(l => l.StaffID === s.StaffID).sort((a, b) => a.CheckInTime.localeCompare(b.CheckInTime));
      const cells = [];
      for (let d = 1; d <= daysInMonth; d++) {
        if (d > capDay) { cells.push('<td></td><td></td>'); continue; }
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const daySessions = sessions.filter(l => l.Date === iso);
        if (!daySessions.length) { cells.push('<td>—</td><td>—</td>'); continue; }
        const ins = daySessions.map(l => l.CheckInTime ? escapeHtml(formatTime(l.CheckInTime)) : '—').join('<br>');
        const outs = daySessions.map(l => l.CheckOutTime ? escapeHtml(formatTime(l.CheckOutTime)) : '—').join('<br>');
        cells.push(`<td style="text-align:center;">${ins}</td><td style="text-align:center;">${outs}</td>`);
      }
      return `<tr><td>${showAgency ? escapeHtml(ag) : ''}</td><td>${escapeHtml(s.Name)}</td>${cells.join('')}</tr>`;
    });

    return `
      <table class="mvoa-table">
        <thead>
          <tr><th colspan="${2 + daysInMonth * 2}" style="text-align:center;">Daily Check in/out time Report for the Month of ${escapeHtml(monthLabel)}</th></tr>
          <tr><th rowspan="2">Agency</th><th rowspan="2">Staff Name</th>${dayHeaders.map(h => `<th colspan="2" style="text-align:center;">${h}</th>`).join('')}</tr>
          <tr>${dayHeaders.map(() => `<th style="text-align:center;">Check in</th><th style="text-align:center;">Check out</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${bodyRows.length ? bodyRows.join('') : `<tr><td colspan="${2 + daysInMonth * 2}" class="muted">No staff.</td></tr>`}
        </tbody>
      </table>
    `;
  }

  function renderMonthlyReport(host, user, monthStr, agencyFilter, reportType, staffFilterIds) {
    const month = monthStr || isoDateLocal(new Date()).slice(0, 7); // YYYY-MM
    const agencyId = agencyFilter || 'ALL';
    const type = reportType || 'pa'; // 'summary' | 'pa' | 'times'
    const staffFilter = staffFilterIds || [];

    // Staff pool for the report: active staff, optionally narrowed to one
    // agency. Agencies list includes inactive ones too (allAgenciesCache)
    // so a report can still be pulled for an agency that's since been
    // deactivated, as long as its staff still have log rows. The staff
    // multi-select (Check-in/out view only) further narrows this.
    const staffPoolAll = staffCache.filter(s => agencyId === 'ALL' || s.AgencyID === agencyId)
      .slice().sort((a, b) => agencyName(a.AgencyID).localeCompare(agencyName(b.AgencyID)) || a.Name.localeCompare(b.Name));
    const staffPool = (type === 'times' && staffFilter.length) ? staffPoolAll.filter(s => staffFilter.includes(s.StaffID)) : staffPoolAll;

    const monthLogs = allLogsCache.filter(l => l.Date && l.Date.slice(0, 7) === month);
    const monthLabel = (() => {
      const [y, m] = month.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    })();

    let tableHtml;
    if (type === 'summary') tableHtml = buildSummaryReportHtml(monthLabel, staffPoolAll, monthLogs);
    else if (type === 'times') tableHtml = buildCheckInOutGridHtml(month, monthLabel, staffPool, monthLogs);
    else tableHtml = buildAttendancePAGridHtml(month, monthLabel, staffPoolAll, monthLogs);

    const typeLabel = { summary: 'Summary', pa: 'Attendance Record', times: 'Check-in/Check-out Times' }[type];

    host.innerHTML = `
      <div class="card">
        <button id="att-report-back" class="btn-secondary" style="margin-bottom:14px;">← Back to Attendance Log</button>
        <h3 style="margin-top:0;">📊 Monthly Attendance Report</h3>
        <div class="mvoa-row" style="margin-bottom:10px;gap:8px;flex-wrap:wrap;">
          <button class="${type === 'summary' ? 'btn-primary' : 'btn-secondary'} att-report-type-btn" data-type="summary" style="font-size:0.8rem;padding:6px 12px;">Summary</button>
          <button class="${type === 'pa' ? 'btn-primary' : 'btn-secondary'} att-report-type-btn" data-type="pa" style="font-size:0.8rem;padding:6px 12px;">Attendance Record</button>
          <button class="${type === 'times' ? 'btn-primary' : 'btn-secondary'} att-report-type-btn" data-type="times" style="font-size:0.8rem;padding:6px 12px;">Check-in/Check-out Times</button>
        </div>
        <div class="mvoa-row" style="margin-bottom:14px;gap:14px;flex-wrap:wrap;align-items:flex-start;">
          <label style="margin:0;">Month
            <input type="month" id="att-report-month" value="${escapeHtml(month)}">
          </label>
          <label style="margin:0;">Agency
            <select id="att-report-agency">
              <option value="ALL" ${agencyId === 'ALL' ? 'selected' : ''}>All Agencies</option>
              ${allAgenciesCache.map(a => `<option value="${escapeHtml(a.AgencyID)}" ${a.AgencyID === agencyId ? 'selected' : ''}>${escapeHtml(a.Name)}</option>`).join('')}
            </select>
          </label>
          ${type === 'times' ? `
            <label style="margin:0;">Staff (optional)
              <select id="att-report-staff" multiple size="5" style="min-width:200px;">
                ${staffPoolAll.map(s => `<option value="${escapeHtml(s.StaffID)}" ${staffFilter.includes(s.StaffID) ? 'selected' : ''}>${escapeHtml(s.Name)}</option>`).join('')}
              </select>
              <div class="muted" style="font-size:0.72rem;max-width:200px;margin-top:2px;">Ctrl/Cmd-click (or tap-select on mobile) for multiple. Leave empty for all staff.</div>
            </label>
          ` : ''}
          <button id="att-report-print" class="btn-primary" style="margin-top:22px;">🖨 Print to PDF</button>
        </div>
        <div style="overflow-x:auto;max-height:65vh;overflow-y:auto;">
          ${tableHtml}
        </div>
      </div>
    `;
    host.querySelector('#att-report-back').addEventListener('click', () => renderAttendanceLogs(host, user));
    host.querySelectorAll('.att-report-type-btn').forEach(btn => {
      btn.addEventListener('click', () => renderMonthlyReport(host, user, month, agencyId, btn.dataset.type, staffFilter));
    });
    host.querySelector('#att-report-month').addEventListener('change', (e) => renderMonthlyReport(host, user, e.target.value, agencyId, type, staffFilter));
    // Changing agency invalidates the staff multi-select's option list, so
    // reset that filter rather than carry over StaffIDs that may no longer
    // even be in the dropdown.
    host.querySelector('#att-report-agency').addEventListener('change', (e) => renderMonthlyReport(host, user, month, e.target.value, type, []));
    const staffSel = host.querySelector('#att-report-staff');
    if (staffSel) {
      staffSel.addEventListener('change', (e) => {
        const selected = Array.from(e.target.selectedOptions).map(o => o.value);
        renderMonthlyReport(host, user, month, agencyId, type, selected);
      });
    }
    host.querySelector('#att-report-print').addEventListener('click', () => {
      const agencyLabel = agencyId === 'ALL' ? 'All Agencies' : agencyName(agencyId);
      printReportHtmlPdf(`${typeLabel} — ${monthLabel} — ${agencyLabel}`, tableHtml);
    });
  }

  // Browser print-to-PDF for the monthly report — same pattern as
  // module-hs.js's printTablePdf: opens a blank tab, writes a standalone
  // styled HTML page (reusing the already-built table markup as-is, so the
  // printed layout always matches the on-screen preview exactly), and
  // triggers window.print() on load (user picks "Save as PDF" in the print
  // dialog). Module-local since only this module needs it. Wide grids
  // (a full month, all agencies) print in landscape and may still span
  // multiple pages — narrowing via the Agency/Staff filters before
  // printing keeps it to a single page.
  function printReportHtmlPdf(title, tableHtml) {
    const win = window.open('', '_blank');
    win.document.write(`
      <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: -apple-system, Arial, sans-serif; padding: 24px; color: #1f2937; }
          h1 { color: #2e5e1e; font-size: 1.3rem; margin-bottom: 4px; }
          .muted { color: #6b7280; font-size: 0.85rem; margin-top: 0; }
          table { border-collapse: collapse; margin-top: 16px; width: max-content; max-width: 100%; }
          th, td { border: 1px solid #dde1e6; padding: 5px 7px; text-align: left; font-size: 0.72rem; white-space: nowrap; }
          th { background: #f5f6f8; }
          .back-btn {
            display: inline-block; margin-bottom: 16px; padding: 10px 18px;
            border-radius: 8px; border: none; background: #2e5e1e; color: white;
            font-size: 0.95rem; font-weight: 600; cursor: pointer;
          }
          @media print { .back-btn { display: none; } @page { size: landscape; } }
        </style>
      </head>
      <body>
        <button class="back-btn" id="back-to-app-btn">&larr; Back to App</button>
        <h1>MVOA Staff Attendance — ${escapeHtml(title)}</h1>
        <p class="muted">Generated ${new Date().toLocaleString()}</p>
        ${tableHtml}
        <script>
          window.onload = () => { window.print(); };
          document.getElementById('back-to-app-btn').addEventListener('click', () => {
            window.close();
            setTimeout(() => {
              document.body.innerHTML = '<p style="padding:20px;">You can close this tab/window now and return to the MVOA app in your other tab.</p>';
            }, 300);
          });
        </script>
      </body>
      </html>
    `);
    win.document.close();
  }

  // Applies the check-in/check-out rule for one staff member, right now —
  // always against a FRESH read of AttLog (not the cached allLogsCache),
  // so two gate stations scanning the same person moments apart still
  // can't both "win". This is SESSION-based, not calendar-day-based: a
  // scan closes whichever session is currently OPEN for this staff member
  // (CheckInTime set, CheckOutTime blank), no matter what date that
  // session started on. That's deliberate — staff work shifts that cross
  // midnight (e.g. check in 9pm, check out 7am the next morning), so
  // matching by "does today already have a row" would wrongly treat the
  // 7am check-out scan as a brand new check-in and leave the overnight
  // session open forever. Once a session is closed, its CheckOutTime is
  // never touched again — a later scan always starts a fresh new session
  // rather than overwriting a completed one, which is what "no 3rd scan
  // overwriting the checkout" actually means once shifts aren't confined
  // to a single calendar day.
  async function processAttendanceScan(staffId, photoFile, user) {
    const staff = staffById(staffId);
    if (!staff) return { type: 'error', message: 'Not recognised — this ID is not enrolled.' };
    if (!isActive(staff.Active)) return { type: 'error', message: `${staff.Name} is deactivated.` };

    const now = new Date();
    const nowIso = now.toISOString();
    const rows = await MVOA.sheetsRead(MVOA.TABS.attLog);
    const staffLogs = rowsToObjs(rows, LOG_COLS).filter(l => l.StaffID === staffId);
    const open = staffLogs.filter(l => l.CheckInTime && !l.CheckOutTime)
      .sort((a, b) => b.CheckInTime.localeCompare(a.CheckInTime))[0];

    let photoUrl = '';
    if (photoFile) {
      try {
        photoUrl = await MVOA.uploadPhotoToDrive(photoFile, `${staffId}_${isoDateLocal(now)}_${open ? 'out' : 'in'}.jpg`);
      } catch (e) {
        // A failed photo upload shouldn't block the actual check-in/out —
        // the attendance record itself matters more; log without a photo.
        photoUrl = '';
      }
    }

    if (!open) {
      const existingIds = rows.slice(1).map(r => r[0]).filter(Boolean);
      const logId = MVOA.nextId('LOG', existingIds);
      // Date = the day the shift STARTED (check-in date) — an overnight
      // shift is attributed to the evening it began, not the morning it
      // ended, matching how shift reporting is normally read. See the
      // "Currently checked in" panel in renderAttendanceLogs for staff
      // whose open session started on an earlier date than the one being
      // viewed — the date-filtered table below only matches by this Date.
      await MVOA.sheetsAppend(MVOA.TABS.attLog, [logId, staffId, isoDateLocal(now), nowIso, photoUrl, '', '', 'CheckedIn', (user && user.name) || '']);
      return { type: 'in', message: `${staff.Name} — CHECK-IN at ${formatTime(nowIso)}`, staff };
    } else {
      await MVOA.sheetsUpdateRow(MVOA.TABS.attLog, open.rowNumber,
        [open.LogID, open.StaffID, open.Date, open.CheckInTime, open.CheckInPhotoURL, nowIso, photoUrl, 'CheckedOut', (user && user.name) || '']);
      return { type: 'out', message: `${staff.Name} — CHECK-OUT at ${formatTime(nowIso)}`, staff };
    }
  }

  // QR scan station — a persistent camera modal (stays open across
  // multiple scans, like a real gate station) reusing the same
  // video/canvas/jsQR pattern as Plant Rounds' equipment QR scanner.
  // Per-staff cooldown avoids one held-up badge re-triggering on every
  // animation frame; `processing` pauses decoding while a scan's already
  // being written, so overlapping scans can't race each other client-side.
  function openAttendanceScanner(host, user) {
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box">
        <video id="att-qr-video" autoplay playsinline muted></video>
        <canvas id="att-qr-canvas" style="display:none;"></canvas>
        <p class="muted" id="att-qr-status">Point camera at the staff member's QR badge…</p>
        <button id="att-qr-cancel" class="btn-secondary">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    const video = modal.querySelector('#att-qr-video');
    const canvas = modal.querySelector('#att-qr-canvas');
    const statusEl = modal.querySelector('#att-qr-status');
    let stream, raf, processing = false;
    const cooldown = {};

    async function stop() {
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(t => t.stop());
      modal.remove();
      // Scans write straight to the Sheet without touching allLogsCache —
      // reload it now so the register reflects what was just scanned,
      // instead of re-rendering from the stale pre-scan cache.
      try { await loadAll(true); } catch (e) { /* register just won't refresh this time */ }
      renderAttendanceLogs(host, user);
    }
    modal.querySelector('#att-qr-cancel').addEventListener('click', stop);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(s => { stream = s; video.srcObject = s; tick(); })
      .catch(e => { statusEl.textContent = 'Camera access failed: ' + e.message; });

    function captureFrameAsFile(filename) {
      return new Promise((resolve) => {
        const side = Math.min(video.videoWidth, video.videoHeight);
        const c = document.createElement('canvas');
        c.width = 320; c.height = 320;
        c.getContext('2d').drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 320, 320);
        c.toBlob(blob => resolve(blob ? new File([blob], filename, { type: 'image/jpeg' }) : null), 'image/jpeg', 0.7);
      });
    }

    function tick() {
      if (!processing && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = typeof jsQR === 'function' ? jsQR(img.data, img.width, img.height) : null;
        if (code) {
          const m = (code.data || '').match(/^MVOA-ATT:(.+)$/);
          if (m) {
            const staffId = m[1];
            const nowMs = Date.now();
            if (!cooldown[staffId] || nowMs - cooldown[staffId] > 8000) {
              cooldown[staffId] = nowMs;
              processing = true;
              statusEl.textContent = 'Processing…';
              captureFrameAsFile(`${staffId}_scan.jpg`)
                .then(file => processAttendanceScan(staffId, file, user))
                .then(result => {
                  statusEl.innerHTML = result.type === 'error'
                    ? `⚠️ ${escapeHtml(result.message)}` : `✅ ${escapeHtml(result.message)}`;
                  processing = false;
                  setTimeout(() => { if (statusEl) statusEl.textContent = "Point camera at the staff member's QR badge…"; }, 2500);
                })
                .catch(e => {
                  statusEl.textContent = 'Scan failed: ' + e.message;
                  processing = false;
                });
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
  }

  // 4-digit code fallback — same check-in/out/3rd-scan logic, no camera
  // or photo involved, for staff without a badge or a working camera.
  function openCodeEntry(host, user) {
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    modal.innerHTML = `
      <div class="ops-qr-box">
        <h3 style="margin-top:0;">Enter 4-digit code</h3>
        <input type="text" id="att-code-input" inputmode="numeric" maxlength="4" placeholder="0000" style="width:100%;max-width:200px;font-size:28px;letter-spacing:10px;text-align:center;font-family:ui-monospace,Menlo,monospace;padding:10px;margin:10px 0;">
        <p class="muted" id="att-code-status">Staff types their code, then Submit.</p>
        <div class="mvoa-row">
          <button id="att-code-submit" class="btn-primary">Submit</button>
          <button id="att-code-cancel" class="btn-secondary">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector('#att-code-input');
    const statusEl = modal.querySelector('#att-code-status');
    input.focus();

    async function stop() {
      modal.remove();
      // Same reload as the QR scanner's stop() — the code-entry scan wrote
      // straight to the Sheet, so the register needs a fresh read too.
      try { await loadAll(true); } catch (e) { /* register just won't refresh this time */ }
      renderAttendanceLogs(host, user);
    }
    modal.querySelector('#att-code-cancel').addEventListener('click', stop);

    async function submit() {
      const code = input.value.trim();
      if (!/^\d{4}$/.test(code)) { statusEl.textContent = 'Enter exactly 4 digits.'; return; }
      const staff = allStaffCache.find(s => s.Code === code && isActive(s.Active));
      if (!staff) { statusEl.textContent = 'No active staff member has that code.'; input.value = ''; return; }
      statusEl.textContent = 'Processing…';
      try {
        const result = await processAttendanceScan(staff.StaffID, null, user);
        statusEl.innerHTML = result.type === 'error'
          ? `⚠️ ${escapeHtml(result.message)}` : `✅ ${escapeHtml(result.message)}`;
        input.value = '';
      } catch (e) {
        statusEl.textContent = 'Failed: ' + e.message;
      }
    }
    modal.querySelector('#att-code-submit').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  // ─────────────────────────────────────────────
  // SETTINGS (Phase 3 — NEW): a single Retention (days) value.
  // ─────────────────────────────────────────────
  async function saveSetting(key, value) {
    const rows = await MVOA.sheetsRead(MVOA.TABS.attSettings);
    const existing = rowsToObjs(rows, SETTINGS_COLS).find(o => o.Key === key);
    if (existing) {
      await MVOA.sheetsUpdateRow(MVOA.TABS.attSettings, existing.rowNumber, [key, value]);
    } else {
      await MVOA.sheetsAppend(MVOA.TABS.attSettings, [key, value]);
    }
  }

  function renderSettings(host, user) {
    const editable = canEditSection(SECTION_SETTINGS, user);
    const days = attSettingsCache.RetentionDays || '';
    host.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0;">Attendance Photo Retention</h3>
        <p class="muted" style="margin:0 0 12px;">
          Check-in/check-out photo LINKS on attendance records older than this many days are cleared automatically (the record itself — who, when, status — is always kept). Leave blank or 0 to keep photo links forever.
        </p>
        <p class="muted" style="margin:0 0 12px;font-size:0.82rem;">
          This also deletes the photo file itself from Google Drive to reclaim storage — that part requires the "delete" action to be added to your photo-upload Apps Script (see deployment notes). If that hasn't been added yet, the link here is still cleared on schedule, but the file stays in Drive until the script is updated.
        </p>
        <label>Retention (days)
          <input type="number" id="att-settings-retention" min="0" step="1" value="${escapeHtml(days)}" placeholder="e.g. 90" ${editable ? '' : 'disabled'} style="max-width:150px;">
        </label>
        ${editable ? `
          <div class="mvoa-row" style="margin-top:12px;">
            <button id="att-settings-save" class="btn-primary">Save</button>
          </div>
          <p class="error-text" id="att-settings-error"></p>
          <p class="muted" id="att-settings-saved" style="font-size:0.85rem;"></p>
        ` : ''}
      </div>
    `;
    if (editable) {
      host.querySelector('#att-settings-save').addEventListener('click', async () => {
        const val = host.querySelector('#att-settings-retention').value.trim();
        const errEl = host.querySelector('#att-settings-error');
        const savedEl = host.querySelector('#att-settings-saved');
        errEl.textContent = ''; savedEl.textContent = '';
        if (val && !/^\d+$/.test(val)) { errEl.textContent = 'Enter a whole number of days, or leave blank.'; return; }
        const btn = host.querySelector('#att-settings-save');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          await saveSetting('RetentionDays', val);
          attSettingsCache.RetentionDays = val;
          savedEl.textContent = 'Saved.';
        } catch (e) {
          errEl.textContent = 'Save failed: ' + e.message;
        } finally {
          btn.disabled = false; btn.textContent = 'Save';
        }
      });
    }
  }

  // Passive, best-effort cleanup — fired once per session from mount(),
  // never awaited/blocking. For AttLog rows whose check-out (or check-in,
  // if still open somehow past retention) is older than RetentionDays:
  // deletes the actual photo file(s) from Drive via MVOA.deletePhotoFromDrive
  // (reclaims storage — requires the 'delete' action to have been added to
  // the photoUploadUrl Apps Script; see deployment notes), THEN clears the
  // link from the Sheet regardless of whether the Drive delete succeeded —
  // a stale link pointing at nothing is still worth clearing even if the
  // file couldn't be removed (e.g. the script hasn't been updated yet).
  // Capped at 40 rows per run so a large first-time backlog doesn't fire
  // dozens of writes/deletes at once — it catches up gradually over the
  // next several app opens instead.
  async function runPhotoRetentionCleanup() {
    try {
      const days = parseInt(attSettingsCache.RetentionDays, 10);
      if (!days || days <= 0) return; // blank/0 = keep forever
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const logRows = await MVOA.sheetsRead(MVOA.TABS.attLog);
      const logs = rowsToObjs(logRows, LOG_COLS);
      let cleaned = 0;
      for (const l of logs) {
        if (cleaned >= 40) break;
        if (!l.CheckInPhotoURL && !l.CheckOutPhotoURL) continue;
        const refDate = l.CheckOutTime || l.CheckInTime;
        if (!refDate || new Date(refDate) >= cutoff) continue;
        try {
          if (l.CheckInPhotoURL) { try { await MVOA.deletePhotoFromDrive(l.CheckInPhotoURL); } catch (e) { /* Drive file may already be gone, or script not updated yet — still clear the link below */ } }
          if (l.CheckOutPhotoURL) { try { await MVOA.deletePhotoFromDrive(l.CheckOutPhotoURL); } catch (e) { /* same as above */ } }
          await MVOA.sheetsUpdateRow(MVOA.TABS.attLog, l.rowNumber,
            [l.LogID, l.StaffID, l.Date, l.CheckInTime, '', l.CheckOutTime, '', l.Status, l.LoggedBy]);
          cleaned++;
        } catch (e) { /* best-effort — retried next session */ }
      }
    } catch (e) { /* best-effort — retention cleanup should never block the app */ }
  }

  MVOA.registerModule('attendance', {
    label: 'Staff Attendance',
    icon: '🪪',
    roles: ['ALL'],
    init: mount
  });
})();
