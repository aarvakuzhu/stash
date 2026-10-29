// Licensing client: usage counts, the group's plan and seats, and what the app may do.
// Contract: Licensing project, licensing-interface.md (v1). Everything here is off unless CONFIG.LICENSE_URL is set
// (`stub` runs an in-browser fake server for testing).
//
// Rules this file follows:
// - Never block the app on licensing. Calls run in the background; a failure changes nothing.
// - Fail open: a group the server has never answered for is allowed everything. Once answered, the last verified
//   state stays in force until a newer one arrives (it never decays to "ok" on its own).
// - In `observe` mode nothing is applied; the app only records what it would have shown.
// - Never sent: item names, purposes, notes, tags, photos, place names, emails (people are sent as hashes).
import { CONFIG } from './config.js';
import { currentToken } from './google.js';
import { blobs } from './idb.js';

const LS = `lic.`;
const APP = CONFIG.LICENSE_APP_ID || `paran`;
const TIMEOUT_MS = 5000;
const FLUSH_EVERY_MS = 6 * 3600_000;
const ACCESS_EVERY_MS = 6 * 3600_000;
const KEYS_EVERY_MS = 7 * 86400_000;
const MAX_BATCHES = 40;          // ≈ 30 days of unsent batches, then the oldest are dropped
const BATCH_MAX_AGE_MS = 30 * 86400_000;

const read = (k, d = null) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const drop = (k) => { try { localStorage.removeItem(LS + k); } catch { /* ignore */ } };
const nowIso = () => new Date().toISOString();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : `10000000-1000-4000-8000-100000000000`.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, `0`)}-${String(d.getDate()).padStart(2, `0`)}`;

export class LicError extends Error {
  constructor(code, status = 0, data = null) { super(data?.detail || code); this.code = code; this.status = status; this.data = data; }
}

// ------------------------------------------------------------------ small pure helpers (exported for tests)

/** "lic1:" + lowercased email, googlemail.com → gmail.com, hex SHA-256. Same on client and server. */
export async function emailHash(email) {
  let e = String(email || ``).trim().toLowerCase();
  if (e.endsWith(`@googlemail.com`)) e = `${e.slice(0, -`@googlemail.com`.length)}@gmail.com`;
  const buf = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(`lic1:${e}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, `0`)).join(``);
}

