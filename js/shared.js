// ═══════════════════════════════════════════════════════════════
// MVOA SHARED INFRASTRUCTURE
// Used by: MVOA_Live.html (shell) and every module-*.js file
// ═══════════════════════════════════════════════════════════════

const MVOA = (function () {

  // ───────────────────────────────────────────────────────────
  // CONFIG (filled in by setup screen / localStorage, same pattern
  // as the existing Inventory/Spares/O&M apps)
  // ───────────────────────────────────────────────────────────
  const CFG = {
    sheetId: '',
    apiKey: '',
    saJson: null,   // parsed service-account JSON {client_email, private_key, ...}
    driveFolderId: '',     // Google Drive folder where photos get uploaded
    photoUploadUrl: '',    // Apps Script Web App URL (proxy that uploads under a real Google account's quota)
    photoUploadSecret: ''  // shared secret matching the Apps Script's SHARED_SECRET
  };

  function loadConfig() {
    try {
      const raw = localStorage.getItem('mvoa_cfg');
      if (raw) {
        const saved = JSON.parse(raw);
        Object.assign(CFG, saved);
      }
    } catch (e) { console.warn('[MVOA] config load failed', e); }
    return CFG;
  }

  function saveConfig(partial) {
    Object.assign(CFG, partial);
    localStorage.setItem('mvoa_cfg', JSON.stringify(CFG));
  }

  // ───────────────────────────────────────────────────────────
  // SHEET TAB NAMES — central place to rename a tab without
  // hunting through module files
  // ───────────────────────────────────────────────────────────
  const TABS = {
    roles: 'Roles',
    auditLog: 'AuditLog',
    opsTasks: 'OpsTasks',
    opsCategories: 'OpsCategories',
    technicians: 'Technicians',
    opsTaskNotes: 'OpsTaskNotes',
    hsTemplates: 'HSChecklistTemplates',
    hsItems: 'HSChecklistItems',
    hsItemOptions: 'HSChecklistItemOptions',
    hsLog: 'HSChecklistLog',
    hsItemResults: 'HSChecklistItemResults',
    expenseRequests: 'Expense_Requests',
    expenseVotes: 'Expense_Votes',
    approvalMatrix: 'ApprovalMatrix',
    permissionsMatrixDailyOps: 'PermissionsMatrix_DailyOps'
  };

  // ───────────────────────────────────────────────────────────
  // GOOGLE SHEETS API (read via API key, write via service-account JWT)
  // ───────────────────────────────────────────────────────────
  const NETWORK_TIMEOUT_MS = 15000;

  // A stalled connection on some networks doesn't reject a fetch() —
  // it just never resolves, leaving screens stuck on "Loading…"
  // forever with no error to show. This wraps fetch with an
  // AbortController so a stuck request fails visibly within 15s
  // instead of hanging indefinitely.
  async function fetchWithTimeout(url, options, timeoutMs = NETWORK_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s — check your connection: ${url}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sheetsRead(sheetName) {
    // Uses the service-account token, not the plain API key — a bare API key
    // can only read spreadsheets that are public ("anyone with the link"),
    // and this Sheet is intentionally kept Restricted. The service account
    // already has Editor access, so reuse that for reads too.
    const token = await getServiceAccountToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(sheetName)}`;
    const r = await fetchWithTimeout(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Sheets read error (${sheetName}): ${r.status} ${body}`);
    }
    const d = await r.json();
    return d.values || [];
  }

  async function sheetsWrite(sheetName, data) {
    const token = await getServiceAccountToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(sheetName)}?valueInputOption=RAW&key=${CFG.apiKey}`;
    const r = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ range: sheetName, majorDimension: 'ROWS', values: data })
    });
    if (!r.ok) throw new Error(`Sheets write error (${sheetName}): ${r.status}`);
    return r.json();
  }

  async function sheetsAppend(sheetName, row) {
    const token = await getServiceAccountToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ range: sheetName, majorDimension: 'ROWS', values: [row] })
    });
    if (!r.ok) throw new Error(`Sheets append error (${sheetName}): ${r.status}`);
    return r.json();
  }

  // batch append for multiple rows (e.g. logging several vote rows at once)
  async function sheetsAppendMany(sheetName, rows) {
    if (!rows.length) return;
    const token = await getServiceAccountToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ range: sheetName, majorDimension: 'ROWS', values: rows })
    });
    if (!r.ok) throw new Error(`Sheets append error (${sheetName}): ${r.status}`);
    return r.json();
  }

  // Updates one specific row (1-based, including the header as row 1) —
  // used to edit an existing record in place, e.g. closing an OpsTask.
  async function sheetsUpdateRow(sheetName, rowNumber, rowValues) {
    const token = await getServiceAccountToken();
    const range = `${sheetName}!A${rowNumber}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    const r = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: [rowValues] })
    });
    if (!r.ok) throw new Error(`Sheets update error (${sheetName} row ${rowNumber}): ${r.status}`);
    return r.json();
  }

  // Service Account JWT token generation (cached until near-expiry)
  let saTokenCache = { token: '', expires: 0 };
  async function getServiceAccountToken() {
    if (Date.now() < saTokenCache.expires) return saTokenCache.token;
    const sa = CFG.saJson;
    if (!sa) throw new Error('No service account configured');
    const now = Math.floor(Date.now() / 1000);
    const b64url = s => s.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const header = b64url(btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claim = b64url(btoa(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
    })));
    const sigInput = header + '.' + claim;
    const pemBody = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const keyBuf = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', keyBuf, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput));
    const sigB64 = b64url(btoa(String.fromCharCode(...new Uint8Array(sig))));
    const jwt = sigInput + '.' + sigB64;
    const resp = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const tok = await resp.json();
    if (!tok.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(tok));
    saTokenCache = { token: tok.access_token, expires: Date.now() + (tok.expires_in - 60) * 1000 };
    return tok.access_token;
  }

  // ───────────────────────────────────────────────────────────
  // PIN / ROLE AUTH
  // ───────────────────────────────────────────────────────────
  async function hashPin(pin) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode('MVOA_SALT_2026_' + pin));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function verifyPin(pin, hash) { return (await hashPin(pin)) === hash; }

  let rolesCache = null;
  async function loadRoles(force) {
    if (rolesCache && !force) return rolesCache;
    const rows = await sheetsRead(TABS.roles);
    if (!rows.length) { rolesCache = []; return rolesCache; }
    // Expected columns: Name | Role | PIN_Hash | Phone | Email | Active | EC_Member
    rolesCache = rows.slice(1).map((r, i) => ({
      rowNumber: i + 2,
      name: r[0] || '', role: r[1] || '', pinHash: r[2] || '',
      phone: r[3] || '', email: r[4] || '',
      active: ['true', 'TRUE', '1', 'yes'].includes(String(r[5])),
      ecMember: ['true', 'TRUE', '1', 'yes'].includes(String(r[6])),
      title: r[7] || '', // optional per-person display title, e.g. "Secretary" — overrides roleLabel() on screen only
      adminAccess: ['true', 'TRUE', '1', 'yes'].includes(String(r[8])) // grants unmasked connection settings + PIN Management, independent of Title
    })).filter(u => u.name);
    return rolesCache;
  }

  // DEV always counts as admin. Anyone else needs AdminAccess=TRUE on their
  // Roles row. This is the single gate for: seeing connection credentials
  // unmasked, and access to the PIN Management screen (reset/suspend/rename
  // OTHER people — not to be confused with Change My Own PIN, which stays
  // available to everyone regardless of this flag).
  function isAdmin(user) {
    return !!user && (user.role === 'DEV' || user.adminAccess === true);
  }

  let currentUser = null;
  async function login(pin, name) {
    const users = await loadRoles();
    if (name) {
      const u = users.find(u => u.name === name);
      if (!u || !u.active) throw new Error('Invalid PIN');
      if (await verifyPin(pin, u.pinHash)) {
        currentUser = u;
        sessionStorage.setItem('mvoa_user', JSON.stringify(u));
        return u;
      }
      throw new Error('Invalid PIN');
    }
    // Fallback (no name selected): scan all active users, slower but
    // keeps old behavior working if the dropdown ever fails to load.
    for (const u of users) {
      if (!u.active) continue;
      if (await verifyPin(pin, u.pinHash)) {
        currentUser = u;
        sessionStorage.setItem('mvoa_user', JSON.stringify(u));
        return u;
      }
    }
    throw new Error('Invalid PIN');
  }

  function restoreSession() {
    try {
      const raw = sessionStorage.getItem('mvoa_user');
      if (raw) currentUser = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return currentUser;
  }

  function logout() {
    currentUser = null;
    sessionStorage.removeItem('mvoa_user');
  }

  // Self-service PIN change for the currently logged-in user. Re-verifies
  // the current PIN against the live sheet (not the cached/session copy)
  // before allowing the change, so a stale local session can't be used
  // to silently overwrite someone else's PIN.
  async function changePin(currentPin, newPin) {
    if (!currentUser) throw new Error('Not logged in.');
    const users = await loadRoles(true);
    const fresh = users.find(u => u.name === currentUser.name);
    if (!fresh) throw new Error('Your user record could not be found — contact a Developer.');
    const ok = await verifyPin(currentPin, fresh.pinHash);
    if (!ok) throw new Error('Current PIN is incorrect.');
    const newHash = await hashPin(newPin);
    fresh.pinHash = newHash;
    await writeRolesRow(fresh);
    currentUser = fresh;
    sessionStorage.setItem('mvoa_user', JSON.stringify(currentUser));
    await logAudit({ module: 'Settings', requestId: currentUser.name, eventType: 'PinChanged', comment: 'Self-service PIN change', statusAfter: 'Active' });
  }

  const DEFAULT_RESET_PIN = '1111';

  function writeRolesRow(u) {
    return sheetsUpdateRow(TABS.roles, u.rowNumber, [
      u.name, u.role, u.pinHash, u.phone, u.email,
      u.active ? 'TRUE' : 'FALSE', u.ecMember ? 'TRUE' : 'FALSE', u.title || '',
      u.adminAccess ? 'TRUE' : 'FALSE'
    ]);
  }

  // Resets someone else's PIN back to the standard default. The Developer's
  // own row can ONLY be reset by the Developer themselves — mirrors the
  // "Developer's PIN can only be reset by the Developer" rule from the
  // Inventory app's user-management pattern.
  async function resetUserPin(targetName) {
    if (!isAdmin(currentUser)) throw new Error('Not authorized.');
    const users = await loadRoles(true);
    const target = users.find(u => u.name === targetName);
    if (!target) throw new Error('User not found.');
    if (target.role === 'DEV' && currentUser.role !== 'DEV') {
      throw new Error("Only the Developer can reset the Developer's PIN.");
    }
    target.pinHash = await hashPin(DEFAULT_RESET_PIN);
    await writeRolesRow(target);
    await logAudit({ module: 'Settings', requestId: targetName, eventType: 'PinReset', comment: 'Reset by ' + currentUser.name, statusAfter: 'Active' });
    return DEFAULT_RESET_PIN;
  }

  // Suspend immediately blocks login (Active=FALSE); Activate restores it.
  async function setUserActive(targetName, active) {
    if (!isAdmin(currentUser)) throw new Error('Not authorized.');
    const users = await loadRoles(true);
    const target = users.find(u => u.name === targetName);
    if (!target) throw new Error('User not found.');
    if (target.role === 'DEV' && currentUser.role !== 'DEV') {
      throw new Error("Only the Developer can suspend/activate the Developer's account.");
    }
    target.active = !!active;
    await writeRolesRow(target);
    await logAudit({ module: 'Settings', requestId: targetName, eventType: active ? 'UserActivated' : 'UserSuspended', comment: 'By ' + currentUser.name, statusAfter: active ? 'Active' : 'Suspended' });
    // If an admin suspends their OWN account, force them out immediately.
    if (!active && currentUser.name === targetName) logout();
  }

  // Corrects a person's display name (e.g. fixing a typo) — same person,
  // same PIN, same historical records under the old name. This is NOT
  // for handing a position to a different person — that should be a new
  // row, so that audit history stays correctly attributed per individual.
  async function renameUser(targetName, newName) {
    if (!isAdmin(currentUser)) throw new Error('Not authorized.');
    newName = (newName || '').trim();
    if (!newName) throw new Error('New name cannot be blank.');
    const users = await loadRoles(true);
    const target = users.find(u => u.name === targetName);
    if (!target) throw new Error('User not found.');
    if (users.some(u => u.name !== targetName && u.name.toLowerCase() === newName.toLowerCase())) {
      throw new Error('Another user already has that name.');
    }
    const oldName = target.name;
    target.name = newName;
    await writeRolesRow(target);
    await logAudit({ module: 'Settings', requestId: newName, eventType: 'UserRenamed', comment: oldName + ' → ' + newName, statusAfter: 'Active' });
    if (currentUser.name === oldName) {
      currentUser.name = newName;
      sessionStorage.setItem('mvoa_user', JSON.stringify(currentUser));
    }
  }

  function getUser() { return currentUser; }

  // Friendly display names for role codes — the codes themselves (DEV, FM,
  // TRES, SEC, EC, OPS) are what all access-control logic checks against,
  // this is purely cosmetic for what's shown on screen.
  const ROLE_LABELS = {
    DEV: 'Developer',
    FM: 'Facility Manager',
    OPS: 'Operations Staff',
    SEC: 'Security',
    TRES: 'Treasurer',
    EC: 'Executive Committee'
  };
  function roleLabel(code) {
    return ROLE_LABELS[code] || code || '';
  }
  // Per-person display title (e.g. "Secretary", "President") if set on
  // their Roles row, falling back to the generic role-code label. This
  // is purely cosmetic — access-control logic always uses user.role.
  function displayTitle(user) {
    if (!user) return '';
    return user.title || roleLabel(user.role);
  }

  // ───────────────────────────────────────────────────────────
  // TASK NOTES — per-task comment thread in OpsTaskNotes tab.
  // Columns: NoteID | TaskID | Author | Timestamp | Note
  // Notes are loaded fresh each time (no persistent cache) since
  // they're shown on demand when the user expands a thread.
  // ───────────────────────────────────────────────────────────
  async function loadNotesForTask(taskId) {
    const rows = await sheetsRead(TABS.opsTaskNotes);
    if (!rows.length) return [];
    return rows.slice(1)
      .map(r => ({ NoteID: r[0]||'', TaskID: r[1]||'', Author: r[2]||'', Timestamp: r[3]||'', Note: r[4]||'' }))
      .filter(n => n.NoteID && n.TaskID === taskId);
  }

  async function appendNote(taskId, noteText) {
    if (!currentUser) throw new Error('Not logged in.');
    const allRows = await sheetsRead(TABS.opsTaskNotes);
    const existing = allRows.slice(1).map(r => r[0] || '').filter(Boolean);
    const noteId = nextId('NOTE', existing);
    const now = new Date().toISOString();
    await sheetsAppend(TABS.opsTaskNotes, [noteId, taskId, currentUser.name, now, noteText]);
    await logAudit({ module: 'DailyOps', requestId: taskId, eventType: 'NoteAdded', comment: noteText.slice(0, 80), statusAfter: 'Open' });
    return { NoteID: noteId, TaskID: taskId, Author: currentUser.name, Timestamp: now, Note: noteText };
  }


  // Columns (OpsCategories): CategoryID | Name | Icon | Color |
  //   AllowedRoles | AllowedUsers | Active | SortOrder
  // Columns (Technicians): TechnicianID | Name | Contact | Active
  // ───────────────────────────────────────────────────────────
  let categoriesCache = null;
  async function loadCategories(force) {
    if (categoriesCache && !force) return categoriesCache;
    const rows = await sheetsRead(TABS.opsCategories);
    if (!rows.length) { categoriesCache = []; return categoriesCache; }
    categoriesCache = rows.slice(1).map((r, i) => ({
      rowNumber: i + 2,
      CategoryID: r[0] || '', Name: r[1] || '', Icon: r[2] || '', Color: r[3] || '',
      AllowedRoles: (r[4] || '').split(',').map(s => s.trim()).filter(Boolean),
      AllowedUsers: (r[5] || '').split(',').map(s => s.trim()).filter(Boolean),
      Active: ['true', 'TRUE', '1', 'yes'].includes(String(r[6])),
      SortOrder: parseInt(r[7], 10) || 0
    })).filter(c => c.CategoryID);
    categoriesCache.sort((a, b) => a.SortOrder - b.SortOrder);
    return categoriesCache;
  }

  let techniciansCache = null;
  async function loadTechnicians(force) {
    if (techniciansCache && !force) return techniciansCache;
    const rows = await sheetsRead(TABS.technicians);
    if (!rows.length) { techniciansCache = []; return techniciansCache; }
    techniciansCache = rows.slice(1).map((r, i) => ({
      rowNumber: i + 2,
      TechnicianID: r[0] || '', Name: r[1] || '', Contact: r[2] || '',
      Active: ['true', 'TRUE', '1', 'yes'].includes(String(r[3]))
    })).filter(t => t.TechnicianID);
    return techniciansCache;
  }

  // ───────────────────────────────────────────────────────────
  // PERMISSIONS MATRIX (Daily Ops) — Section | Title | AccessLevel.
  // "Section" is a category Name (must match OpsCategories.Name exactly),
  // "Title" is a person's displayTitle() (their Roles.Title override, or
  // the role-code label if blank), "AccessLevel" is Edit or ReadOnly.
  // This is the authoritative source for category edit rights once a
  // category has ANY rows here — canEditCategory() only falls back to
  // the legacy AllowedRoles/AllowedUsers columns for categories that
  // have no matrix rows at all yet, so migration can happen one
  // category at a time without breaking the ones not yet migrated.
  // ───────────────────────────────────────────────────────────
  let dailyOpsPermMatrixCache = null;
  let dailyOpsPermMatrixRowsCache = null; // raw rows incl. rowNumber, for the editable grid — separate from
                                           // the lookup map above since canEditCategory/canViewCategory only
                                           // ever need the resolved level, never a row to write back to.
  async function loadDailyOpsPermissionsMatrix(force) {
    if (dailyOpsPermMatrixCache && !force) return dailyOpsPermMatrixCache;
    const rows = await sheetsRead(TABS.permissionsMatrixDailyOps);
    const map = {}; // map[Section][Title] = 'Edit' | 'ReadOnly'
    const rawRows = [];
    rows.slice(1).forEach((r, i) => {
      const section = (r[0] || '').trim();
      const title = (r[1] || '').trim();
      const level = (r[2] || '').trim();
      if (!section || !title) return; // truly blank/junk row — nothing to track
      rawRows.push({ rowNumber: i + 2, Section: section, Title: title, AccessLevel: level });
      if (!level) return; // row exists but was blanked back to "No access" — keep in rawRows, skip in map
      if (!map[section]) map[section] = {};
      map[section][title] = level;
    });
    dailyOpsPermMatrixCache = map;
    dailyOpsPermMatrixRowsCache = rawRows;
    return dailyOpsPermMatrixCache;
  }

  // Raw rows (with sheet rowNumber) for the editable grid — must call
  // loadDailyOpsPermissionsMatrix at least once first (mirrors the
  // pattern other cached loaders use).
  function getDailyOpsPermissionsMatrixRows() {
    return dailyOpsPermMatrixRowsCache || [];
  }

  // DEV role always has full access. Otherwise: if the category's Name
  // has any rows in the Daily Ops permissions matrix, that matrix is
  // authoritative — the user's displayTitle() must have an explicit
  // Edit row, or they don't get edit access (a ReadOnly or missing row
  // both mean no edit, even if their old Role code would have qualified).
  // Only categories with NO matrix rows at all fall back to the legacy
  // AllowedRoles/AllowedUsers columns.
  function canEditCategory(category, user) {
    if (!user) return false;
    if (user.role === 'DEV') return true;
    const sectionMatrix = dailyOpsPermMatrixCache && dailyOpsPermMatrixCache[category.Name];
    if (sectionMatrix) {
      return sectionMatrix[displayTitle(user)] === 'Edit';
    }
    if (category.AllowedRoles.includes(user.role)) return true;
    if (category.AllowedUsers.includes(user.name)) return true;
    return false;
  }

  // Whether a category should even be SHOWN to this user at all. Once a
  // category has matrix rows, a title with no row there (neither Edit
  // nor ReadOnly) has no business seeing it, so the tile is hidden
  // entirely — not just rendered view-only. Categories with no matrix
  // rows keep the old behavior: visible to everyone, edit gated
  // separately by AllowedRoles/AllowedUsers.
  function canViewCategory(category, user) {
    if (!user) return false;
    if (user.role === 'DEV') return true;
    const sectionMatrix = dailyOpsPermMatrixCache && dailyOpsPermMatrixCache[category.Name];
    if (sectionMatrix) {
      return !!sectionMatrix[displayTitle(user)];
    }
    return true;
  }

  // Combined Assigned-To options: app Users (from Roles, active only) +
  // external Technicians. Stored/returned as {value, label} where value
  // is "user:<name>" or "tech:<TechnicianID>" so the two namespaces never collide.
  async function loadAssigneeOptions() {
    const [users, techs] = await Promise.all([loadRoles(), loadTechnicians()]);
    const userOpts = users.filter(u => u.active).map(u => ({ value: 'user:' + u.name, label: u.name + ' (' + displayTitle(u) + ')' }));
    const techOpts = techs.filter(t => t.Active).map(t => ({ value: 'tech:' + t.TechnicianID, label: t.Name + ' (Technician)' }));
    return userOpts.concat(techOpts).sort((a, b) => a.label.localeCompare(b.label));
  }

  function assigneeLabel(assignedTo, assigneeOptions) {
    if (!assignedTo) return '';
    const found = (assigneeOptions || []).find(o => o.value === assignedTo);
    if (found) return found.label;
    // fallback if options weren't loaded / person since deactivated
    return assignedTo.replace(/^user:|^tech:/, '');
  }


  // ───────────────────────────────────────────────────────────
  // AUDIT LOG (append-only, shared across all modules)
  // Columns: Timestamp | Module | RequestID | EventType | Actor |
  //          ActorRole | Comment | AmountAtAction | StatusAfter
  // ───────────────────────────────────────────────────────────
  async function logAudit({ module, requestId, eventType, comment = '', amount = '', statusAfter = '' }) {
    const u = getUser() || { name: 'Unknown', role: '' };
    const row = [
      new Date().toISOString(),
      module,
      requestId,
      eventType,
      u.name,
      u.role,
      comment,
      amount,
      statusAfter
    ];
    return sheetsAppend(TABS.auditLog, row);
  }

  // ───────────────────────────────────────────────────────────
  // ID GENERATION — simple prefix + zero-padded counter based on
  // existing rows. Good enough for this scale; not safe against
  // true concurrent writes (last-write-wins on Sheets), acceptable here.
  // ───────────────────────────────────────────────────────────
  function nextId(prefix, existingIds) {
    let max = 0;
    existingIds.forEach(id => {
      const m = String(id).match(new RegExp('^' + prefix + '-(\\d+)$'));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return prefix + '-' + String(max + 1).padStart(4, '0');
  }

  // ───────────────────────────────────────────────────────────
  // PHOTO CAPTURE (camera on phone via <input capture>, file picker
  // on desktop — same input element handles both automatically)
  // Captured photos are resized/compressed client-side before they're
  // ever uploaded — phone cameras often shoot 8-12MP photos, which is
  // overkill for task/checklist evidence and slow on mobile data.
  // Resized to a max edge of ~1280px, JPEG quality ~0.7.
  // ───────────────────────────────────────────────────────────
  const PHOTO_MAX_EDGE = 1280;
  const PHOTO_JPEG_QUALITY = 0.7;

  function resizeAndCompressImage(dataUrl, maxEdge = PHOTO_MAX_EDGE, quality = PHOTO_JPEG_QUALITY) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxEdge || height > maxEdge) {
          if (width >= height) {
            height = Math.round(height * (maxEdge / width));
            width = maxEdge;
          } else {
            width = Math.round(width * (maxEdge / height));
            height = maxEdge;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error('Image compression failed')); return; }
          resolve(blob);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => reject(new Error('Could not load captured image for compression'));
      img.src = dataUrl;
    });
  }

  function capturePhoto({ accept = 'image/*', useCamera = true, maxEdge = PHOTO_MAX_EDGE, quality = PHOTO_JPEG_QUALITY } = {}) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      if (useCamera) input.capture = 'environment';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = () => {
        const file = input.files[0];
        document.body.removeChild(input);
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = async () => {
          const originalDataUrl = reader.result;
          try {
            const compressedBlob = await resizeAndCompressImage(originalDataUrl, maxEdge, quality);
            // Give the compressed blob a real filename + jpeg type so it behaves
            // like a normal File for the upload code path (which expects file.name/type).
            const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '');
            const compressedFile = new File([compressedBlob], baseName + '.jpg', { type: 'image/jpeg' });
            const compressedReader = new FileReader();
            compressedReader.onload = () => resolve({
              name: compressedFile.name,
              dataUrl: compressedReader.result,
              file: compressedFile,
              originalSizeBytes: file.size,
              compressedSizeBytes: compressedFile.size
            });
            compressedReader.onerror = reject;
            compressedReader.readAsDataURL(compressedFile);
          } catch (e) {
            console.warn('[MVOA] photo compression failed, using original', e);
            resolve({ name: file.name, dataUrl: originalDataUrl, file, originalSizeBytes: file.size, compressedSizeBytes: file.size });
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      };
      input.click();
    });
  }
  // ───────────────────────────────────────────────────────────
  // ATTACHMENT PICKER — picks photos OR documents.
  // Photos are resized/compressed (same as capturePhoto).
  // Documents (PDF, Word, Excel) are returned as-is, no compression.
  // Accepted document types mirror common office files; camera capture
  // is only offered for the photo-specific picker (useCamera=true).
  // ───────────────────────────────────────────────────────────
  const ACCEPTED_DOC_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ].join(',');
  const ACCEPTED_ALL_TYPES = 'image/*,' + ACCEPTED_DOC_TYPES;

  function pickAttachment({ photoOnly = false, useCamera = false } = {}) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = photoOnly ? 'image/*' : ACCEPTED_ALL_TYPES;
      if (useCamera && photoOnly) input.capture = 'environment';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = () => {
        const file = input.files[0];
        document.body.removeChild(input);
        if (!file) return resolve(null);
        const isPhoto = file.type.startsWith('image/');
        const reader = new FileReader();
        reader.onload = async () => {
          const originalDataUrl = reader.result;
          if (isPhoto) {
            // Compress photos exactly like capturePhoto does
            try {
              const compressedBlob = await resizeAndCompressImage(originalDataUrl, PHOTO_MAX_EDGE, PHOTO_JPEG_QUALITY);
              const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '');
              const compressedFile = new File([compressedBlob], baseName + '.jpg', { type: 'image/jpeg' });
              const cr = new FileReader();
              cr.onload = () => resolve({
                name: compressedFile.name, dataUrl: cr.result, file: compressedFile,
                isPhoto: true, originalSizeBytes: file.size, compressedSizeBytes: compressedFile.size
              });
              cr.onerror = reject;
              cr.readAsDataURL(compressedFile);
            } catch (e) {
              console.warn('[MVOA] photo compression failed, using original', e);
              resolve({ name: file.name, dataUrl: originalDataUrl, file, isPhoto: true, originalSizeBytes: file.size, compressedSizeBytes: file.size });
            }
          } else {
            // Documents: return as-is, no compression
            resolve({ name: file.name, dataUrl: originalDataUrl, file, isPhoto: false, originalSizeBytes: file.size, compressedSizeBytes: file.size });
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      };
      input.click();
    });
  }


  function logoSvg(size = 32) {
    return `<img src="assets/logo.png" alt="MVOA" style="height:${size}px;width:auto;display:block;">`;
  }

  // ───────────────────────────────────────────────────────────
  // PHOTO UPLOAD — via Apps Script Web App proxy.
  // Service accounts have no Drive storage quota on a personal
  // (non-Workspace) account, so direct Drive API uploads with the
  // service account token fail with storageQuotaExceeded. Instead,
  // a small Apps Script (owned by a real Google account) receives
  // the photo as base64 and saves it under that account's quota.
  // ───────────────────────────────────────────────────────────
  async function uploadPhotoToDrive(file, filename) {
    if (!file) return '';
    if (!CFG.photoUploadUrl) throw new Error('No photo upload URL configured (Settings → Photo Upload URL)');
    if (!CFG.driveFolderId) throw new Error('No Drive folder configured for photo storage');

    const base64 = await fileToBase64(file);
    const r = await fetchWithTimeout(CFG.photoUploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight against Apps Script
      body: JSON.stringify({
        secret: CFG.photoUploadSecret,
        base64,
        filename: filename || ('mvoa-' + Date.now() + '.jpg'),
        mimeType: file.type || 'image/jpeg',
        folderId: CFG.driveFolderId
      })
    }, 30000); // longer timeout — uploading a compressed photo can take longer than a metadata read
    if (!r.ok) throw new Error('Photo upload proxy error: ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error('Photo upload failed: ' + d.error);
    return d.url;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // reader.result is a data URL like "data:image/jpeg;base64,XXXX" — strip the prefix
        const result = reader.result;
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ───────────────────────────────────────────────────────────
  // STATUS BADGES (shared visual vocabulary across modules)
  // ───────────────────────────────────────────────────────────
  const STATUS_STYLES = {
    Open: { bg: '#fff3cd', fg: '#7a5b00' },
    Pending: { bg: '#fff3cd', fg: '#7a5b00' },
    Compliant: { bg: '#d4edda', fg: '#1e6b33' },
    Pass: { bg: '#d4edda', fg: '#1e6b33' },
    Approved: { bg: '#d4edda', fg: '#1e6b33' },
    Closed: { bg: '#e2e3e5', fg: '#41464b' },
    Overdue: { bg: '#f8d7da', fg: '#842029' },
    Fail: { bg: '#f8d7da', fg: '#842029' },
    Rejected: { bg: '#f8d7da', fg: '#842029' },
    PartialFail: { bg: '#ffe5b4', fg: '#8a4b00' },
    Escalated: { bg: '#ffe5b4', fg: '#8a4b00' }
  };
  function statusBadgeHtml(status) {
    const s = STATUS_STYLES[status] || { bg: '#e2e3e5', fg: '#41464b' };
    return `<span class="mvoa-badge" style="background:${s.bg};color:${s.fg}">${status}</span>`;
  }

  // ───────────────────────────────────────────────────────────
  // APP ICON BADGE (badge-on-open — see design discussion)
  // ───────────────────────────────────────────────────────────
  function setAppBadge(count) {
    if ('setAppBadge' in navigator) {
      if (count > 0) navigator.setAppBadge(count).catch(() => {});
      else if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
    }
  }

  // ───────────────────────────────────────────────────────────
  // ASSET QR PARSING — Inventory's label format has been observed
  // in two shapes so far:
  //   Old:  MVOA|AssetID|AssetName|Category|Location
  //   New:  Code: X Name: Y Category: Z Sub-Category: W Location: V
  // This parses either; extend the regex list below if a third
  // format shows up from a different label batch.
  // ───────────────────────────────────────────────────────────
  function parseAssetQR(text) {
    if (typeof text !== 'string') return null;

    // New labeled-field format (current Inventory label printer)
    if (/Code\s*:/.test(text)) {
      const grab = (label, nextLabels) => {
        const re = new RegExp(label + '\\s*:\\s*(.*?)\\s*(?:' + nextLabels.join('|') + '|$)');
        const m = text.match(re);
        return m ? m[1].trim() : '';
      };
      const assetId = grab('Code', ['Name:']);
      const assetName = grab('Name', ['Category:']);
      const category = grab('Category', ['Sub-Category:', 'Location:']);
      const subCategory = grab('Sub-Category', ['Location:']);
      const location = grab('Location', ['$']);
      if (assetId && assetName) {
        return { assetId, assetName, category, subCategory, location };
      }
    }

    // Old pipe-delimited format
    const parts = text.split('|');
    if (parts[0] === 'MVOA' && parts.length >= 5) {
      return { assetId: parts[1], assetName: parts[2], category: parts[3], location: parts[4] };
    }

    return null;
  }

  // ───────────────────────────────────────────────────────────
  // MODULE REGISTRY — each module-*.js calls MVOA.registerModule()
  // The shell loops over MVOA.modules to build home-screen tiles
  // without hardcoding any module-specific logic.
  // ───────────────────────────────────────────────────────────
  const modules = {};
  function registerModule(key, def) {
    // def: { label, icon, roles: [...], init: function(container){...} }
    modules[key] = def;
  }
  function modulesForRole(role) {
    return Object.entries(modules)
      .filter(([k, m]) => !m.roles || m.roles.includes(role) || m.roles.includes('ALL'))
      .map(([k, m]) => ({ key: k, ...m }));
  }

  // ───────────────────────────────────────────────────────────
  // PUBLIC API
  // ───────────────────────────────────────────────────────────
  return {
    CFG, TABS,
    loadConfig, saveConfig,
    sheetsRead, sheetsWrite, sheetsAppend, sheetsAppendMany, sheetsUpdateRow,
    hashPin, verifyPin, loadRoles, login, restoreSession, logout, getUser, roleLabel, displayTitle, changePin,
    isAdmin, resetUserPin, setUserActive, renameUser,
    loadCategories, loadTechnicians, canEditCategory, canViewCategory, loadDailyOpsPermissionsMatrix, getDailyOpsPermissionsMatrixRows, loadAssigneeOptions, assigneeLabel,
    loadNotesForTask, appendNote,
    logAudit, nextId,
    capturePhoto, pickAttachment, uploadPhotoToDrive,
    logoSvg,
    statusBadgeHtml, STATUS_STYLES,
    setAppBadge,
    parseAssetQR,
    registerModule, modulesForRole, modules
  };
})();
