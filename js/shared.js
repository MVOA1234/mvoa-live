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
    hsCategories: 'HSCategories',
    hsShiftDuty: 'HSShiftDuty',
    hsAmcAssets: 'HSAMCAssets',
    hsAmcLog: 'HSAMCLog',
    hsCategoryAssets: 'HSCategoryAssets',
    hsRoundWindows: 'HSRoundWindows',
    expenseRequests: 'Expense_Requests',
    expenseVotes: 'Expense_Votes',
    approvalMatrix: 'ApprovalMatrix',
    permissionsMatrixDailyOps: 'PermissionsMatrix_DailyOps',
    permissionsMatrixPlantRounds: 'PermissionsMatrix_PlantRounds',
    permissionsMatrixAttendance: 'PermissionsMatrix_Attendance',
    attAgencies: 'AttAgencies',
    attStaff: 'AttStaff',
    attLog: 'AttLog',
    attSettings: 'AttSettings'
  };

  // ───────────────────────────────────────────────────────────
  // BOUNDED-READ ROW LIMITS — central place to define (or change) how many
  // of the most recent rows sheetsRead() fetches for a tab, instead of the
  // whole sheet, when a caller opts in with sheetsRead(tab, { recent: true }).
  //
  // This keeps the read fast (and the client-side processing after it) as
  // a log-style sheet grows into the tens of thousands of rows over time —
  // see TABS.attLog below as the first sheet this was added for.
  //
  // Add or edit entries here any time. A sheet with no entry (or a limit
  // of 0) always falls back to a full, unbounded read — the same as before
  // this existed — even if a caller passes { recent: true }.
  //
  // IMPORTANT: only pass { recent: true } at a call site that genuinely
  // only needs the newest rows (a live "what's happening right now" view).
  // Anything that lets someone look at an older date or a past month
  // (Monthly Report, historical approvals, etc.) must keep calling
  // sheetsRead(tab) with no options — bounding it would silently make
  // older rows invisible once the sheet grows past the limit below.
  const SHEET_RECENT_ROW_LIMITS = {
    [TABS.attLog]: 3000
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
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // One automatic retry after a short pause on a network-level failure
  // (timeout, DNS hiccup, offline blip, etc.) — the kind of brief stall
  // that clears itself up a second later, rather than a real problem.
  // This does NOT retry on an actual HTTP error response (403, 500, ...);
  // fetch() only throws for network-level failures, a non-2xx response
  // still resolves normally and is handled by the caller as before.
  //
  // IMPORTANT — retry is OPT-IN via the `retry` param, and is only ever
  // passed as true from call sites that are safe to repeat: plain GET
  // reads (sheetsRead, sheetsRowCount, the tab-existence checks) and the
  // OAuth token exchange. A timeout doesn't guarantee the request never
  // reached Google's servers — for a write (append/update/delete), a
  // blind retry after an already-successful-but-slow-to-respond request
  // could create a duplicate row (e.g. a duplicate attendance check-in
  // or a duplicate finance approval). So every write path below keeps
  // its original no-retry behavior; only read-style calls opt in.
  const RETRY_DELAY_MS = 1500;

  // ───────────────────────────────────────────────────────────
  // REQUEST SPACING — every user of this app shares ONE service-account
  // identity, so Google's per-user Sheets API quota (60 reads/min, 60
  // writes/min) is really a pool shared across everyone using the app at
  // once. A single screen that needs several different tabs at the same
  // moment (e.g. a dashboard pulling 5+ sheets on load) used to fire all
  // of those requests in the same instant — fine on its own, but stacked
  // across several people opening the app around the same time, this is
  // what can push a one-minute window over the per-user cap and produce
  // the timeouts users have been seeing.
  //
  // This adds a small stagger (REQUEST_STAGGER_MS) between consecutive
  // Sheets API calls dispatched from THIS browser tab, so one screen's
  // own burst spreads out into more of a steady trickle instead of a
  // spike. It can only smooth out what one tab does — it can't see or
  // coordinate with other users' tabs — so it's a complement to, not a
  // substitute for, the read cache below (which is what actually cuts
  // down duplicate requests across different users/tabs hitting the
  // same sheet within a few seconds of each other).
  const REQUEST_STAGGER_MS = 120;
  let lastSheetsApiDispatch = 0;
  let dispatchChain = Promise.resolve();

  function staggerSheetsApiCall() {
    // Chains onto a shared promise so concurrent callers queue up in the
    // order they arrived, instead of each one racing to compute its own
    // "wait until" time off a stale lastSheetsApiDispatch value.
    dispatchChain = dispatchChain.then(async () => {
      const waitFor = Math.max(0, (lastSheetsApiDispatch + REQUEST_STAGGER_MS) - Date.now());
      if (waitFor > 0) await sleep(waitFor);
      lastSheetsApiDispatch = Date.now();
    });
    return dispatchChain;
  }

  async function fetchWithTimeout(url, options, timeoutMs = NETWORK_TIMEOUT_MS, retry = false) {
    async function attempt() {
      if (url.indexOf('sheets.googleapis.com') !== -1) await staggerSheetsApiCall();
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

    if (!retry) return attempt();

    try {
      return await attempt();
    } catch (e) {
      await sleep(RETRY_DELAY_MS);
      return attempt(); // second failure is allowed to throw straight to the caller
    }
  }

  // ───────────────────────────────────────────────────────────
  // SHORT-LIVED READ CACHE — de-duplicates identical reads that happen
  // within a few seconds of each other. This is the main lever for
  // staying under the shared per-user Sheets API quota during a burst
  // of concurrent app usage (several people/tabs loading the same
  // sheet around the same moment, or one screen re-reading a tab it
  // just read a moment ago) — it's genuinely fresh data almost all the
  // time (TTL is short), and every write function below clears the
  // relevant cache entries immediately so a save is never masked by a
  // stale cached read on the same device.
  //
  // Concurrent callers requesting the SAME sheet (same bounded/full
  // mode) while a read is already in flight share that one in-flight
  // request rather than each firing their own — this is often the
  // biggest win, since a single screen frequently reads a tab more
  // than once during render.
  const READ_CACHE_TTL_MS = 12000;
  const readCache = new Map(); // key -> { promise, timestamp }

  function readCacheKey(sheetName, opts) {
    return sheetName + '|' + ((opts && opts.recent) ? 'recent' : 'full');
  }

  function clearReadCache(sheetName) {
    // Clears both the bounded and full-read entries for this sheet —
    // called after any successful write so the next read is never
    // served a pre-write cached copy.
    readCache.delete(readCacheKey(sheetName, null));
    readCache.delete(readCacheKey(sheetName, { recent: true }));
  }

  // opts.recent: true — opt into the bounded read described above, using
  // whatever limit SHEET_RECENT_ROW_LIMITS has for this sheet (no entry, or
  // omitting opts entirely, reads the whole sheet exactly as before).
  async function sheetsRead(sheetName, opts) {
    const cacheKey = readCacheKey(sheetName, opts);
    const cached = readCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < READ_CACHE_TTL_MS) {
      const rows = await cached.promise;
      return rows.slice(); // shallow copy — a caller mutating the returned array must never corrupt the shared cache entry
    }

    const promise = sheetsReadUncached(sheetName, opts);
    readCache.set(cacheKey, { promise, timestamp: Date.now() });
    try {
      const rows = await promise;
      return rows.slice();
    } catch (e) {
      readCache.delete(cacheKey); // never cache a failure — let the next call try fresh
      throw e;
    }
  }

  async function sheetsReadUncached(sheetName, opts) {
    // Uses the service-account token, not the plain API key — a bare API key
    // can only read spreadsheets that are public ("anyone with the link"),
    // and this Sheet is intentionally kept Restricted. The service account
    // already has Editor access, so reuse that for reads too.
    const token = await getServiceAccountToken();
    const authHeaders = { 'Authorization': 'Bearer ' + token };
    const fullReadUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(sheetName)}`;

    async function readFull() {
      const r = await fetchWithTimeout(fullReadUrl, { headers: authHeaders }, NETWORK_TIMEOUT_MS, true);
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`Sheets read error (${sheetName}): ${r.status} ${body}`);
      }
      const d = await r.json();
      return d.values || [];
    }

    const limit = (opts && opts.recent) ? (SHEET_RECENT_ROW_LIMITS[sheetName] || 0) : 0;
    if (!limit) return readFull();

    // Bounded read: first find out how many rows of data exist — a single
    // column is a cheap way to count without pulling every column yet.
    const colAUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(sheetName + '!A:A')}`;
    const colAResp = await fetchWithTimeout(colAUrl, { headers: authHeaders }, NETWORK_TIMEOUT_MS, true);
    if (!colAResp.ok) {
      const body = await colAResp.text().catch(() => '');
      throw new Error(`Sheets read error (${sheetName}): ${colAResp.status} ${body}`);
    }
    const totalRows = ((await colAResp.json()).values || []).length; // includes the header row

    // Not big enough yet for bounding to be worth it — one plain read.
    if (totalRows <= limit + 1) return readFull();

    // Fetch the header row and the most recent `limit` data rows together
    // in a single batchGet, so this stays two requests total either way.
    const startRow = totalRows - limit + 1;
    const ranges = [`${sheetName}!1:1`, `${sheetName}!A${startRow}:ZZ${totalRows}`]
      .map(rg => `ranges=${encodeURIComponent(rg)}`).join('&');
    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values:batchGet?${ranges}`;
    const batchResp = await fetchWithTimeout(batchUrl, { headers: authHeaders }, NETWORK_TIMEOUT_MS, true);
    if (!batchResp.ok) {
      const body = await batchResp.text().catch(() => '');
      throw new Error(`Sheets read error (${sheetName}): ${batchResp.status} ${body}`);
    }
    const batchData = await batchResp.json();
    const [headerRange, dataRange] = batchData.valueRanges || [];
    const headerRow = (headerRange && headerRange.values && headerRange.values[0]) || [];
    const dataRows = (dataRange && dataRange.values) || [];
    return [headerRow, ...dataRows];
  }

  // Cheap row count for a sheet — reads only column A instead of the whole
  // tab, so it stays fast even on a sheet with many columns. Returns the
  // number of DATA rows (header row not counted). Used by the "Sheet
  // Sizes" diagnostics view so growth can be monitored without pulling
  // every column of every log sheet.
  async function sheetsRowCount(sheetName) {
    const token = await getServiceAccountToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(sheetName + '!A:A')}`;
    const r = await fetchWithTimeout(url, { headers: { 'Authorization': 'Bearer ' + token } }, NETWORK_TIMEOUT_MS, true);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Sheets read error (${sheetName}): ${r.status} ${body}`);
    }
    const d = await r.json();
    const rows = d.values || [];
    return Math.max(0, rows.length - 1); // exclude the header row
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
    clearReadCache(sheetName);
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
    clearReadCache(sheetName);
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
    clearReadCache(sheetName);
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
    clearReadCache(sheetName);
    return r.json();
  }

  // Permanently removes specific rows (1-based, including the header as row
  // 1) via the Sheets API's batchUpdate/deleteDimension request — a real row
  // delete, unlike sheetsUpdateRow (which only overwrites content in place)
  // or sheetsWrite (which doesn't shrink a sheet, just rewrites the top of
  // it). Used for cascade-deleting attendance history when an agency or
  // staff record is permanently removed, not just deactivated. rowNumbers
  // need not be pre-sorted — sorted descending internally so deleting from
  // the bottom up never shifts the position of rows still queued for
  // deletion within the same call.
  async function sheetsDeleteRows(sheetName, rowNumbers) {
    if (!rowNumbers || !rowNumbers.length) return;
    const token = await getServiceAccountToken();
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}?fields=sheets.properties(sheetId,title)`;
    const metaRes = await fetchWithTimeout(metaUrl, { headers: { 'Authorization': 'Bearer ' + token } }, NETWORK_TIMEOUT_MS, true);
    if (!metaRes.ok) throw new Error(`Could not look up sheet ID for ${sheetName}: ${metaRes.status}`);
    const meta = await metaRes.json();
    const sheetMeta = (meta.sheets || []).find(s => s.properties && s.properties.title === sheetName);
    if (!sheetMeta) throw new Error(`sheetsDeleteRows: no tab named "${sheetName}"`);
    const sheetId = sheetMeta.properties.sheetId;
    const sorted = [...new Set(rowNumbers)].sort((a, b) => b - a);
    const requests = sorted.map(rowNumber => ({
      deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } }
    }));
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}:batchUpdate`;
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ requests })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Sheets delete rows error (${sheetName}): ${r.status} ${body}`);
    }
    clearReadCache(sheetName);
    return r.json();
  }

  // Creates a new tab with the given header row if it doesn't already exist —
  // used for month-per-tab sheets (e.g. ExpenseSheet_Aug26) that get created
  // the first time an entry lands in a given month, rather than pre-seeded.
  // Safe to call every time before writing; a no-op if the tab is already there.
  async function sheetsEnsureTab(sheetName, headerRow) {
    const token = await getServiceAccountToken();
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}?fields=sheets.properties.title`;
    const metaRes = await fetchWithTimeout(metaUrl, { headers: { 'Authorization': 'Bearer ' + token } }, NETWORK_TIMEOUT_MS, true);
    if (!metaRes.ok) throw new Error(`Could not check existing tabs: ${metaRes.status}`);
    const meta = await metaRes.json();
    const exists = (meta.sheets || []).some(s => s.properties && s.properties.title === sheetName);
    if (exists) return false;
    const createUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}:batchUpdate`;
    const createRes = await fetchWithTimeout(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] })
    });
    if (!createRes.ok) {
      const body = await createRes.text().catch(() => '');
      // Another concurrent request may have created it a moment ago — treat as success.
      if (body.indexOf('already exists') !== -1) return false;
      throw new Error(`Could not create tab ${sheetName}: ${createRes.status} ${body}`);
    }
    if (headerRow && headerRow.length) await sheetsAppend(sheetName, headerRow); // also clears this sheet's read cache
    return true;
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
    }, NETWORK_TIMEOUT_MS, true); // safe to retry — this only requests a token, it doesn't mutate any data
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

  // REWRITTEN 27-Aug-2026: loadRoles()/writeRolesRow() used to read and
  // write the Roles sheet by fixed column POSITION (r[5], r[6], r[7]...).
  // That already broke once — a stray reorder made "active" silently read
  // the EC_Member column and "title" read AdminAccess, so only EC members
  // could log in and everyone else's role showed as literal TRUE/FALSE.
  // Now both functions match columns by the HEADER ROW'S TEXT (row 1)
  // instead, so reordering, inserting, or deleting a column in the Roles
  // sheet can no longer silently corrupt login or approvals — it will
  // either keep working (if the header text is unchanged) or throw a
  // clear "missing column" error (if a required header is renamed/removed)
  // rather than quietly misreading the wrong column.
  //
  // ROLES_FIELD_HEADERS lists, per field, the header text(s) we'll accept
  // (matched case- and whitespace/underscore-insensitively). "title" is
  // listed but optional — the live sheet has never had a Title column, and
  // displayTitle() falls back to roleLabel(role) when title is blank.
  const ROLES_FIELD_HEADERS = {
    name: ['name'],
    role: ['role'],
    pinHash: ['pin_hash', 'pinhash', 'pin hash'],
    phone: ['phone'],
    email: ['email'],
    ecMember: ['ec_member', 'ecmember', 'ec member'],
    active: ['active'],
    adminAccess: ['adminaccess', 'admin_access', 'admin access'],
    title: ['title']
  };
  const ROLES_OPTIONAL_FIELDS = ['title'];

  function normalizeRolesHeader(h) {
    return String(h || '').trim().toLowerCase().replace(/[\s_]+/g, '');
  }

  // Builds { field: columnIndex } from the sheet's actual header row.
  // Throws if a REQUIRED field's header can't be found, naming exactly
  // which one — so a renamed/removed header fails loudly at load time
  // instead of silently misreading data at login time.
  function buildRolesColIndex(headerRow) {
    const normalized = (headerRow || []).map(normalizeRolesHeader);
    const idx = {};
    const missing = [];
    Object.keys(ROLES_FIELD_HEADERS).forEach(field => {
      const candidates = ROLES_FIELD_HEADERS[field].map(normalizeRolesHeader);
      const pos = normalized.findIndex(h => candidates.includes(h));
      idx[field] = pos; // -1 if not found
      if (pos === -1 && !ROLES_OPTIONAL_FIELDS.includes(field)) missing.push(field);
    });
    if (missing.length) {
      throw new Error('Roles sheet header row is missing expected column(s): ' + missing.join(', ') +
        '. Login and approvals cannot work correctly until these headers exist — check row 1 of the Roles sheet.');
    }
    return idx;
  }

  let rolesCache = null;
  let rolesColIndex = null; // column index for each known field, from the CURRENT header row — rebuilt every loadRoles() call
  let rolesHeaderLen = 0;   // total column count in the header row, so writeRolesRow() knows how wide a row to write
  async function loadRoles(force) {
    if (rolesCache && !force) return rolesCache;
    const rows = await sheetsRead(TABS.roles);
    if (!rows.length) { rolesCache = []; rolesColIndex = null; rolesHeaderLen = 0; return rolesCache; }

    const headerRow = rows[0];
    rolesColIndex = buildRolesColIndex(headerRow);
    rolesHeaderLen = headerRow.length;

    const truthy = v => ['true', 'TRUE', '1', 'yes'].includes(String(v));
    const at = (r, field) => {
      const i = rolesColIndex[field];
      return (i == null || i < 0) ? undefined : r[i];
    };

    rolesCache = rows.slice(1).map((r, i) => ({
      rowNumber: i + 2,
      name: at(r, 'name') || '',
      role: at(r, 'role') || '',
      pinHash: at(r, 'pinHash') || '',
      phone: at(r, 'phone') || '',
      email: at(r, 'email') || '',
      ecMember: truthy(at(r, 'ecMember')),
      active: truthy(at(r, 'active')),
      title: at(r, 'title') || '',
      adminAccess: truthy(at(r, 'adminAccess')), // grants unmasked connection settings + PIN Management, independent of Title
      _rawRow: r.slice() // preserves any column we don't otherwise recognize, so writeRolesRow() below never clobbers it
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
        localStorage.setItem('mvoa_user', JSON.stringify(u));
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
        localStorage.setItem('mvoa_user', JSON.stringify(u));
        return u;
      }
    }
    throw new Error('Invalid PIN');
  }

  function restoreSession() {
    try {
      const raw = localStorage.getItem('mvoa_user');
      if (raw) currentUser = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return currentUser;
  }

  function logout() {
    currentUser = null;
    localStorage.removeItem('mvoa_user');
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
    localStorage.setItem('mvoa_user', JSON.stringify(currentUser));
    await logAudit({ module: 'Settings', requestId: currentUser.name, eventType: 'PinChanged', comment: 'Self-service PIN change', statusAfter: 'Active' });
  }

  const DEFAULT_RESET_PIN = '1111';

  // REWRITTEN 27-Aug-2026 alongside loadRoles() — this used to write a
  // fixed 8-column order that once drifted out of sync with the sheet's
  // real layout and silently corrupted EC_Member/Active/AdminAccess on
  // every PIN reset, suspend/activate, or self-service PIN change. Now it
  // places each field into whatever column rolesColIndex (built from the
  // CURRENT header row by loadRoles()) says that header lives at, so a
  // future reorder/insert/delete of a column stays correct without needing
  // another code fix. Any column we don't recognize is preserved exactly
  // as last read (via u._rawRow) rather than being blanked out, so a
  // future added column survives writes made before code knows about it.
  function writeRolesRow(u) {
    if (!rolesColIndex) {
      throw new Error('Roles sheet column layout is not loaded — call loadRoles() before writing to it.');
    }
    const row = (u._rawRow ? u._rawRow.slice() : []);
    while (row.length < rolesHeaderLen) row.push('');

    const set = (field, value) => {
      const i = rolesColIndex[field];
      if (i != null && i >= 0) row[i] = value;
    };
    set('name', u.name);
    set('role', u.role);
    set('pinHash', u.pinHash);
    set('phone', u.phone);
    set('email', u.email);
    set('ecMember', u.ecMember ? 'TRUE' : 'FALSE');
    set('active', u.active ? 'TRUE' : 'FALSE');
    set('adminAccess', u.adminAccess ? 'TRUE' : 'FALSE');
    if (rolesColIndex.title >= 0) set('title', u.title || '');

    return sheetsUpdateRow(TABS.roles, u.rowNumber, row);
  }

  // FIXED 27-Aug-2026 — found while adding the Accountant/Disbursement
  // Officer roles: MVOA_Live.html's "Add New User" form built its own
  // Roles row by hand, in the OLD wrong 9-column order (the exact same
  // bug writeRolesRow had — Active hardcoded 'TRUE' into what's actually
  // the EC_Member column, the EC_Member checkbox value landing in Active,
  // and Title landing in AdminAccess). Every user ever created through
  // that form — including any test accounts — may have corrupted
  // EC_Member/Active/AdminAccess values. This is the CREATE-path
  // counterpart to writeRolesRow: same header-matched column placement,
  // so a new row goes into the sheet correctly no matter how its columns
  // are ordered, and MVOA_Live.html now calls this instead of writing its
  // own array. New users default to Active unless told otherwise.
  async function addRolesRow(u) {
    await loadRoles(); // ensures rolesColIndex/rolesHeaderLen reflect the CURRENT header row
    if (!rolesColIndex) {
      throw new Error('Roles sheet column layout is not loaded — cannot add a new row.');
    }
    const row = [];
    while (row.length < rolesHeaderLen) row.push('');

    const set = (field, value) => {
      const i = rolesColIndex[field];
      if (i != null && i >= 0) row[i] = value;
    };
    set('name', u.name || '');
    set('role', u.role || '');
    set('pinHash', u.pinHash || '');
    set('phone', u.phone || '');
    set('email', u.email || '');
    set('ecMember', u.ecMember ? 'TRUE' : 'FALSE');
    set('active', u.active === false ? 'FALSE' : 'TRUE');
    set('adminAccess', u.adminAccess ? 'TRUE' : 'FALSE');
    if (rolesColIndex.title >= 0) set('title', u.title || '');

    const result = await sheetsAppend(TABS.roles, row);
    rolesCache = null; // force the next loadRoles() to re-read, so the new user shows up immediately
    return result;
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
      localStorage.setItem('mvoa_user', JSON.stringify(currentUser));
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
    EC: 'Executive Committee',
    // ADDED 27-Aug-2026 — these role codes were already recognized by
    // module-finance.js's access checks (isAccountantPerson,
    // isDisbursementOfficerPerson, roleMatchesToken's secretary/president
    // fallbacks) but had no label here, so anyone with one of these roles
    // and no Title override showed their raw code ("ACCT", "DISB", "SECY",
    // "PRES") on the login screen instead of a real name.
    ACCT: 'Accountant',
    DISB: 'Disbursement Officer',
    SECY: 'Secretary',
    PRES: 'President'
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
  //   AllowedRoles | AllowedUsers | Active | SortOrder | RequireEvidenceOnClose
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
      SortOrder: parseInt(r[7], 10) || 0,
      RequireEvidenceOnClose: ['true', 'TRUE', '1', 'yes'].includes(String(r[8]))
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

  // ───────────────────────────────────────────────────────────
  // PLANT ROUNDS & COMPLIANCE — its own separate Title-based matrix,
  // same Section|Title|AccessLevel shape as Daily Ops but a distinct
  // sheet tab, since access rules differ per module. Unlike Daily Ops,
  // this module never had a legacy AllowedRoles/AllowedUsers system to
  // fall back to, so a section with NO matrix rows yet defaults to
  // fully open (matches the module's current unrestricted state) —
  // this only matters for a brand-new category added before its rows
  // are populated; once a section has any rows, only listed Titles
  // have access, unlisted Titles have none.
  // ───────────────────────────────────────────────────────────
  let plantRoundsPermMatrixCache = null;
  let plantRoundsPermMatrixRowsCache = null; // raw rows incl. rowNumber, for the editable grid — same reasoning as Daily Ops' rows cache
  async function loadPlantRoundsPermissionsMatrix(force) {
    if (plantRoundsPermMatrixCache && !force) return plantRoundsPermMatrixCache;
    const rows = await sheetsRead(TABS.permissionsMatrixPlantRounds);
    const map = {};
    const rawRows = [];
    rows.slice(1).forEach((r, i) => {
      const section = (r[0] || '').trim();
      const title = (r[1] || '').trim();
      const level = (r[2] || '').trim();
      if (!section || !title) return; // truly blank/junk row
      rawRows.push({ rowNumber: i + 2, Section: section, Title: title, AccessLevel: level });
      if (!level) return; // row exists but blanked back to "No access" — keep in rawRows, skip in map
      if (!map[section]) map[section] = {};
      map[section][title] = level;
    });
    plantRoundsPermMatrixCache = map;
    plantRoundsPermMatrixRowsCache = rawRows;
    return plantRoundsPermMatrixCache;
  }
  // Raw rows (with sheet rowNumber) for the editable grid — must call
  // loadPlantRoundsPermissionsMatrix at least once first, same pattern
  // as getDailyOpsPermissionsMatrixRows.
  function getPlantRoundsPermissionsMatrixRows() {
    return plantRoundsPermMatrixRowsCache || [];
  }
  function canEditPlantRoundsSection(sectionName, user) {
    if (!user) return false;
    if (user.role === 'DEV') return true;
    const sectionMatrix = plantRoundsPermMatrixCache && plantRoundsPermMatrixCache[sectionName];
    if (!sectionMatrix) return true; // no rows for this section yet — stays open until populated
    return sectionMatrix[displayTitle(user)] === 'Edit';
  }
  function canViewPlantRoundsSection(sectionName, user) {
    if (!user) return false;
    if (user.role === 'DEV') return true;
    const sectionMatrix = plantRoundsPermMatrixCache && plantRoundsPermMatrixCache[sectionName];
    if (!sectionMatrix) return true;
    return !!sectionMatrix[displayTitle(user)];
  }

  // ───────────────────────────────────────────────────────────
  // STAFF ATTENDANCE — same Section|Title|AccessLevel matrix shape as
  // Plant Rounds, distinct sheet tab. This is the ONLY access gate for
  // Staff Attendance — there is no separate app PIN like the old
  // standalone version; a user's existing MVOA login + their Title's
  // row here (Edit/ReadOnly/no row = no access) controls everything,
  // including the old app's "Admin" area (Section: 'Admin').
  // ───────────────────────────────────────────────────────────
  let attendancePermMatrixCache = null;
  let attendancePermMatrixRowsCache = null;
  async function loadAttendancePermissionsMatrix(force) {
    if (attendancePermMatrixCache && !force) return attendancePermMatrixCache;
    const rows = await sheetsRead(TABS.permissionsMatrixAttendance);
    const map = {};
    const rawRows = [];
    rows.slice(1).forEach((r, i) => {
      const section = (r[0] || '').trim();
      const title = (r[1] || '').trim();
      const level = (r[2] || '').trim();
      if (!section || !title) return;
      rawRows.push({ rowNumber: i + 2, Section: section, Title: title, AccessLevel: level });
      if (!level) return;
      if (!map[section]) map[section] = {};
      map[section][title] = level;
    });
    attendancePermMatrixCache = map;
    attendancePermMatrixRowsCache = rawRows;
    return attendancePermMatrixCache;
  }
  function getAttendancePermissionsMatrixRows() {
    return attendancePermMatrixRowsCache || [];
  }
  function canEditAttendanceSection(sectionName, user) {
    if (!user) return false;
    if (user.role === 'DEV') return true;
    const sectionMatrix = attendancePermMatrixCache && attendancePermMatrixCache[sectionName];
    if (!sectionMatrix) return true; // no rows for this section yet — stays open until populated
    return sectionMatrix[displayTitle(user)] === 'Edit';
  }
  function canViewAttendanceSection(sectionName, user) {
    if (!user) return false;
    if (user.role === 'DEV') return true;
    const sectionMatrix = attendancePermMatrixCache && attendancePermMatrixCache[sectionName];
    if (!sectionMatrix) return true;
    return !!sectionMatrix[displayTitle(user)];
  }

  // Checks whether a given AssignedTo value ("user:Name", "tech:ID", or
  // "role:Title") — not necessarily the currently logged-in user — would
  // have Edit rights on a category. Used to warn at assignment time (New
  // Task / Reassign) if the chosen person/role wouldn't actually be able
  // to close their own task. Technicians never get edit access here
  // since they have no login/Title in the permissions system at all.
  // For a "role:" value there's no one specific person to check — the
  // permissions matrix is keyed by Title anyway (see canEditCategory), so
  // a synthetic {title} stand-in is enough; it doesn't need to be an
  // actual active person.
  async function assigneeEditAccess(category, assignedToValue) {
    if (!assignedToValue) return false;
    if (assignedToValue.indexOf('role:') === 0) {
      return canEditCategory(category, { role: '', title: assignedToValue.substring('role:'.length) });
    }
    if (assignedToValue.indexOf('user:') !== 0) return false;
    const name = assignedToValue.substring('user:'.length);
    const users = await loadRoles();
    const person = users.find(u => u.name === name);
    if (!person) return false;
    return canEditCategory(category, person);
  }

  // Combined Assigned-To options: app Users (from Roles, active only) +
  // external Technicians + Roles/Titles themselves. Stored/returned as
  // {value, label} where value is "user:<name>", "tech:<TechnicianID>",
  // or "role:<Title>" so the three namespaces never collide. A "role:"
  // option assigns the task to WHOEVER currently holds that title — not
  // frozen to one person the way "user:" is — so if two people share a
  // title (e.g. two Facility Managers), either one can act as the
  // assignee of record for that task. Role options are derived from
  // whatever distinct Titles currently exist among active users, so a
  // title with nobody active in it doesn't show up as a dead-end choice.
  async function loadAssigneeOptions() {
    const [users, techs] = await Promise.all([loadRoles(), loadTechnicians()]);
    const activeUsers = users.filter(u => u.active);
    const userOpts = activeUsers.map(u => ({ value: 'user:' + u.name, label: u.name + ' (' + displayTitle(u) + ')' }));
    const techOpts = techs.filter(t => t.Active).map(t => ({ value: 'tech:' + t.TechnicianID, label: t.Name + ' (Technician)' }));
    const titles = [...new Set(activeUsers.map(u => displayTitle(u)).filter(Boolean))];
    const roleOpts = titles.map(t => ({ value: 'role:' + t, label: t + ' — Role (anyone with this title)' }));
    return userOpts.concat(techOpts, roleOpts).sort((a, b) => a.label.localeCompare(b.label));
  }

  function assigneeLabel(assignedTo, assigneeOptions) {
    if (!assignedTo) return '';
    const found = (assigneeOptions || []).find(o => o.value === assignedTo);
    if (found) return found.label;
    // fallback if options weren't loaded / person since deactivated /
    // the title no longer has anyone active holding it
    return assignedTo.replace(/^user:|^tech:|^role:/, '');
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
  // Single source of truth for the OpsTasks column order — module-ops.js
  // has its own copy for its normal read/write flow, but any OTHER
  // module creating a task (e.g. Plant Rounds auto-flagging a failed
  // checklist item) must match this exactly, so it's centralized here
  // rather than duplicated blindly. If Daily Ops' schema changes, both
  // copies need updating together.
  const OPS_TASK_COLS = ['TaskID','Title','Description','Priority','AssetID','AssetName',
    'CreatedBy','CreatedDate','PhotoURL_Initial','Status','ComplianceComment',
    'PhotoURL_Compliance','ClosedDate','ClosedBy','CategoryID','AssignedTo',
    'AttachmentURL_2','AttachmentURL_3',
    'ComplianceAttachmentURL_2','ComplianceAttachmentURL_3',
    'NoteCount','LastNoteAt','LastNoteAuthor','CreatorLastSeenNotesAt','AssigneeLastSeenNotesAt',
    'AssigneeSeenAt','DelegatedTo'];

  // Creates a Daily Ops task from another module (currently: Plant
  // Rounds auto-flagging a failed checklist item). categoryName must
  // match an OpsCategories.Name exactly; assigneeTitle becomes a
  // "role:<Title>" assignment (e.g. "role:Facility Manager") rather than
  // being resolved down to one specific person at creation time — ANY
  // active user who currently holds that title can act as the assignee
  // of record (close it, delegate it, see the "New" badge clear when
  // they open it), same as a manually-assigned "Role" option from
  // loadAssigneeOptions. Previously this picked "the first active user
  // whose displayTitle() matches" and froze the task to that one person
  // by name — which meant a second person sharing the exact same title
  // had no more claim to the task than a total stranger. No check that
  // anyone currently holds the title at all — an auto-created task with
  // an assigneeTitle nobody currently holds still gets that role
  // assignment (rather than silently going unassigned), so it's ready
  // to be picked up the moment someone with that title is added.
  // Returns the new TaskID.
  async function createOpsTask({ categoryName, title, description, assigneeTitle, priority, createdBy }) {
    const [categories, existingRows] = await Promise.all([
      loadCategories(), sheetsRead(TABS.opsTasks)
    ]);
    const category = categories.find(c => c.Name === categoryName);
    if (!category) throw new Error(`createOpsTask: no category named "${categoryName}"`);
    const existingIds = existingRows.slice(1).map(r => r[0]).filter(Boolean);
    const taskId = nextId('TASK', existingIds);
    const assignedTo = assigneeTitle ? 'role:' + assigneeTitle : '';
    const now = new Date().toISOString();
    const row = {
      TaskID: taskId, Title: title, Description: description || '', Priority: priority || 'Medium',
      AssetID: '', AssetName: '', CreatedBy: createdBy || 'System', CreatedDate: now,
      PhotoURL_Initial: '', Status: 'Open', ComplianceComment: '', PhotoURL_Compliance: '',
      ClosedDate: '', ClosedBy: '', CategoryID: category.CategoryID, AssignedTo: assignedTo,
      AttachmentURL_2: '', AttachmentURL_3: '', ComplianceAttachmentURL_2: '', ComplianceAttachmentURL_3: '',
      NoteCount: '', LastNoteAt: '', LastNoteAuthor: '', CreatorLastSeenNotesAt: '', AssigneeLastSeenNotesAt: '',
      AssigneeSeenAt: '', DelegatedTo: ''
    };
    await sheetsAppend(TABS.opsTasks, OPS_TASK_COLS.map(c => row[c] !== undefined ? row[c] : ''));
    await logAudit({ module: 'DailyOps', requestId: taskId, eventType: 'Created', comment: title + ' (auto-created by Plant Rounds)', statusAfter: 'Open' });
    return taskId;
  }

  // Auto-closes OPEN OpsTasks rows whose Title matches one of the given
  // rules — used by Plant Rounds to resolve its own auto-created tickets
  // once the activity they were complaining about actually gets logged,
  // without waiting for a human to notice and hit Close. `rules` is
  // [{matches: (title) => boolean, note: string}, ...]; the first
  // matching rule's `note` becomes that task's ComplianceComment (prefixed
  // "Auto-closed by system:"), so every auto-close is traceable back to
  // exactly what resolved it — never a silent status flip. Deliberately
  // does ONE read of OpsTasks no matter how many rules are passed in —
  // callers with many candidates (e.g. one rule per Distribution Panel)
  // should batch them into a single call rather than calling this once
  // per candidate. Returns how many tasks were closed.
  async function autoCloseOpsTasks(rules) {
    if (!rules || !rules.length) return 0;
    const idx = { Title: 1, Status: 9, ComplianceComment: 10, ClosedDate: 12, ClosedBy: 13 };
    const rows = await sheetsRead(TABS.opsTasks);
    let closedCount = 0;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][idx.Status] || '') !== 'Open') continue;
      const title = rows[i][idx.Title] || '';
      const rule = rules.find(rl => rl.matches(title));
      if (!rule) continue;
      const r = rows[i].slice();
      r[idx.Status] = 'Closed';
      r[idx.ComplianceComment] = `Auto-closed by system: ${rule.note}`;
      r[idx.ClosedDate] = new Date().toISOString();
      r[idx.ClosedBy] = 'System (Plant Rounds — auto-close)';
      try {
        await sheetsUpdateRow(TABS.opsTasks, i + 1, r.map(v => v === undefined ? '' : v));
        await logAudit({ module: 'DailyOps', requestId: r[0], eventType: 'AutoClosed', comment: rule.note, statusAfter: 'Closed' });
        closedCount++;
      } catch (e) {
        // best-effort — leave it open, this sweep (or the next one) will retry
      }
    }
    return closedCount;
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

  // Deletes a previously-uploaded photo from Drive via the SAME Apps
  // Script proxy used for uploads — actually reclaims storage, unlike
  // just clearing a URL out of a Sheet cell (which is all sheetsUpdateRow
  // can do). The script itself is responsible for turning this URL back
  // into a Drive file ID, since it generated the URL in the first place —
  // this just forwards it. Requires the Apps Script to have a 'delete'
  // action added (it won't by default); see the app's deployment notes.
  // Throws on failure so callers can decide whether to still clear the
  // link even when the file itself couldn't be removed (e.g. the script
  // hasn't been updated with the delete branch yet).
  async function deletePhotoFromDrive(url) {
    if (!url) return;
    if (!CFG.photoUploadUrl) throw new Error('No photo upload URL configured (Settings → Photo Upload URL)');
    const r = await fetchWithTimeout(CFG.photoUploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: CFG.photoUploadSecret, action: 'delete', url })
    }, 20000);
    if (!r.ok) throw new Error('Photo delete proxy error: ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error('Photo delete failed: ' + d.error);
    return true;
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
  // in three shapes so far:
  //   Old:      MVOA|AssetID|AssetName|Category|Location
  //   Labeled:  Code: X Name: Y Category: Z Sub-Category: W Location: V
  //   ID-prefixed pipe: <MVOA-...AssetID> | AssetName | Category [| Location]
  //     (AssetID itself starts with "MVOA-" rather than "MVOA" being its
  //     own token; segment count varies 2-4 depending on the label batch)
  // This parses any of the three; extend below if a fourth format shows
  // up from a different label batch.
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

    // Old pipe-delimited format — literal leading "MVOA" token
    const parts = text.split('|');
    if (parts[0] === 'MVOA' && parts.length >= 5) {
      return { assetId: parts[1], assetName: parts[2], category: parts[3], location: parts[4] };
    }

    // ID-prefixed pipe format — the AssetID itself starts with "MVOA-"
    // (e.g. "MVOA-EL-SL-001-02 | LED Street Lights | Street Lights"),
    // so there's no separate leading "MVOA" token to match against.
    // Segment count varies: 2 (ID + Name), 3 (+ Category), or 4 (+ Location).
    const idPrefixedParts = text.split('|').map(s => s.trim());
    if (/^MVOA-/.test(idPrefixedParts[0] || '') && idPrefixedParts.length >= 2) {
      const [assetId, assetName, category, location] = idPrefixedParts;
      if (assetId && assetName) {
        return { assetId, assetName, category: category || '', location: location || '' };
      }
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
    sheetsRead, sheetsRowCount, SHEET_RECENT_ROW_LIMITS, sheetsWrite, sheetsAppend, sheetsAppendMany, sheetsUpdateRow, sheetsEnsureTab, sheetsDeleteRows,
    hashPin, verifyPin, loadRoles, login, restoreSession, logout, getUser, roleLabel, displayTitle, changePin,
    isAdmin, resetUserPin, setUserActive, renameUser, addRolesRow,
    loadCategories, loadTechnicians, canEditCategory, canViewCategory, assigneeEditAccess, loadDailyOpsPermissionsMatrix, getDailyOpsPermissionsMatrixRows, loadAssigneeOptions, assigneeLabel,
    loadPlantRoundsPermissionsMatrix, canEditPlantRoundsSection, canViewPlantRoundsSection, getPlantRoundsPermissionsMatrixRows,
    loadAttendancePermissionsMatrix, canEditAttendanceSection, canViewAttendanceSection, getAttendancePermissionsMatrixRows,
    loadNotesForTask, appendNote,
    logAudit, nextId, createOpsTask, autoCloseOpsTasks,
    capturePhoto, pickAttachment, uploadPhotoToDrive, deletePhotoFromDrive,
    logoSvg,
    statusBadgeHtml, STATUS_STYLES,
    setAppBadge,
    parseAssetQR,
    registerModule, modulesForRole, modules
  };
})();