export const b64urlToBytes = (s) => {
  const b = atob(s.replace(/-/g, `+`).replace(/_/g, `/`) + `===`.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Verify a compact ES256 JWS against a list of public JWKs. Returns the payload object, or null. */
export async function verifyJws(token, jwks) {
  try {
    const [h, p, s] = String(token).split(`.`);
    if (!h || !p || !s) return null;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    if (header.alg !== `ES256`) return null;
    const jwk = jwks.find((k) => k.kid === header.kid) || (jwks.length === 1 && !header.kid ? jwks[0] : null);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(`jwk`, { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: `ECDSA`, namedCurve: `P-256` }, false, [`verify`]);
    const ok = await crypto.subtle.verify({ name: `ECDSA`, hash: `SHA-256` }, key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) : null;
  } catch { return null; }
}

/** `stash-v32` → 32; anything else → NaN. */
export const versionNumber = (v) => Number(/(\d+)\s*$/.exec(String(v || ``))?.[1] ?? NaN);

export function platform() {
  const ua = navigator.userAgent || ``;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return `ios`;
  if (/Android/.test(ua)) return `android`;
  if (/Windows|Macintosh|Linux|CrOS/.test(ua)) return `desktop`;
  return `other`;
}

/** What the app should do with a stored session answer. Pure: used by the app and by tests. */
export function viewOf(stored, { debugMode = null } = {}) {
  if (!stored?.claims) {
    return { has: false, enforced: false, mode: null, plan: null, state: `ok`, graceEndsAt: null, decision: `allow`, reason: null,
      seats: { used: 0, cap: null, unknowable: false }, limits: {}, features: {}, messages: [], wouldShow: null,
      you: { isOwner: false, kept: true, blocked: false } };
  }
  const c = stored.claims;
  const mode = debugMode || c.mode;
  const enforced = mode === `enforce`;
  return {
    has: true, enforced, mode, plan: c.plan, state: c.state, graceEndsAt: c.graceEndsAt || null,
    seats: c.seats || { used: 0, cap: null, unknowable: false }, limits: c.limits || {}, features: c.features || {},
    you: c.you || { isOwner: false, kept: true, blocked: false },
    decision: stored.decision || `allow`, reason: stored.reason || null,
    messages: enforced ? (stored.messages || []) : [],
    wouldShow: c.state !== `ok` ? c.state : null,
  };
}

// ------------------------------------------------------------------ the client
class Licensing extends EventTarget {
  stub = null;
  keys = [];
  version = `dev`;
  ctxFn = () => null;
  gaugeFn = () => null;
  busy = null;
  lastTick = 0;
  install = null;

  on() { return Boolean(CONFIG.LICENSE_URL); }
  isStub() { return CONFIG.LICENSE_URL === `stub`; }

  /** Call once at boot. Safe when licensing is off (does nothing). */
  async init() {
    if (!this.on()) return;
    this.install = await this.ensureInstall();
    this.version = await appVersion();
    this.keys = [...(CONFIG.LICENSE_KEYS || []), ...(read(`keys`)?.keys || [])];
    if (this.isStub()) {
      const { createStub } = await import(`./licensing-stub.js`);
      this.stub = await createStub();
      this.keys = [...this.keys, ...(await this.stub.publicKeys())];
    }
    this.count(`app.open`);
    document.addEventListener(`visibilitychange`, () => {
      if (document.hidden) this.flushUsage({ keepalive: true }).catch(() => {});
      else this.tick();
    });
    window.addEventListener(`online`, () => this.tick());
  }

  /** installId kept in IndexedDB and localStorage; restored from whichever survives. */
  async ensureInstall() {
    let rec = read(`install`);
    if (!rec?.id) rec = await blobs.get(`lic.install`).catch(() => null);
    if (!rec?.id) rec = { id: uuid(), firstOpenAt: nowIso() };
    write(`install`, rec);
    blobs.put(`lic.install`, rec).catch(() => {});
    return rec;
  }

  /** fn() → { tenantId, inventoryId, isOwner, role, sources, email, inventories, demo } or null. Read lazily on every tick. */
  setContext(fn) { this.ctxFn = fn; this.emit(); }
  /** fn() → { items, places, inventories, activeEvents, aiEnabled } for the current tenant. */
  setGauges(fn) { this.gaugeFn = fn; }
  ctx() { try { return this.ctxFn() || null; } catch { return null; } }
  emit() { this.dispatchEvent(new Event(`change`)); }

  // ---------------- privacy notice. Licence checks and usage counts are part of using the app (shown once, not optional);
  // AI feedback counters (`ai.fb.*`) are optional and off until the person turns them on.
  consent() { return read(`consent`); }
  noticeSeen() { return Boolean(this.consent()?.at); }
  markNoticeSeen() { if (!this.noticeSeen()) { write(`consent`, { at: nowIso(), feedback: false }); this.emit(); this.flushUsage().catch(() => {}); } }
  needsNotice() { return this.on() && !this.noticeSeen(); }
  feedbackAllowed() { return this.consent()?.feedback === true; }
  setFeedback(on) { write(`consent`, { at: this.consent()?.at || nowIso(), feedback: Boolean(on) }); this.emit(); }

  // ---------------- counters and gauges (aggregated on the device per local day per tenant)
  count(name, n = 1) {
    if (!this.on()) return;
    if (name.startsWith(`ai.fb.`) && !this.feedbackAllowed()) return; // optional AI feedback
    if (!(n > 0)) return;
    const tenantId = this.ctx()?.tenantId || null;
    const date = localDate();
    const days = read(`days`, {});
    const k = `${date}|${tenantId || ``}`;
    const d = days[k] || (days[k] = { date, tenantId, counters: {} });
    d.counters[name] = (d.counters[name] || 0) + n;
    write(`days`, days);
  }

  /** Close today's counters into a batch and send everything waiting. */
  async flushUsage({ keepalive = false, force = false } = {}) {
    if (!this.on() || !this.install) return;
    if (!this.noticeSeen()) return; // nothing leaves the device before the privacy notice has been shown
    const last = read(`lastFlush`, 0);
    if (!force && !keepalive && Date.now() - last < FLUSH_EVERY_MS) return;
    this.packBatch();
    let batches = read(`batches`, []).filter((b) => Date.now() - Date.parse(b.sentAt) < BATCH_MAX_AGE_MS);
    for (const b of [...batches]) {
      try {
        await this.call(`POST`, `/usage`, b, { auth: `optional`, keepalive });
        batches = batches.filter((x) => x.batchId !== b.batchId);
        write(`batches`, batches);
      } catch (e) { if (e.code !== `network`) { batches = batches.filter((x) => x.batchId !== b.batchId); write(`batches`, batches); } break; }
    }
    write(`lastFlush`, Date.now());
  }

  packBatch() {
    const days = read(`days`, {});
    const ctx = this.ctx();
    let gauges = null;
    try { gauges = ctx?.tenantId ? this.gaugeFn() : null; } catch { gauges = null; }
    if (!Object.keys(days).length && !gauges) return;
    const batch = {
      batchId: uuid(), sentAt: nowIso(),
      install: { firstOpenAt: this.install.firstOpenAt, standalone: isStandalone(), locale: navigator.language || ``, demo: Boolean(ctx?.demo) },
      days: Object.values(days),
      snapshots: gauges && ctx?.tenantId ? [{ tenantId: ctx.tenantId, at: nowIso(), gauges }] : [],
    };
    const batches = [...read(`batches`, []), batch].slice(-MAX_BATCHES);
    write(`batches`, batches); write(`days`, {});
  }

  // ---------------- the main loop: register → session → access report → usage
  /** Runs at most every 15 s (unless forced); safe to call often. */
  tick(force = false) {
    if (!this.on() || !this.install) return Promise.resolve();
    if (this.busy) return this.busy;
    const ctx = this.ctx();
    const unanswered = Boolean(ctx?.tenantId && !ctx.demo && !this.stored(ctx.tenantId)); // e.g. the group id was only just read: don't wait 15 s
    if (!force && !unanswered && Date.now() - this.lastTick < 15_000) return Promise.resolve();
    this.lastTick = Date.now();
    this.busy = this.run(force).catch((e) => { if (e.code !== `no_token` && e.code !== `network`) console.warn(`licensing`, e); })
      .finally(() => { this.busy = null; });
    return this.busy;
  }

  async run(force) {
    if (!navigator.onLine) return;
    await this.refreshKeys();
    const ctx = this.ctx();
    if (ctx?.tenantId && !ctx.demo && currentToken()) {
      if (ctx.isOwner) await this.register(ctx, { force });
      const st = this.stored(ctx.tenantId);
      if (force || !st || Date.now() >= Date.parse(st.nextCheckAt || 0)) await this.session(ctx);
      if (ctx.isOwner && (force || read(`accessDirty.${ctx.tenantId}`) || Date.now() - read(`accessAt.${ctx.tenantId}`, 0) > ACCESS_EVERY_MS)) {
        await this.reportAccess(ctx);
      }
    }
    await this.flushUsage();
  }

  async refreshKeys() {
    if (this.isStub()) return; // the stub's key is added at init
    const k = read(`keys`);
    if (k && Date.now() - k.at < KEYS_EVERY_MS) return;
    try {
      const r = await this.call(`GET`, `/keys`, null, { auth: false });
      if (Array.isArray(r?.keys)) { write(`keys`, { at: Date.now(), keys: r.keys }); this.keys = [...(CONFIG.LICENSE_KEYS || []), ...r.keys]; }
    } catch { /* bundled keys still work */ }
  }

  /** PUT /tenants/{id}: full inventory list; resent when it changes. Handles a copied sheet by rekeying. */
  async register(ctx, { force = false } = {}) {
    const body = { createdAt: ctx.createdAt || nowIso(), inventories: ctx.inventories };
    const sig = JSON.stringify(body.inventories.map((i) => [i.inventoryId, i.photoFolderId || ``]));
    if (!force && read(`reg.${ctx.tenantId}`) === sig) return;
    try {
      const r = await this.call(`PUT`, `/tenants/${ctx.tenantId}`, body, { headers: ctx.copiedFrom ? { 'X-Copied-From': ctx.copiedFrom } : {} });
      write(`reg.${ctx.tenantId}`, sig);
      await this.accept(ctx.tenantId, r);
    } catch (e) {
      if (e.code === `tenant_owned_elsewhere` && ctx.rekey) {
        const next = await ctx.rekey(); // the app mints a new id and writes it to the sheet; the old one is kept as copiedFrom
        if (next) return this.register({ ...ctx, ...next }, { force: true });
      }
      throw e;
    }
  }

  async session(ctx) {
    const body = { tenantId: ctx.tenantId, inventoryId: ctx.inventoryId, role: ctx.role, tenantIdSources: ctx.sources };
    try {
      const r = await this.call(`POST`, `/session`, body);
      await this.accept(ctx.tenantId, r, { session: true });
    } catch (e) {
      if (e.code === `tenant_unknown` && ctx.isOwner) { drop(`reg.${ctx.tenantId}`); await this.register(ctx, { force: true }); return; }
      throw e;
    }
  }

  async reportAccess(ctx) {
    if (!ctx.collectAccess) return;
    const raw = await ctx.collectAccess(); // { files: [{ fileId, kind, inventoryId, general, people: [{ email, role, type }] }], membersTab: [emails] }
    const files = await Promise.all(raw.files.map(async (f) => ({
      fileId: f.fileId, kind: f.kind, inventoryId: f.inventoryId ?? null, general: f.general,
      people: await Promise.all(f.people.filter((p) => p.email).map(async (p) => ({ emailHash: await emailHash(p.email), role: p.role, type: p.type }))),
    })));
    const membersTab = await Promise.all((raw.membersTab || []).filter(Boolean).map(emailHash));
    const r = await this.call(`POST`, `/tenants/${ctx.tenantId}/access`, { reportedAt: nowIso(), files, membersTab: [...new Set(membersTab)] });
    write(`accessAt.${ctx.tenantId}`, Date.now()); drop(`accessDirty.${ctx.tenantId}`);
    await this.accept(ctx.tenantId, r);
  }

  markAccessDirty() { const t = this.ctx()?.tenantId; if (t) write(`accessDirty.${t}`, 1); }

  /** Owner: last-opened and kept status per person, keyed by email hash. */
  async members() {
    const ctx = this.ctx(); if (!ctx?.tenantId || !ctx.isOwner) return [];
    const r = await this.call(`GET`, `/tenants/${ctx.tenantId}/members`);
    return r?.members || [];
  }

  async setKeepers(hashes) {
    const ctx = this.ctx(); if (!ctx?.tenantId) throw new LicError(`no_tenant`);
    const r = await this.call(`PUT`, `/tenants/${ctx.tenantId}/keepers`, { keep: hashes });
    await this.accept(ctx.tenantId, r);
  }

  async checkout(plan, interval = `month`) {
    const ctx = this.ctx(); if (!ctx?.tenantId) throw new LicError(`no_tenant`);
    return this.call(`POST`, `/tenants/${ctx.tenantId}/checkout`, { plan, interval });
  }

  async deleteMe() { return this.call(`DELETE`, `/me`, null); }

  /** Keep a response only if its signed token verifies; the token's claims are what the app uses. */
  async accept(tenantId, r, { session = false } = {}) {
    if (!r?.token) return;
    const claims = await verifyJws(r.token, this.keys);
    if (!claims || claims.aud !== APP || claims.sub !== tenantId) { console.warn(`licensing: entitlement did not verify`); return; }
    const prev = this.stored(tenantId) || {};
    const next = {
      claims, messages: r.messages || [], nextCheckAt: r.nextCheckAt || new Date(Date.now() + 6 * 3600_000).toISOString(),
      decision: session ? (r.decision || `allow`) : (prev.decision || `allow`),
      reason: session ? (r.reason || null) : (prev.reason || null),
      receivedAt: nowIso(),
    };
    write(`ent.${tenantId}`, next);
    if (r.minAppVersion && versionNumber(r.minAppVersion) > versionNumber(this.version)) this.dispatchEvent(new Event(`update-required`));
    const v = viewOf(next);
    if (!v.enforced && v.wouldShow) this.count(`lic.wouldShow.${v.wouldShow}`);
    this.emit();
  }

  stored(tenantId) { return tenantId ? read(`ent.${tenantId}`) : null; }

  /** Current answer for the open inventory (fail-open defaults when there is none). */
  view() {
    const ctx = this.ctx();
    if (!this.on() || !ctx?.tenantId || ctx.demo) return viewOf(null);
    return viewOf(this.stored(ctx.tenantId));
  }

  /** Is this person blocked from the open group right now? The owner never is. */
  blocked() {
    const v = this.view();
    if (!v.enforced || v.you.isOwner || this.ctx()?.isOwner) return false;
    return v.decision === `deny` || v.you.blocked;
  }

  allows(feature) {
    const v = this.view();
    if (!v.enforced) return true;
    if (v.state === `locked` && [`invite`, `events`, `multipleInventories`, `aiScan`].includes(feature)) return false;
    return v.features[feature] !== false;
  }

  /**
   * Can the owner invite one more person? Pure (no counting): { ok, why, enforced }, why = full | plan | restricted | locked.
   * In observe mode ok is always true and `why` says what would have been shown.
   */
  inviteCheck() {
    const v = this.view();
    const why = v.state === `locked` ? `locked` : v.state === `restricted` ? `restricted`
      : v.features.invite === false ? `plan` : (v.seats.unknowable || (v.seats.cap != null && v.seats.used >= v.seats.cap)) ? `full` : null;
    return { ok: !why || !v.enforced, why, enforced: v.enforced };
  }

  // ---------------- transport
  async call(method, path, body, { auth = true, keepalive = false, headers = {} } = {}) {
    const ctx = this.ctx();
    const token = currentToken();
    if (auth === true && !token) throw new LicError(`no_token`);
    const h = {
      'X-App-Id': APP, 'X-Install-Id': this.install.id, 'X-App-Version': this.version, 'X-Platform': platform(), ...headers,
      ...(body ? { 'Content-Type': `application/json` } : {}),
      ...(token && auth !== false ? { Authorization: `Bearer ${token}` } : {}),
    };
    if (this.stub) {
      const res = await this.stub.handle(method, path, h, body ? JSON.parse(JSON.stringify(body)) : null, { email: ctx?.email || null });
      if (res.status >= 400) throw new LicError(res.data?.code || `http_${res.status}`, res.status, res.data);
      return res.data;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${CONFIG.LICENSE_URL.replace(/\/$/, ``)}${path}`, {
        method, headers: h, body: body ? JSON.stringify(body) : undefined, keepalive, signal: ctl.signal, credentials: `omit`,
      });
    } catch { throw new LicError(`network`); }
    finally { clearTimeout(timer); }
    let data = null;
    try { data = res.status === 204 ? null : await res.json(); } catch { data = null; }
    if (!res.ok) throw new LicError(data?.code || (res.status >= 500 ? `network` : `http_${res.status}`), res.status, data);
    return data;
  }
}

function isStandalone() {
  try { return window.matchMedia(`(display-mode: standalone)`).matches || navigator.standalone === true; } catch { return false; }
}

/** The service worker's cache name is the app version (one cache is kept), so no second copy of VERSION is needed. */
async function appVersion() {
  try { const k = (await caches.keys()).find((n) => /^stash-v\d+$/.test(n)); return k || `dev`; } catch { return `dev`; }
}

export const lic = new Licensing();
