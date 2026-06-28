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
    hsTemplates: 'HSChecklistTemplates',
    hsItems: 'HSChecklistItems',
    hsItemOptions: 'HSChecklistItemOptions',
    hsLog: 'HSChecklistLog',
    hsItemResults: 'HSChecklistItemResults',
    expenseRequests: 'Expense_Requests',
    expenseVotes: 'Expense_Votes',
    approvalMatrix: 'ApprovalMatrix'
  };

  // ───────────────────────────────────────────────────────────
  // GOOGLE SHEETS API (read via API key, write via service-account JWT)
  // ───────────────────────────────────────────────────────────
  async function sheetsRead(sheetName) {
    // Uses the service-account token, not the plain API key — a bare API key
    // can only read spreadsheets that are public ("anyone with the link"),
    // and this Sheet is intentionally kept Restricted. The service account
    // already has Editor access, so reuse that for reads too.
    const token = await getServiceAccountToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(sheetName)}`;
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
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
    const r = await fetch(url, {
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
    const r = await fetch(url, {
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
    const r = await fetch(url, {
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
    const r = await fetch(url, {
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
    const resp = await fetch('https://oauth2.googleapis.com/token', {
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
      ecMember: ['true', 'TRUE', '1', 'yes'].includes(String(r[6]))
    })).filter(u => u.name);
    return rolesCache;
  }

  let currentUser = null;
  async function login(pin) {
    const users = await loadRoles();
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
    await sheetsUpdateRow(TABS.roles, fresh.rowNumber, [
      fresh.name, fresh.role, newHash, fresh.phone, fresh.email,
      fresh.active ? 'TRUE' : 'FALSE', fresh.ecMember ? 'TRUE' : 'FALSE'
    ]);
    fresh.pinHash = newHash;
    currentUser = fresh;
    sessionStorage.setItem('mvoa_user', JSON.stringify(currentUser));
    await logAudit({ module: 'Settings', requestId: currentUser.name, eventType: 'PinChanged', comment: 'Self-service PIN change', statusAfter: 'Active' });
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

  // ───────────────────────────────────────────────────────────
  // OPS CATEGORIES (sub-tiles within Daily Operations) + TECHNICIANS
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

  // DEV role always has full access. Otherwise: a user can EDIT a category
  // if their role is in AllowedRoles OR their name is in AllowedUsers.
  // Anyone who can see the parent module (role-gated at module level) can
  // at least VIEW every category — categories without edit access render
  // grayed out / read-only rather than being hidden.
  function canEditCategory(category, user) {
    if (!user) return false;
    if (user.role === 'DEV') return true;
    if (category.AllowedRoles.includes(user.role)) return true;
    if (category.AllowedUsers.includes(user.name)) return true;
    return false;
  }

  // Combined Assigned-To options: app Users (from Roles, active only) +
  // external Technicians. Stored/returned as {value, label} where value
  // is "user:<name>" or "tech:<TechnicianID>" so the two namespaces never collide.
  async function loadAssigneeOptions() {
    const [users, techs] = await Promise.all([loadRoles(), loadTechnicians()]);
    const userOpts = users.filter(u => u.active).map(u => ({ value: 'user:' + u.name, label: u.name + ' (' + roleLabel(u.role) + ')' }));
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
  // TODO: photo storage destination not yet decided (Google Drive upload
  // via the same service account vs. some other host). PhotoURL columns
  // across the schema assume a real URL once this is wired up.

  // ───────────────────────────────────────────────────────────
  // LOGO — real finalized asset at assets/logo.png (relative to
  // MVOA_Live.html). Returns an <img> tag, sized by the caller.
  // ───────────────────────────────────────────────────────────
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
    const r = await fetch(CFG.photoUploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight against Apps Script
      body: JSON.stringify({
        secret: CFG.photoUploadSecret,
        base64,
        filename: filename || ('mvoa-' + Date.now() + '.jpg'),
        mimeType: file.type || 'image/jpeg',
        folderId: CFG.driveFolderId
      })
    });
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
    hashPin, verifyPin, loadRoles, login, restoreSession, logout, getUser, roleLabel, changePin,
    loadCategories, loadTechnicians, canEditCategory, loadAssigneeOptions, assigneeLabel,
    logAudit, nextId,
    capturePhoto, uploadPhotoToDrive,
    logoSvg,
    statusBadgeHtml, STATUS_STYLES,
    setAppBadge,
    parseAssetQR,
    registerModule, modulesForRole, modules
  };
})();
