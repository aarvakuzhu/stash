// Data layer: in-memory state + local cache + outbox, with two backends:
//  - GoogleBackend: Sheet + Drive folder in the user's own Google account
//  - DemoBackend:   everything in this browser (for trying the app without Google setup)
import { CONFIG } from './config.js';
import { drive, sheets, userinfo, AuthError } from './google.js';
import { blobs } from './idb.js';

export const ITEM_COLS = [`id`, `name`, `purpose`, `category`, `tags`, `locationId`, `qty`, `status`, `lentTo`,
  `photoId`, `photoUrl`, `warranty`, `expiry`, `notes`, `addedBy`, `addedAt`, `updatedAt`, `updatedBy`, `deleted`, `thumb`,
  `dueAt`, `size`, `photos`]; // columns added later go AFTER thumb so older sheets stay aligned
// photos: JSON list of additional photos [{ pid, id, url, thumb }]. In memory the thumbs live in repo.thumbs.
const THUMB_COL = colLetterOf(ITEM_COLS.indexOf(`thumb`));
const BEFORE_THUMB = colLetterOf(ITEM_COLS.indexOf(`thumb`) - 1);
const AFTER_THUMB = [ITEM_COLS.indexOf(`thumb`) + 1, ITEM_COLS.length - 1].map(colLetterOf);
function colLetterOf(n) { let s = ``; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
export const LOC_COLS = [`id`, `name`, `parentId`, `kind`, `notes`, `createdBy`, `createdAt`, `deleted`];
export const MEMBER_COLS = [`email`, `role`, `photoFolderId`, `invitedBy`, `joinedAt`];
export const LOG_COLS = [`ts`, `itemId`, `action`, `detail`, `by`, `info`, `changes`];
// info: readable summary (what changed / pick-up date / moved from). changes: JSON { field: [before, after] } so an edit can be undone;
// on `added` it is { _ai: [fields AI suggested] } so AI may refine its own suggestions later but never what someone typed.
export const TRACKED_FIELDS = [`name`, `purpose`, `category`, `size`, `tags`, `qty`, `warranty`, `expiry`, `notes`];

const TABS = [
  { name: `Items`, cols: ITEM_COLS },
  { name: `Locations`, cols: LOC_COLS },
  { name: `Members`, cols: MEMBER_COLS },
  { name: `Log`, cols: LOG_COLS },
];

const colLetter = (n) => { let s = ``; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const lastCol = (cols) => colLetter(cols.length - 1);
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, ``).slice(0, 10);
export const now = () => new Date().toISOString();
const uuid4 = () => (crypto.randomUUID ? crypto.randomUUID()
  : `10000000-1000-4000-8000-100000000000`.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const META_TAB = `Meta`; // hidden tab holding the licensing group id (tenantId); a copy of the sheet carries it

function rowsToObjects(values, cols) {
  if (!values || values.length < 2) return [];
  const header = values[0].map(String);
  const idx = cols.map((c) => header.indexOf(c));
  return values.slice(1).map((row) => {
    const o = {};
    cols.forEach((c, i) => { const v = idx[i] >= 0 ? row[idx[i]] : ``; o[c] = v === undefined || v === null ? `` : v; });
    return o;
  }).filter((o) => o.id || o.email || o.ts);
}
const objectToRow = (o, cols) => cols.map((c) => (o[c] === undefined || o[c] === null ? `` : o[c]));

// ------------------------------------------------------------------ backends
class DemoBackend {
  kind = `demo`;
  async connect() {
    return { user: { email: `you@demo.local`, name: `Demo user` }, label: `Demo – saved in this browser only` };
  }
  async fetchAll() { return null; } // the local cache is the source of truth
  async fetchThumbs() { return null; }
  async writeOps() { /* nothing remote */ }
  async uploadPhoto(blob, itemId) {
    const photoId = `local-${itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await blobs.put(`photo:${photoId}`, blob);
    return { photoId, photoUrl: `` };
  }
  async photoObjectUrl(item) {
    if (!item.photoId) return null;
    const b = await blobs.get(`photo:${item.photoId}`);
    return b ? URL.createObjectURL(b) : null;
  }
  get canShare() { return false; }
  get cacheKey() { return `demo`; }
}

const SESSION_KEY = `stash.session`;
const PHOTO_LRU_KEY = `stash.photoLRU`;
const PHOTO_CACHE_MAX = 150;

class GoogleBackend {
  kind = `google`;
  user = null; sheetId = null; sheetName = null; photoFolderId = null; rootFolderId = null; isOwner = true;
  tenantId = null; tenantSources = null; copiedFrom = null; appPropTenant = null; // licensing (only when CONFIG.LICENSE_URL is set)

  get cacheKey() { return this.sheetId; }
  get canShare() { return this.isOwner; }
  prefKey() { return `stash.sheet.${this.user.email}`; }

  /** choice: undefined (auto), `create` (start a new inventory), or a spreadsheet id picked to join */
  async connect(choice) {
    if (!this.user) {
      const u = await userinfo();
      this.user = { email: u.email, name: u.name || u.email, picture: u.picture };
    }
    this.sheetId = choice && choice !== `create` ? choice : localStorage.getItem(this.prefKey());
    if (this.sheetId) {
      try { await this.inspectSheet(); }
      catch (e) { if (e instanceof AuthError || choice) throw e; this.sheetId = null; }
    }
    if (!this.sheetId) {
      const found = await drive.findTagged(`sheet`);
      if (found.length) { this.sheetId = found[0].id; await this.inspectSheet(); }
      else if (choice === `create`) await this.createInventory();
      else return { user: this.user, needsChoice: true };
    }
    localStorage.setItem(this.prefKey(), this.sheetId);
    await this.ensureHeaders();
    await this.ensurePhotoFolder();
    await this.ensureTenant().catch((e) => console.warn(`licensing: group id not set`, e));
    this.saveSession();
    return { user: this.user, label: this.label() };
  }

  label() { return this.isOwner ? `Your Google Drive` : `Shared inventory`; }

  // Remember enough to reopen straight into the cached inventory, even before Google has re-issued a token.
  saveSession() {
    if (this.legacy) return;
    const { user, sheetId, sheetName, isOwner, rootFolderId, photoFolderId, sheetUrl, tenantId, tenantSources, copiedFrom } = this;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, sheetId, sheetName, isOwner, rootFolderId, photoFolderId, sheetUrl, tenantId, tenantSources, copiedFrom }));
  }
  static savedSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || `null`); } catch { return null; } }
  resume() {
    const s = GoogleBackend.savedSession() || GoogleBackend.legacySession(); if (!s?.sheetId) return null;
    Object.assign(this, s);
    return { user: this.user, label: this.label() };
  }

  /** Installs from before sessions were saved: rebuild one from the keys they already have on the device. */
  static legacySession() {
    try {
      const key = Object.keys(localStorage).find((k) => k.startsWith(`stash.sheet.`) && localStorage.getItem(k));
      if (!key) return null;
      const email = key.slice(`stash.sheet.`.length);
      const sheetId = localStorage.getItem(key);
      if (!localStorage.getItem(`stash.cache.${sheetId}`)) return null; // nothing cached to show yet
      return { user: { email, name: email.split(`@`)[0] }, sheetId, isOwner: true, rootFolderId: null,
        photoFolderId: localStorage.getItem(`stash.photos.${email}.${sheetId}`), sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`, legacy: true };
    } catch { return null; }
  }

  /** After a resume, finish the one-time checks once we have a token. */
  async afterResume() {
    if (this.legacy) {
      const u = await userinfo();
      this.user = { email: u.email, name: u.name || u.email, picture: u.picture };
      await this.inspectSheet(); this.legacy = false;
    }
    else if (!this.sheetName) await this.inspectSheet().catch(() => {}); // sessions saved before sheet names were kept
    await this.ensureHeaders(); await this.ensurePhotoFolder();
    await this.ensureTenant().catch((e) => console.warn(`licensing: group id not set`, e));
    this.saveSession();
  }

  async inspectSheet() {
    const m = await drive.meta(this.sheetId);
    this.sheetName = m.name || null;
    const owner = m.owners?.[0]?.emailAddress;
    this.isOwner = !owner || owner === this.user.email;
    this.rootFolderId = this.isOwner ? (m.parents?.[0] || null) : null;
    this.appPropTenant = m.appProperties?.licTenant || null;
    this.sheetUrl = `https://docs.google.com/spreadsheets/d/${this.sheetId}/edit`;
  }

  async createInventory() {
    const root = await drive.createFolder(CONFIG.ROOT_FOLDER_NAME, null, `root`);
    const ss = await sheets.create(CONFIG.SHEET_NAME, TABS);
    const m = await drive.meta(ss.spreadsheetId);
    await drive.tagAndMove(ss.spreadsheetId, root.id, (m.parents || []).join(`,`), `sheet`);
    await sheets.batchUpdateValues(ss.spreadsheetId, TABS.map((t) => ({ range: `${t.name}!A1`, values: [t.cols] })));
    await sheets.append(ss.spreadsheetId, `Members!A1`, [objectToRow(
      { email: this.user.email, role: `owner`, invitedBy: ``, joinedAt: now() }, MEMBER_COLS)]);
    this.sheetId = ss.spreadsheetId; this.sheetName = CONFIG.SHEET_NAME; this.rootFolderId = root.id; this.isOwner = true;
    this.sheetUrl = `https://docs.google.com/spreadsheets/d/${this.sheetId}/edit`;
  }

  /** Older sheets: add header cells for columns introduced since (they're always appended at the end). */
  async ensureHeaders() {
    const key = `stash.hdr.${this.sheetId}`;
    const ver = `${ITEM_COLS.length}.${LOG_COLS.length}`;
    if (localStorage.getItem(key) === ver) return;
    const r = await sheets.batchGet(this.sheetId, [`Items!1:1`, `Log!1:1`]);
    const updates = [];
    [[`Items`, ITEM_COLS], [`Log`, LOG_COLS]].forEach(([tab, cols], i) => {
      const header = (r.valueRanges[i]?.values?.[0] || []).map(String);
      const isPrefix = header.every((h, j) => h === cols[j]);
      if (header.length < cols.length && isPrefix) updates.push({ range: `${tab}!A1`, values: [cols] });
    });
    if (updates.length) await sheets.batchUpdateValues(this.sheetId, updates);
    localStorage.setItem(key, ver);
  }

  async ensurePhotoFolder() {
    const key = `stash.photos.${this.user.email}.${this.sheetId}`;
    this.photoFolderId = localStorage.getItem(key);
    if (this.photoFolderId) return;
    const role = `photos-${this.sheetId}`;
    const found = await drive.findTagged(role);
    if (found.length) this.photoFolderId = found[0].id;
    else {
      const f = await drive.createFolder(
        this.isOwner ? `Photos` : `${CONFIG.APP_NAME} photos (shared inventory)`, this.isOwner ? this.rootFolderId : null, role);
      this.photoFolderId = f.id;
      if (!this.isOwner) {
        // let everyone in this inventory open the full-size photos this member adds
        const r = await sheets.get(this.sheetId, `Members!A1:${lastCol(MEMBER_COLS)}`);
        const members = rowsToObjects(r.values, MEMBER_COLS);
        for (const m of members) {
          if (m.email && m.email !== this.user.email) await drive.share(f.id, m.email, `reader`, false).catch(() => {});
        }
      }
    }
    localStorage.setItem(key, this.photoFolderId);
  }

  async fetchAll() {
    const r = await sheets.batchGet(this.sheetId, [
      `Items!A1:${BEFORE_THUMB}`, // everything except the (large) thumb column…
      `Locations!A1:${lastCol(LOC_COLS)}`,
      `Members!A1:${lastCol(MEMBER_COLS)}`,
      `Log!A1:${lastCol(LOG_COLS)}`,
      `Items!${AFTER_THUMB[0]}1:${AFTER_THUMB[1]}`, // …plus columns added after it
    ]);
    const [left, locs, members, log, right] = r.valueRanges.map((v) => v.values || []);
    const items = left.map((row, i) => [...row, ...Array(Math.max(0, ITEM_COLS.indexOf(`thumb`) - row.length)).fill(``), ``, ...(right[i] || [])]);
    if (items[0]) items[0].splice(ITEM_COLS.indexOf(`thumb`), 1, `thumb`);
    return {
      log: rowsToObjects(log, LOG_COLS).slice(-5000),
      items: rowsToObjects(items, ITEM_COLS.filter((c) => c !== `thumb`)),
      locations: rowsToObjects(locs, LOC_COLS),
      members: rowsToObjects(members, MEMBER_COLS),
    };
  }

  async fetchThumbs() {
    const tc = THUMB_COL;
    const r = await sheets.batchGet(this.sheetId, [`Items!A:A`, `Items!${tc}:${tc}`]);
    const ids = r.valueRanges[0].values || [];
    const th = r.valueRanges[1].values || [];
    const map = {};
    for (let i = 1; i < ids.length; i++) if (ids[i]?.[0] && th[i]?.[0]) map[ids[i][0]] = th[i][0];
    return map;
  }

  async writeOps(ops) {
    const rowMaps = {};
    const rowMap = async (tab) => {
      if (!rowMaps[tab]) {
        const r = await sheets.get(this.sheetId, `${tab}!A:A`);
        const m = {}; (r.values || []).forEach((row, i) => { if (i > 0 && row[0]) m[row[0]] = i + 1; });
        rowMaps[tab] = m;
      }
      return rowMaps[tab];
    };
    for (const op of ops) {
      if (op.kind === `log`) { await sheets.append(this.sheetId, `Log!A1`, [objectToRow(op.data, LOG_COLS)]); continue; }
      if (op.kind === `member`) { await sheets.append(this.sheetId, `Members!A1`, [objectToRow(op.data, MEMBER_COLS)]); continue; }
      const tab = op.kind === `item` ? `Items` : `Locations`;
      const cols = op.kind === `item` ? ITEM_COLS : LOC_COLS;
      const m = await rowMap(tab);
      const row = objectToRow(op.data, cols);
      const r = m[op.data.id];
      if (r) await sheets.update(this.sheetId, `${tab}!A${r}:${lastCol(cols)}${r}`, [row]);
      else {
        const res = await sheets.append(this.sheetId, `${tab}!A1`, [row]);
        const match = /![A-Z]+(\d+)/.exec(res.updates?.updatedRange || ``);
        if (match) m[op.data.id] = Number(match[1]);
      }
    }
  }

  async uploadPhoto(blob, itemId, name = `${itemId}.jpg`) {
    const f = await drive.upload(blob, name, this.photoFolderId);
    return { photoId: f.id, photoUrl: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` };
  }

  /** Full photo from this device's cache, else from Drive (then cached). Throws AuthError when a sign-in is needed. */
  photoObjectUrl(item) {
    if (!item.photoId) return Promise.resolve(null);
    // one download per photo even if the screen asks twice while it's loading
    this.inflight ||= new Map();
    if (!this.inflight.has(item.photoId)) {
      const p = this.loadPhoto(item).finally(() => this.inflight.delete(item.photoId));
      this.inflight.set(item.photoId, p);
    }
    return this.inflight.get(item.photoId).then((blob) => (blob ? URL.createObjectURL(blob) : null));
  }

  async loadPhoto(item) {
    const key = `photo:${item.photoId}`;
    const cached = await blobs.get(key).catch(() => null);
    if (cached) { touchLru(item.photoId); return cached; }
    let blob;
    try { blob = await drive.downloadBlob(item.photoId); }
    catch (e) { if (e instanceof AuthError) throw e; return null; } // e.g. a photo in another member's Drive
    await blobs.put(key, blob).catch(() => {});
    touchLru(item.photoId);
    return blob;
  }

  async invite(email) {
    await drive.share(this.sheetId, email, `writer`, true);
    if (this.rootFolderId) await drive.share(this.rootFolderId, email, `reader`, false);
    return { email, role: `member`, photoFolderId: ``, invitedBy: this.user.email, joinedAt: now() };
  }

  forgetSheet() { localStorage.removeItem(this.prefKey()); }

  // ---------------- licensing: group id, and who has access in Drive

  /**
   * Read the group id from the sheet's appProperties and the hidden Meta tab, and report both as found.
   * The owner mints one if neither exists, and fills in a missing one after reading (so a failed first write heals;
   * the server has already seen what was read). Members never write.
   */
  async ensureTenant() {
    if (!CONFIG.LICENSE_URL) return;
    const fromProps = this.appPropTenant ?? ((await drive.meta(this.sheetId)).appProperties?.licTenant || null);
    let fromMeta = null;
    try {
      const row = (await sheets.get(this.sheetId, `${META_TAB}!A1:B1`)).values?.[0];
      if (row?.[0] === `tenantId` && row[1]) fromMeta = String(row[1]);
    } catch (e) { if (e instanceof AuthError) throw e; /* no Meta tab yet */ }
    this.tenantSources = { appProperties: fromProps, metaTab: fromMeta };
    this.tenantId = fromMeta || fromProps || this.tenantId || null; // Meta first: copies of the sheet carry it
    if (!this.isOwner) return;
    if (!this.tenantId) this.tenantId = uuid4();
    if (!fromProps || !fromMeta || fromProps !== fromMeta) await this.writeTenantId(this.tenantId, { props: fromProps !== this.tenantId, meta: fromMeta !== this.tenantId });
  }

  async writeTenantId(id, { props = true, meta = true } = {}) {
    if (props) {
      await drive.setAppProps(this.sheetId, { licTenant: id });
      if (this.rootFolderId) await drive.setAppProps(this.rootFolderId, { licTenant: id }).catch(() => {});
      this.appPropTenant = id;
    }
    if (meta) {
      try { await sheets.update(this.sheetId, `${META_TAB}!A1:B1`, [[`tenantId`, id]]); }
      catch (e) {
        if (e instanceof AuthError) throw e;
        await sheets.batchUpdate(this.sheetId, [{ addSheet: { properties: { title: META_TAB, hidden: true } } }]);
        await sheets.update(this.sheetId, `${META_TAB}!A1:B1`, [[`tenantId`, id]]);
      }
    }
  }

  /** A copy of someone else's sheet: give it its own group id. Returns the new context for the licensing client. */
  async rekeyTenant() {
    const old = this.tenantId; const id = uuid4();
    await this.writeTenantId(id);
    Object.assign(this, { tenantId: id, copiedFrom: old, tenantSources: { appProperties: id, metaTab: id } });
    this.saveSession();
    return { tenantId: id, copiedFrom: old, sources: this.tenantSources };
  }

  /** Files that give access to this inventory, each with its general access and the people on it. Owner only. */
  async listAccess() {
    const files = [{ fileId: this.sheetId, kind: `sheet`, inventoryId: this.sheetId }];
    if (this.rootFolderId) files.push({ fileId: this.rootFolderId, kind: `photoFolder`, inventoryId: null });
    for (const f of files) {
      const perms = (await drive.permissions(f.fileId)).filter((p) => !p.deleted);
      f.general = perms.some((p) => p.type === `anyone`) ? `anyoneWithLink` : perms.some((p) => p.type === `domain`) ? `domain` : `restricted`;
      f.perms = perms.filter((p) => p.type === `user` || p.type === `group`);
    }
    return files;
  }

  /** Take someone's access away on every file of this inventory. Returns what was removed, for Undo. */
  async removeAccess(email) {
    const e = String(email).toLowerCase(); const removed = [];
    for (const f of await this.listAccess()) {
      for (const p of f.perms) {
        if (p.role === `owner` || String(p.emailAddress || ``).toLowerCase() !== e) continue;
        await drive.unshare(f.fileId, p.id);
        removed.push({ fileId: f.fileId, role: p.role, type: p.type });
      }
    }
    return removed;
  }

  async restoreAccess(email, removed) {
    for (const r of removed) await drive.share(r.fileId, email, r.role, false, r.type);
  }
}

function touchLru(photoId) {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(PHOTO_LRU_KEY) || `[]`); } catch { /* ignore */ }
  list = [photoId, ...list.filter((x) => x !== photoId)];
  for (const old of list.splice(PHOTO_CACHE_MAX)) blobs.del(`photo:${old}`).catch(() => {});
  try { localStorage.setItem(PHOTO_LRU_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ repository
export class Repo extends EventTarget {
  items = []; locations = []; members = []; log = []; thumbs = {};
  outbox = []; syncing = false; status = `idle`; lastError = null;

  constructor(kind) {
    super();
    this.backend = kind === `google` ? new GoogleBackend() : new DemoBackend();
  }

  emit(type = `change`) { this.dispatchEvent(new Event(type)); }
  get key() { return `stash.cache.${this.backend.cacheKey}`; }

  async connect(choice) {
    const info = await this.backend.connect(choice);
    this.user = info.user;
    if (info.needsChoice) return info;
    this.label = info.label;
    this.loadCache();
    this.emit();
    if (this.backend.kind === `demo` && !this.items.length && !this.locations.length) this.seedDemo();
    this.refresh();
    return info;
  }

  /** Open from the saved session and local cache without any network call. Returns info or null. */
  resume() {
    if (this.backend.kind !== `google`) return null;
    const info = this.backend.resume(); if (!info) return null;
    this.user = info.user; this.label = info.label; this.needsResumeChecks = true;
    this.loadCache(); this.emit();
    return info;
  }

  loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(this.key) || `null`);
      if (c) Object.assign(this, { items: c.items || [], locations: c.locations || [], members: c.members || [], log: c.log || [], outbox: c.outbox || [] });
    } catch { /* ignore */ }
    blobs.get(`thumbs:${this.backend.cacheKey}`).then((t) => { if (t) { this.thumbs = { ...t, ...this.thumbs }; this.emit(); } });
  }

  saveCache() {
    const strip = this.items.map(({ thumb, ...rest }) => rest);
    try {
      localStorage.setItem(this.key, JSON.stringify({ items: strip, locations: this.locations, members: this.members, log: this.log.slice(-3000), outbox: this.outbox }));
    } catch (e) { console.warn(`cache save failed`, e); }
    blobs.put(`thumbs:${this.backend.cacheKey}`, this.thumbs).catch(() => {});
  }

  /** Pull latest from the backend, keeping any local edits still waiting in the outbox. */
  async refresh() {
    if (this.needsResumeChecks) {
      try { await this.backend.afterResume(); this.needsResumeChecks = false; this.user = this.backend.user; this.label = this.backend.label(); }
      catch (e) { this.handleError(e); return; }
    }
    await this.flush();
    if (!navigator.onLine) return;
    try {
      const data = await this.backend.fetchAll();
      if (data) {
        const pending = new Map(this.outbox.filter((o) => o.kind === `item` || o.kind === `location`).map((o) => [o.data.id, o.data]));
        this.items = data.items.map((i) => pending.get(i.id) || i);
        for (const [id, d] of pending) if (!this.items.find((i) => i.id === id) && `purpose` in d) this.items.push(d);
        this.locations = data.locations.map((l) => pending.get(l.id) || l);
        for (const [id, d] of pending) if (!this.locations.find((l) => l.id === id) && `kind` in d) this.locations.push(d);
        this.items.forEach((i) => this.absorbPhotoThumbs(i));
        this.members = data.members;
        const pendingLog = this.outbox.filter((o) => o.kind === `log`).map((o) => o.data);
        this.log = [...(data.log || []), ...pendingLog];
        this.saveCache(); this.emit();
        const t = await this.backend.fetchThumbs();
        if (t) { this.thumbs = { ...this.thumbs, ...t }; this.saveCache(); this.emit(); }
      }
      this.setStatus(this.outbox.length ? `pending` : `synced`);
    } catch (e) { this.handleError(e); }
  }

  setStatus(s, err = null) { this.status = s; this.lastError = err; this.emit(`status`); }

  handleError(e) {
    console.error(e);
    if (e instanceof AuthError) this.setStatus(`auth`, e);
    else this.setStatus(navigator.onLine ? `error` : `offline`, e);
  }

  queue(op) { this.outbox.push(op); this.saveCache(); this.flush(); }

  async flush() {
    if (this.syncing || !this.outbox.length) return;
    if (!navigator.onLine) { this.setStatus(`offline`); return; }
    this.syncing = true; this.setStatus(`syncing`);
    try {
      while (this.outbox.length) {
        const op = this.outbox[0];
        if (op.kind === `photo`) await this.flushPhoto(op);
        else if (op.kind === `xphoto`) await this.flushExtraPhoto(op);
        else {
          const data = op.kind === `item` ? { ...op.data, thumb: this.thumbs[op.data.id] || ``, photos: this.photosForSheet(op.data.photos) } : op.data;
          await this.backend.writeOps([{ ...op, data }]);
        }
        this.outbox.shift(); this.saveCache();
      }
      this.setStatus(`synced`);
    } catch (e) { this.handleError(e); }
    finally { this.syncing = false; }
  }

  async flushPhoto(op) {
    const blob = await blobs.get(`pending:${op.itemId}`);
    if (blob) {
      const { photoId, photoUrl } = await this.backend.uploadPhoto(blob, op.itemId);
      const item = this.items.find((i) => i.id === op.itemId);
      if (item) {
        item.photoId = photoId; item.photoUrl = photoUrl;
        // make sure the photo reference reaches the sheet even if the item row was already written
        this.outbox.splice(1, 0, { kind: `item`, data: { ...item } });
      }
      await blobs.del(`pending:${op.itemId}`);
      this.emit();
    }
  }

  async flushExtraPhoto(op) {
    const blob = await blobs.get(`pending:x:${op.pid}`);
    const item = this.items.find((i) => i.id === op.itemId);
    const list = item ? this.photosOf(item) : [];
    const entry = list.find((p) => p.pid === op.pid);
    if (blob && entry) {
      const { photoId, photoUrl } = await this.backend.uploadPhoto(blob, op.itemId, `${op.itemId}-${op.pid}.jpg`);
      entry.id = photoId; entry.url = photoUrl;
      item.photos = JSON.stringify(list);
      this.outbox.splice(1, 0, { kind: `item`, data: { ...item } });
    }
    if (blob) await blobs.del(`pending:x:${op.pid}`);
    this.emit();
  }

  // ---------------- extra photos (close-up, scale)
  static parsePhotos(v) {
    try { const a = typeof v === `string` ? JSON.parse(v || `[]`) : (v || []); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  photosOf(item) { return Repo.parsePhotos(item?.photos); }
  /** Sheet value: the list plus each photo's small preview, so everyone in the inventory sees them. */
  photosForSheet(v) {
    const list = Repo.parsePhotos(v);
    return list.length ? JSON.stringify(list.map((p) => ({ ...p, thumb: this.thumbs[`x:${p.pid}`] || `` }))) : ``;
  }
  /** Coming from the sheet: move previews into the thumbs store so the cache stays small. */
  absorbPhotoThumbs(item) {
    const list = Repo.parsePhotos(item.photos);
    for (const p of list) if (p.thumb) { this.thumbs[`x:${p.pid}`] = p.thumb; delete p.thumb; }
    item.photos = list.length ? JSON.stringify(list) : ``;
  }
  static MAX_EXTRA_PHOTOS = 5; // + the main photo = 6; their previews must fit one sheet cell
  async addExtraPhoto(itemId, { photo, thumb }, { log = true } = {}) {
    const item = this.items.find((i) => i.id === itemId); if (!item) return null;
    const list = this.photosOf(item);
    if (list.length >= Repo.MAX_EXTRA_PHOTOS) return null;
    const pid = uid();
    list.push({ pid, id: ``, url: `` });
    this.thumbs[`x:${pid}`] = thumb;
    await blobs.put(`pending:x:${pid}`, photo);
    await this.saveItem({ id: itemId, photos: JSON.stringify(list) }, { logAction: log ? `edited` : null, info: `Photo added`, noLog: !log });
    this.outbox.push({ kind: `xphoto`, itemId, pid });
    this.saveCache(); this.flush();
    return pid;
  }
  async removeExtraPhoto(itemId, pid) {
    const item = this.items.find((i) => i.id === itemId); if (!item) return;
    const gone = this.photosOf(item).find((p) => p.pid === pid);
    const list = this.photosOf(item).filter((p) => p.pid !== pid);
    if (gone) delete this.thumbs[`x:${gone.pid}`];
    await this.saveItem({ id: itemId, photos: list.length ? JSON.stringify(list) : `` }, { logAction: `edited`, info: `Photo removed` });
  }
  extraPhotoUrl(entry) {
    return blobs.get(`pending:x:${entry.pid}`).then((b) => (b ? URL.createObjectURL(b) : entry.id ? this.backend.photoObjectUrl({ photoId: entry.id }) : null));
  }

  // ---------------- queries
  locById(id) { return this.locations.find((l) => l.id === id && !l.deleted); }
  pathOf(locId) {
    const parts = []; let l = this.locById(locId); let guard = 0;
    while (l && guard++ < 20) { parts.unshift(l); l = this.locById(l.parentId); }
    return parts;
  }
  pathText(locId) { return this.pathOf(locId).map((l) => l.name).join(` › `); }
  childrenOf(parentId) {
    return this.locations.filter((l) => !l.deleted && (l.parentId || ``) === (parentId || ``)).sort((a, b) => a.name.localeCompare(b.name));
  }
  descendantIds(locId) {
    const out = new Set([locId]); let added = true;
    while (added) { added = false; for (const l of this.locations) if (!l.deleted && out.has(l.parentId) && !out.has(l.id)) { out.add(l.id); added = true; } }
    return out;
  }
  activeItems() { return this.items.filter((i) => !i.deleted); }
  itemsIn(locId, deep = false) {
    const ids = deep ? this.descendantIds(locId) : new Set([locId]);
    return this.activeItems().filter((i) => ids.has(i.locationId));
  }
  categories() { return [...new Set(this.activeItems().map((i) => i.category).filter(Boolean))].sort(); }

  // ---------------- mutations
  async saveItem(fields, { photo, thumb, logAction, detail, info, noLog = false, aiFields = [] } = {}) {
    const existing = fields.id && this.items.find((i) => i.id === fields.id);
    const before = existing ? { ...existing } : null;
    const item = existing ? { ...existing, ...fields } : {
      id: uid(), name: ``, purpose: ``, category: ``, tags: ``, locationId: ``, qty: 1, status: `home`, lentTo: ``, dueAt: ``, size: ``, photos: ``,
      photoId: ``, photoUrl: ``, warranty: ``, expiry: ``, notes: ``, addedBy: this.user.email, addedAt: now(),
      deleted: ``, ...fields,
    };
    item.updatedAt = now(); item.updatedBy = this.user.email;
    if (thumb) this.thumbs[item.id] = thumb;
    if (existing) Object.assign(existing, item); else this.items.unshift(item);
    if (photo) await blobs.put(`pending:${item.id}`, photo);
    this.outbox.push({ kind: `item`, data: { ...item } });
    if (photo) this.outbox.push({ kind: `photo`, itemId: item.id });
    const action = logAction || (existing ? `edited` : `added`);
    if (!noLog) {
      const entry = { ts: now(), itemId: item.id, action, detail: detail ?? this.logDetail(action, item), by: this.user.email,
        info: info ?? this.logInfo(action, before, item, Boolean(photo)), changes: this.changesJson(before, item, aiFields) };
      this.log.push(entry);
      this.outbox.push({ kind: `log`, data: entry });
      this.dispatchEvent(new CustomEvent(`logged`, { detail: { action, photo: Boolean(photo), ai: aiFields.length > 0 } })); // usage counts
    }
    this.saveCache(); this.emit(); this.flush();
    return item;
  }

  /** Exact before/after of the descriptive fields (kept whole, up to 4,000 characters each) so they can be restored. */
  changesJson(before, item, aiFields) {
    if (!before) return aiFields.length ? JSON.stringify({ _ai: aiFields }) : ``;
    const cut = (v) => String(v ?? ``).slice(0, 4000);
    const ch = {};
    for (const f of TRACKED_FIELDS) if (String(before[f] ?? ``) !== String(item[f] ?? ``)) ch[f] = [cut(before[f]), cut(item[f])];
    return Object.keys(ch).length ? JSON.stringify(ch) : ``;
  }
  static parseChanges(v) { try { const o = JSON.parse(v || `{}`); return o && typeof o === `object` ? o : {}; } catch { return {}; } }

  /** Was this field last set by AI (so AI may refine it), rather than typed by a person? */
  fieldSetByAi(itemId, field) {
    for (const e of this.itemHistory(itemId)) { // newest first
      const ch = Repo.parseChanges(e.changes);
      if (field in ch) return /^(AI\b|Updated by AI)/.test(e.info || ``);
      if (e.action === `added`) return Array.isArray(ch._ai) && ch._ai.includes(field);
    }
    return false;
  }

  /** Extra context for the history: what an edit changed, where a move came from, a pick-up date. */
  logInfo(action, before, item, newPhoto) {
    if (action === `moved` && before && before.locationId !== item.locationId) return `from ${this.pathText(before.locationId) || `no location`}`;
    if (action === `reserved` && item.dueAt) return `due ${item.dueAt}`;
    if (action !== `edited` || !before) return ``;
    const short = (v) => { const t = String(v ?? ``).replace(/\s+/g, ` `).trim(); return t ? (t.length > 40 ? `${t.slice(0, 39)}…` : t) : `empty`; };
    const labels = { name: `Name`, purpose: `What it’s for`, category: `Category`, size: `Size`, tags: `Search words`, qty: `How many`, warranty: `Warranty`, expiry: `Expires`, notes: `Notes` };
    const changes = Object.entries(labels)
      .filter(([k]) => String(before[k] ?? ``) !== String(item[k] ?? ``))
      .map(([k, label]) => `${label}: ${short(before[k])} → ${short(item[k])}`);
    if (before.locationId !== item.locationId) changes.push(`Place: ${short(this.pathText(before.locationId))} → ${short(this.pathText(item.locationId))}`);
    if (newPhoto) changes.push(`New photo`);
    return changes.join(` · `);
  }

  /** Everything that happened to one item, newest first. */
  itemHistory(itemId) {
    return this.log.filter((e) => e.itemId === itemId).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }

  logDetail(action, item) {
    if (action === `moved` || action === `added`) return this.pathText(item.locationId);
    if (action === `lent`) return item.lentTo;
    return ``;
  }

  moveItem(item, locationId) {
    const keep = item.status === `reserved`; // a saved item stays saved for its person when moved
    return this.saveItem({ id: item.id, locationId, ...(keep ? {} : { status: `home`, lentTo: `` }) }, { logAction: `moved` });
  }
  reserveItem(item, to, dueAt = ``) { return this.saveItem({ id: item.id, status: `reserved`, lentTo: to.trim(), dueAt }, { logAction: `reserved`, detail: to.trim() }); }
  pickUp(item) { return this.saveItem({ id: item.id, status: `lent`, dueAt: `` }, { logAction: `lent`, detail: item.lentTo }); }
  cancelReservation(item) { return this.saveItem({ id: item.id, status: `home`, lentTo: ``, dueAt: `` }, { logAction: `unreserved`, detail: item.lentTo }); }
  lendItem(item, to) { return this.saveItem({ id: item.id, status: `lent`, lentTo: to.trim(), dueAt: `` }, { logAction: `lent`, detail: to.trim() }); }
  returnItem(item) { return this.saveItem({ id: item.id, status: `home`, lentTo: `` }, { logAction: `returned`, detail: item.lentTo || `` }); }
  markMissing(item) { return this.saveItem({ id: item.id, status: `missing` }, { logAction: `missing` }); }
  markFound(item) { return this.saveItem({ id: item.id, status: `home` }, { logAction: `found` }); }
  deleteItem(item) { return this.saveItem({ id: item.id, deleted: now() }, { logAction: `removed` }); }

  saveLocation(fields) {
    const existing = fields.id && this.locations.find((l) => l.id === fields.id);
    const loc = existing ? { ...existing, ...fields } : {
      id: uid(), name: ``, parentId: ``, kind: `room`, notes: ``, createdBy: this.user.email, createdAt: now(), deleted: ``, ...fields,
    };
    if (existing) Object.assign(existing, loc); else this.locations.push(loc);
    this.queue({ kind: `location`, data: { ...loc } });
    this.emit();
    return loc;
  }
  deleteLocation(loc) { return this.saveLocation({ id: loc.id, deleted: now() }); }

  async invite(email) {
    const member = await this.backend.invite(email);
    this.members.push(member);
    this.queue({ kind: `member`, data: member });
    this.emit();
  }

  photoObjectUrl(item) {
    return blobs.get(`pending:${item.id}`).then((b) => (b ? URL.createObjectURL(b) : this.backend.photoObjectUrl(item)));
  }

  exportCsv() {
    const cols = [`name`, `purpose`, `category`, `size`, `tags`, `location`, `qty`, `status`, `lentTo`, `dueAt`, `warranty`, `expiry`, `notes`, `photoUrl`, `addedBy`, `addedAt`];
    const esc = (v) => `"${String(v ?? ``).replace(/"/g, `""`)}"`;
    const lines = [cols.join(`,`)];
    for (const i of this.activeItems()) lines.push(cols.map((c) => esc(c === `location` ? this.pathText(i.locationId) : i[c])).join(`,`));
    return new Blob([lines.join(`\n`)], { type: `text/csv` });
  }

  // ---------------- people you lend to (derived from lends; no separate list to maintain)
  static personKey(name) { return String(name || ``).trim().toLowerCase().replace(/\s+/g, ` `); }

  /**
   * Lend periods incl. reservations: [{ itemId, name, key, savedAt, lentAt, returnedAt, cancelledAt, how }], oldest first.
   * A reservation that's picked up becomes the same period (savedAt → lentAt → returnedAt).
   */
  lendPeriods() {
    const openLend = new Map(); const openRes = new Map(); const out = [];
    const mk = (e, extra) => ({ itemId: e.itemId, name: String(e.detail), key: Repo.personKey(e.detail), savedAt: null, lentAt: null, returnedAt: null, cancelledAt: null, ...extra });
    const sorted = [...this.log].filter((e) => e.ts && e.itemId).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (const e of sorted) {
      const id = e.itemId; const k = Repo.personKey(e.detail);
      if (e.action === `reserved` && e.detail) {
        const r = openRes.get(id); if (r) r.cancelledAt = e.ts;
        const due = /due (\d{4}-\d{2}-\d{2})/.exec(e.info || ``)?.[1] || ``;
        const p = mk(e, { savedAt: e.ts, dueAt: due }); out.push(p); openRes.set(id, p);
      } else if (e.action === `unreserved`) {
        const r = openRes.get(id); if (r) { r.cancelledAt = e.ts; openRes.delete(id); }
      } else if (e.action === `lent` && e.detail) {
        const cur = openLend.get(id); if (cur) cur.returnedAt = e.ts;
        const r = openRes.get(id); let p;
        if (r && r.key === k) { p = r; p.lentAt = e.ts; p.name = String(e.detail); }
        else { if (r) r.cancelledAt = e.ts; p = mk(e, { lentAt: e.ts }); out.push(p); }
        openRes.delete(id); openLend.set(id, p);
      } else if ([`returned`, `moved`, `found`, `removed`].includes(e.action)) {
        const cur = openLend.get(id); if (cur) { cur.returnedAt = e.ts; cur.how = e.action; openLend.delete(id); }
        if (e.action === `removed`) { const r = openRes.get(id); if (r) { r.cancelledAt = e.ts; openRes.delete(id); } }
      }
    }
    // current state without matching log entries (older data): show as open
    for (const it of this.activeItems()) {
      if (!it.lentTo) continue;
      const fake = { itemId: it.id, detail: it.lentTo };
      if (it.status === `lent` && !out.some((p) => p.itemId === it.id && p.lentAt && !p.returnedAt)) out.push(mk(fake, { lentAt: it.updatedAt || `` }));
      if (it.status === `reserved` && !out.some((p) => p.itemId === it.id && p.savedAt && !p.lentAt && !p.cancelledAt)) out.push(mk(fake, { savedAt: it.updatedAt || `` }));
    }
    return out;
  }

  /** Everyone you've lent to or saved things for: [{ key, name, holding, saved, lastAt, total }], most relevant first. */
  people() {
    const map = new Map();
    for (const p of this.lendPeriods()) {
      const e = map.get(p.key) || { key: p.key, name: p.name, holding: [], saved: [], lastAt: ``, total: 0 };
      if (p.lentAt) e.total++;
      const at = p.lentAt || p.savedAt || ``;
      if (String(at) >= String(e.lastAt)) { e.lastAt = at; e.name = p.name; } // latest spelling wins
      map.set(p.key, e);
    }
    for (const it of this.activeItems()) {
      if (!it.lentTo) continue;
      const e = map.get(Repo.personKey(it.lentTo)); if (!e) continue;
      if (it.status === `lent`) e.holding.push(it);
      if (it.status === `reserved`) e.saved.push(it);
    }
    const busy = (p) => p.holding.length + p.saved.length > 0;
    return [...map.values()].sort((a, b) => busy(b) - busy(a) || String(b.lastAt).localeCompare(String(a.lastAt)));
  }

  personHistory(key) {
    const name = (id) => this.items.find((i) => i.id === id)?.name || `Removed item`;
    return this.lendPeriods().filter((p) => p.key === key)
      .map((p) => ({ ...p, itemName: name(p.itemId), item: this.items.find((i) => i.id === p.itemId && !i.deleted) }))
      .sort((a, b) => String(b.lentAt || b.savedAt).localeCompare(String(a.lentAt || a.savedAt)));
  }

  // ---------------- demo seed
  seedDemo() {
    const L = (name, parentId, kind) => this.saveLocation({ name, parentId, kind });
    const home = L(`Home`, ``, `place`);
    const garage = L(`Garage`, home.id, `room`);
    const bin = L(`Blue bin – tools`, garage.id, `container`);
    const shelf = L(`Metal shelf`, garage.id, `container`);
    const kitchen = L(`Kitchen`, home.id, `room`);
    const drawer = L(`Junk drawer`, kitchen.id, `container`);
    const storage = L(`Storage unit`, ``, `place`);
    const bigBox = L(`Box 3 – holiday`, storage.id, `container`);
    const S = (name, purpose, category, tags, locationId, extra = {}) => this.saveItem({ name, purpose, category, tags, locationId, ...extra }, { logAction: `added` });
    S(`Plumber’s tape`, `Seal threads when fixing a leaky faucet or shower head`, `Tools`, `plumbing, leak, teflon`, bin.id);
    S(`Stud finder`, `Find wall studs before hanging TVs or shelves`, `Tools`, `wall, mounting, drilling`, bin.id);
    S(`Extension cord 25 ft`, `Outdoor lights, pressure washer`, `Electrical`, `outdoor, power`, shelf.id, { qty: 2 });
    S(`Car jump starter`, `Dead car battery`, `Car`, `battery, emergency`, shelf.id, { warranty: `2027-05-01` });
    S(`Spare house keys`, `Lockout backup, give to house sitter`, `Keys`, `keys, backup`, drawer.id);
    S(`Christmas lights (warm white)`, `Front porch and tree`, `Holiday`, `christmas, decor, lights`, bigBox.id, { qty: 4 })
      .then((it) => this.reserveItem(it, `Kumar`, new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)));
    S(`Pressure washer`, `Driveway and deck cleaning`, `Outdoor`, `cleaning, deck`, garage.id).then((pw) => this.lendItem(pw, `Ravi`));
    this.setStatus(`synced`);
  }
}
