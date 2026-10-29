// Google sign-in (Identity Services token flow) + thin Drive / Sheets / Picker wrappers.
// Everything runs in the browser; requests go straight from the user's device to Google.
import { CONFIG, SCOPES } from './config.js';

const TOKEN_KEY = `stash.token`;
let tokenClient = null;
let token = null; // { access_token, expires_at }
let pendingResolve = null;
let pendingReject = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement(`script`);
    s.src = src; s.async = true; s.defer = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

export const googleConfigured = () => Boolean(CONFIG.CLIENT_ID);
export const pickerConfigured = () => Boolean(CONFIG.API_KEY && CONFIG.APP_ID);

// Kept in localStorage (not sessionStorage) so closing and reopening the app within the hour needs no sign-in.
function restoreToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || `null`);
    if (t && t.expires_at > Date.now() + 60_000) token = t;
  } catch { /* ignore */ }
}

async function ensureClient() {
  if (tokenClient) return;
  await loadScript(`https://accounts.google.com/gsi/client`);
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) { pendingReject?.(new Error(resp.error_description || resp.error)); return; }
      token = { access_token: resp.access_token, expires_at: Date.now() + (resp.expires_in - 60) * 1000 };
      try { localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch { /* ignore */ }
      pendingResolve?.(token);
    },
    error_callback: (err) => pendingReject?.(new Error(err?.message || err?.type || `Sign-in was cancelled`)),
  });
}

/**
 * Ask Google for a token. Needs a user gesture (it may open a popup).
 * silent: no account picker or consent screen if the user already agreed; with `hint` Google picks the right account,
 * so the popup usually opens and closes by itself.
 */
export async function signIn({ silent = false, hint = `` } = {}) {
  await ensureClient();
  return new Promise((resolve, reject) => {
    pendingResolve = resolve; pendingReject = reject;
    tokenClient.requestAccessToken({ prompt: silent ? `` : `select_account`, ...(hint ? { hint, login_hint: hint } : {}) });
  });
}

/** ms until the current token expires (0 if none). */
export function tokenTimeLeft() { if (!token) restoreToken(); return token ? Math.max(0, token.expires_at - Date.now()) : 0; }

export function hasValidToken() {
  if (!token) restoreToken();
  return Boolean(token && token.expires_at > Date.now());
}

/** The current access token, or null if there is none or it has expired. Used by the licensing client. */
export function currentToken() { return hasValidToken() ? token.access_token : null; }

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null;
  localStorage.removeItem(TOKEN_KEY);
}

export class AuthError extends Error {}

async function api(url, opts = {}) {
  if (!hasValidToken()) throw new AuthError(`Session expired`);
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token.access_token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) { token = null; localStorage.removeItem(TOKEN_KEY); throw new AuthError(`Session expired`); }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const ct = res.headers.get(`content-type`) || ``;
  return ct.includes(`json`) ? res.json() : res;
}

const jsonBody = (obj) => ({ body: JSON.stringify(obj), headers: { 'Content-Type': `application/json` } });
const DRIVE = `https://www.googleapis.com/drive/v3`;
const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets`;

export const userinfo = () => api(`https://www.googleapis.com/oauth2/v3/userinfo`);

