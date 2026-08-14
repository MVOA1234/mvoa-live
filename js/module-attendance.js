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
//   Phase 3 (THIS UPDATE)     — Settings: a single "Retention (days)"
//                                 value. Attendance records (who/when/
//                                 status) are kept forever — only the
//                                 CheckIn/CheckOutPhotoURL LINKS on old
//                                 AttLog rows are cleared once they pass
//                                 this age, run passively (best-effort,
//                                 once per session) whenever the module
//                                 opens. This does NOT delete the actual
//                                 photo file from Google Drive — clearing
//                                 the link in the Sheet is all this app
//                                 can do client-side; reclaiming Drive
//                                 storage itself would need a small addition
//                                 to the photoUploadUrl Apps Script, which
//                                 lives outside this codebase. NOTE: there
//                                 is no separate app PIN — access is
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
        <div class="mvoa-row" style="margin-bottom:12px;gap:8px;">
          ${accessibleTabs.map(t => `<button class="${t.key === activeTab ? 'btn-primary' : 'btn-secondary'} att-tab-btn" data-tab="${t.key}">${t.label}</button>`).join('')}
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
        <table class="mvoa-table">
          <thead><tr><th>Name</th><th>Type</th>${editable ? '<th></th>' : ''}</tr></thead>
          <tbody>
            ${rows.length ? rows.map(a => `
              <tr>
                <td>${escapeHtml(a.Name)}</td>
                <td>${escapeHtml(a.Type)}</td>
                ${editable ? `
                  <td style="white-space:normal;">
                    <button class="btn-secondary att-agency-edit" data-id="${escapeHtml(a.AgencyID)}" style="font-size:0.8rem;padding:4px 10px;">Edit</button>
                    <button class="btn-secondary att-agency-delete" data-id="${escapeHtml(a.AgencyID)}" style="font-size:0.8rem;padding:4px 10px;">Deactivate</button>
                    ${canHardDelete ? `<button class="btn-secondary att-agency-harddelete" data-id="${escapeHtml(a.AgencyID)}" style="font-size:0.8rem;padding:4px 10px;color:#b3261e;">Delete</button>` : ''}
                  </td>` : ''}
              </tr>
            `).join('') : `<tr><td colspan="${editable ? 3 : 2}" class="muted">No agencies yet.</td></tr>`}
          </tbody>
        </table>
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
          Use "QR" to view/print a staff member's scan badge.
        </p>
        ${editable ? `
          <button id="att-staff-add" class="btn-primary" style="margin-bottom:12px;" ${agenciesCache.length ? '' : 'disabled'}>+ Add Staff</button>
          ${agenciesCache.length ? '' : '<p class="muted" style="margin:0 0 12px;">Add an agency first (Agencies tab) before enrolling staff.</p>'}
        ` : ''}
        <table class="mvoa-table">
          <thead><tr><th>Name</th><th>Agency</th><th>Role</th><th>Code</th><th></th></tr></thead>
          <tbody>
            ${rows.length ? rows.map(s => `
              <tr>
                <td>${escapeHtml(s.Name)}</td>
                <td>${escapeHtml(agencyName(s.AgencyID))}</td>
                <td>${escapeHtml(s.Role)}</td>
                <td style="font-family:ui-monospace,Menlo,monospace;letter-spacing:2px;">${escapeHtml(s.Code)}</td>
                <td style="white-space:normal;">
                  <button class="btn-secondary att-staff-qr" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;">QR</button>
                  ${editable ? `
                    <button class="btn-secondary att-staff-edit" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;">Edit</button>
                    <button class="btn-secondary att-staff-delete" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;">Deactivate</button>
                    ${canHardDelete ? `<button class="btn-secondary att-staff-harddelete" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;color:#b3261e;">Delete</button>` : ''}
                  ` : ''}
                </td>
              </tr>
            `).join('') : `<tr><td colspan="5" class="muted">No staff enrolled yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
    host.querySelectorAll('.att-staff-qr').forEach(btn => btn.addEventListener('click', () => {
      const s = staffCache.find(x => x.StaffID === btn.dataset.id);
      if (s) showStaffQrBadge(s);
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

  // Read-only QR badge viewer/printer — generates the same 'MVOA-ATT:'
  // payload the scanner expects via a public QR-image API (no new QR-
  // generation library needed client-side, mirroring how this app already
  // depends on external services for Sheets/Drive). Staff ID only, no
  // personal data, is encoded in the image.
  function showStaffQrBadge(staff) {
    const modal = document.createElement('div');
    modal.className = 'ops-qr-modal';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent('MVOA-ATT:' + staff.StaffID)}`;
    modal.innerHTML = `
      <div class="ops-qr-box">
        <h3 style="margin-top:0;">${escapeHtml(staff.Name)}</h3>
        <p class="muted" style="margin:0 0 10px;">${escapeHtml(agencyName(staff.AgencyID))}${staff.Role ? ' · ' + escapeHtml(staff.Role) : ''}</p>
        <img src="${qrUrl}" alt="QR badge" style="width:200px;height:200px;">
        <p class="muted" style="margin:10px 0;">Scan to check in/out · Code: <strong>${escapeHtml(staff.Code)}</strong></p>
        <div class="mvoa-row">
          <button id="att-badge-close" class="btn-secondary">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#att-badge-close').addEventListener('click', () => modal.remove());
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
        ${editable ? `
          <div class="mvoa-row" style="margin-bottom:14px;gap:10px;">
            <button id="att-log-scan" class="btn-primary">📷 Scan QR</button>
            <button id="att-log-code" class="btn-secondary">🔢 Enter Code</button>
          </div>
        ` : ''}
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
          Note: this only clears the link stored here — it does not delete the photo file itself from Google Drive. Reclaiming that storage would need to be done separately in Drive, or by extending the photo-upload script.
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
  // never awaited/blocking. Clears CheckInPhotoURL/CheckOutPhotoURL on
  // AttLog rows whose check-out (or check-in, if still open somehow past
  // retention) is older than RetentionDays. Capped at 40 rows per run so
  // a large first-time backlog doesn't fire dozens of writes at once —
  // it just catches up gradually over the next several app opens instead.
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
