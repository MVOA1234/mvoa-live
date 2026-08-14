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
//   Phase 3 (next)            — Settings (retention days for old scan
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
// whether they can change data. DEV role always has full access.
// Phase 2 adds a second Section, 'Staff', independent of 'Agencies' —
// e.g. Security can be given view-only on Staff but no Agencies access
// at all, just by adding/omitting the relevant matrix rows.
// ═══════════════════════════════════════════════════════════════
(function () {
  const AGENCY_COLS = ['AgencyID', 'Name', 'Type', 'Active', 'CreatedDate', 'CreatedBy'];
  const STAFF_COLS = ['StaffID', 'AgencyID', 'Name', 'Role', 'Phone', 'AadhaarNumber', 'AadhaarPhotoURL', 'Code', 'PhotoURL', 'Active', 'CreatedDate', 'CreatedBy'];
  const SECTION_AGENCIES = 'Agencies';
  const SECTION_STAFF = 'Staff';
  const NAV_TABS = [
    { key: SECTION_AGENCIES, label: 'Agencies' },
    { key: SECTION_STAFF, label: 'Staff' }
  ];

  let allAgenciesCache = [];   // every agency, active or not — used for name lookups so a
                                // staff member's agency name still resolves even after that
                                // agency is deactivated
  let agenciesCache = [];      // active agencies only — used for lists/dropdowns
  let allStaffCache = [];      // every staff row, active or not — used for StaffID/Code
                                // uniqueness checks (a deactivated staff member's code must
                                // still be treated as taken, not recycled)
  let staffCache = [];         // active staff only — used for the list/table

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

  function canEditSection(section, user) { return MVOA.canEditAttendanceSection(section, user); }
  function canViewSection(section, user) { return MVOA.canViewAttendanceSection(section, user); }

  async function loadAll(force) {
    const [agencyRows, staffRows] = await Promise.all([
      MVOA.sheetsRead(MVOA.TABS.attAgencies),
      MVOA.sheetsRead(MVOA.TABS.attStaff),
      MVOA.loadAttendancePermissionsMatrix(force)
    ]);
    allAgenciesCache = rowsToObjs(agencyRows, AGENCY_COLS);
    agenciesCache = allAgenciesCache.filter(a => isActive(a.Active));
    allStaffCache = rowsToObjs(staffRows, STAFF_COLS);
    staffCache = allStaffCache.filter(s => isActive(s.Active));
  }

  function agencyName(agencyId) {
    const a = allAgenciesCache.find(x => x.AgencyID === agencyId);
    return a ? a.Name : agencyId;
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
    else renderAgenciesList(host, user);
  }

  // ─────────────────────────────────────────────
  // AGENCIES (Phase 1 — same logic as before, now rendering into the
  // tab body `host` instead of the whole module container)
  // ─────────────────────────────────────────────
  function renderAgenciesList(host, user) {
    const editable = canEditSection(SECTION_AGENCIES, user);
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
      host.querySelector('#att-agency-add').addEventListener('click', () => renderAgencyForm(host, null, user));
      host.querySelectorAll('.att-agency-edit').forEach(btn => btn.addEventListener('click', () => {
        const a = agenciesCache.find(x => x.AgencyID === btn.dataset.id);
        if (a) renderAgencyForm(host, a, user);
      }));
      host.querySelectorAll('.att-agency-delete').forEach(btn => btn.addEventListener('click', () => confirmDeleteAgency(host, btn.dataset.id, user)));
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
    const rows = staffCache.slice().sort((a, b) => agencyName(a.AgencyID).localeCompare(agencyName(b.AgencyID)) || a.Name.localeCompare(b.Name));
    host.innerHTML = `
      <div class="card">
        <p class="muted" style="margin:0 0 10px;">
          Staff enrolled per agency, with photo, Aadhaar and a 4-digit attendance code for gate entry.
          QR scanning and attendance registers are being added in the next phase.
        </p>
        ${editable ? `
          <button id="att-staff-add" class="btn-primary" style="margin-bottom:12px;" ${agenciesCache.length ? '' : 'disabled'}>+ Add Staff</button>
          ${agenciesCache.length ? '' : '<p class="muted" style="margin:0 0 12px;">Add an agency first (Agencies tab) before enrolling staff.</p>'}
        ` : ''}
        <table class="mvoa-table">
          <thead><tr><th>Name</th><th>Agency</th><th>Role</th><th>Code</th>${editable ? '<th></th>' : ''}</tr></thead>
          <tbody>
            ${rows.length ? rows.map(s => `
              <tr>
                <td>${escapeHtml(s.Name)}</td>
                <td>${escapeHtml(agencyName(s.AgencyID))}</td>
                <td>${escapeHtml(s.Role)}</td>
                <td style="font-family:ui-monospace,Menlo,monospace;letter-spacing:2px;">${escapeHtml(s.Code)}</td>
                ${editable ? `
                  <td style="white-space:nowrap;">
                    <button class="btn-secondary att-staff-edit" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;">Edit</button>
                    <button class="btn-secondary att-staff-delete" data-id="${escapeHtml(s.StaffID)}" style="font-size:0.8rem;padding:4px 10px;">Deactivate</button>
                  </td>` : ''}
              </tr>
            `).join('') : `<tr><td colspan="${editable ? 5 : 4}" class="muted">No staff enrolled yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
    if (editable) {
      const addBtn = host.querySelector('#att-staff-add');
      if (addBtn) addBtn.addEventListener('click', () => renderStaffForm(host, null, user));
      host.querySelectorAll('.att-staff-edit').forEach(btn => btn.addEventListener('click', () => {
        const s = staffCache.find(x => x.StaffID === btn.dataset.id);
        if (s) renderStaffForm(host, s, user);
      }));
      host.querySelectorAll('.att-staff-delete').forEach(btn => btn.addEventListener('click', () => confirmDeleteStaff(host, btn.dataset.id, user)));
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

  MVOA.registerModule('attendance', {
    label: 'Staff Attendance',
    icon: '🪪',
    roles: ['ALL'],
    init: mount
  });
})();