// ---------- Drive ----------
export const drive = {
  /** Find files this app created, tagged with appProperties.stash = role */
  async findTagged(role) {
    const q = `appProperties has { key='stash' and value='${role}' } and trashed = false`;
    const r = await api(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,owners(emailAddress))&spaces=drive`);
    return r.files || [];
  },
  createFolder(name, parentId, role) {
    return api(`${DRIVE}/files?fields=id,webViewLink`, {
      method: `POST`,
      ...jsonBody({
        name, mimeType: `application/vnd.google-apps.folder`,
        parents: parentId ? [parentId] : undefined,
        appProperties: role ? { stash: role } : undefined,
      }),
    });
  },
  tagAndMove(fileId, parentId, oldParents, role) {
    return api(`${DRIVE}/files/${fileId}?addParents=${parentId}&removeParents=${oldParents}&fields=id`, {
      method: `PATCH`, ...jsonBody({ appProperties: { stash: role } }),
    });
  },
  async upload(blob, name, parentId) {
    const meta = { name, parents: [parentId], mimeType: blob.type || `image/jpeg` };
    const form = new FormData();
    form.append(`metadata`, new Blob([JSON.stringify(meta)], { type: `application/json` }));
    form.append(`file`, blob);
    return api(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`, {
      method: `POST`, body: form,
    });
  },
  async downloadBlob(fileId) {
    const res = await api(`${DRIVE}/files/${fileId}?alt=media`);
    return res.blob();
  },
  share(fileId, email, role = `writer`, notify = true, type = `user`) {
    return api(`${DRIVE}/files/${fileId}/permissions?sendNotificationEmail=${notify}&fields=id`, {
      method: `POST`, ...jsonBody({ type, role, emailAddress: email }),
    });
  },
  meta(fileId) {
    return api(`${DRIVE}/files/${fileId}?fields=id,name,owners(emailAddress),parents,appProperties,webViewLink`);
  },
  /** Add or change appProperties (other keys are kept). */
  setAppProps(fileId, props) {
    return api(`${DRIVE}/files/${fileId}?fields=id`, { method: `PATCH`, ...jsonBody({ appProperties: props }) });
  },
  /** Everyone with access to a file this app created (drive.file allows it). */
  async permissions(fileId) {
    const out = []; let page = ``;
    do {
      const r = await api(`${DRIVE}/files/${fileId}/permissions?pageSize=100&fields=nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,deleted)${page ? `&pageToken=${page}` : ``}`);
      out.push(...(r.permissions || []));
      page = r.nextPageToken || ``;
    } while (page);
    return out;
  },
  unshare(fileId, permissionId) {
    return api(`${DRIVE}/files/${fileId}/permissions/${permissionId}`, { method: `DELETE` });
  },
};

// ---------- Sheets ----------
export const sheets = {
  create(title, tabs) {
    return api(SHEETS, {
      method: `POST`,
      ...jsonBody({
        properties: { title },
        sheets: tabs.map((t) => ({ properties: { title: t.name, gridProperties: { frozenRowCount: 1 } } })),
      }),
    });
  },
  batchGet(id, ranges) {
    const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join(`&`);
    return api(`${SHEETS}/${id}/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`);
  },
  get(id, range) {
    return api(`${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
  },
  update(id, range, values) {
    return api(`${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
      method: `PUT`, ...jsonBody({ range, values }),
    });
  },
  append(id, range, values) {
    return api(`${SHEETS}/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: `POST`, ...jsonBody({ values }),
    });
  },
  /** Structural changes (add a tab, hide it). */
  batchUpdate(id, requests) {
    return api(`${SHEETS}/${id}:batchUpdate`, { method: `POST`, ...jsonBody({ requests }) });
  },
  batchUpdateValues(id, data) {
    return api(`${SHEETS}/${id}/values:batchUpdate`, {
      method: `POST`, ...jsonBody({ valueInputOption: `RAW`, data }),
    });
  },
};

// ---------- Picker (join a shared inventory) ----------
export async function pickSpreadsheet() {
  if (!pickerConfigured()) throw new Error(`Picker is not configured (API_KEY and APP_ID in js/config.js).`);
  await loadScript(`https://apis.google.com/js/api.js`);
  await new Promise((r) => gapi.load(`picker`, r));
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
      .setMode(google.picker.DocsViewMode.LIST)
      .setQuery(`Inventory`) // matches both “Paran Inventory” and older “Stash Inventory”
      .setOwnedByMe(false);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token.access_token)
      .setDeveloperKey(CONFIG.API_KEY)
      .setAppId(CONFIG.APP_ID)
      .setTitle(`Pick the shared inventory sheet`)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) resolve(data.docs[0].id);
        else if (data.action === google.picker.Action.CANCEL) resolve(null);
      })
      .build();
    picker.setVisible(true);
  });
}
