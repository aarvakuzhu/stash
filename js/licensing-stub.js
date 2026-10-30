// In-browser stand-in for the licensing server (CONFIG.LICENSE_URL = `stub`). For building and testing the app
// before (or without) the real server. Implements the v1 contract using the server's own rules
// (licensing-rules.js, vendored from Urimam), on data kept in this browser only.
// Differences from the real server: people are keyed by the app's email hash (the server re-keys them with a
// secret), the identity token is `stub:<email>` instead of a Google token, and there are no rate limits.
// Test switches (More → Licensing test) change the mode, the free limit, the grace length, or force a state.
import { emailHash } from './licensing.js';
import {
  effectiveSettings, planFor, evaluate, messagesFor, claimsFor, nextCheckAt, applyAccessReport, applySources, addFlag, reportIsFresh,
} from './licensing-rules.js';

const KEY = `lic.stub`;
const KEYPAIR = `lic.stub.key`;

const FEATURES = { invite: true, viewOnlyMembers: false, multipleInventories: false, events: true, eventAssignments: false,
  eventDayOf: false, ownershipTransfer: false, auditExport: false, aiScan: true, hostedAi: false };
const APP = {
  id: `paran`, name: `Paran`, defaults: { mode: `observe`, freeMembers: 5, graceDays: 14, minAppVersion: null },
  plans: { free: { limits: { members: 5, inventories: 1, activeEvents: 1 }, features: FEATURES } },
};

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
const fresh = () => ({ tenants: {}, bindings: {}, memberships: {}, usage: [], debug: { mode: `observe`, cap: 5, graceDays: 14, force: `` } });
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, `+`).replace(/_/g, `/`)), (c) => c.charCodeAt(0)));
const problem = (status, code, detail = code, extra = {}) => ({ status, data: { type: `about:blank`, title: code, status, code, detail, ...extra } });

export async function createStub() {
  let db = load() || fresh();
  db = { ...fresh(), ...db, debug: { ...fresh().debug, ...(db.debug || {}) } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* ignore */ } };

  // signing key, generated once per browser
  let pair = null; let kid = ``;
  try {
    const saved = JSON.parse(localStorage.getItem(KEYPAIR) || `null`);
    if (saved) {
      pair = { privateKey: await crypto.subtle.importKey(`jwk`, saved.priv, { name: `ECDSA`, namedCurve: `P-256` }, false, [`sign`]), pub: saved.pub };
      kid = saved.pub.kid;
    }
  } catch { pair = null; }
  if (!pair) {
    const kp = await crypto.subtle.generateKey({ name: `ECDSA`, namedCurve: `P-256` }, true, [`sign`, `verify`]);
    const priv = await crypto.subtle.exportKey(`jwk`, kp.privateKey);
    const pubJwk = await crypto.subtle.exportKey(`jwk`, kp.publicKey);
    kid = `stub-${Date.now().toString(36)}`;
    const pub = { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y, kid, alg: `ES256`, use: `sig` };
    try { localStorage.setItem(KEYPAIR, JSON.stringify({ priv, pub })); } catch { /* ignore */ }
    pair = { privateKey: kp.privateKey, pub };
  }
  async function sign(claims) {
    const h = b64urlText(JSON.stringify({ alg: `ES256`, typ: `JWT`, kid }));
    const p = b64urlText(JSON.stringify(claims));
    const sig = await crypto.subtle.sign({ name: `ECDSA`, hash: `SHA-256` }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }

  const settings = () => effectiveSettings(APP, { mode: db.debug.mode, freeMembers: Number(db.debug.cap) || 5,
    graceDays: db.debug.graceDays === `` ? 14 : Number(db.debug.graceDays) });
  const memberships = (tid) => Object.values(db.memberships).filter((m) => m.tenantId === tid);

  function evalFor(t, who) {
    const ev = evaluate({ app: APP, tenant: t, memberships: memberships(t._id), settings: settings(), who, now: Date.now() });
    if (db.debug.force) { // test switch: pretend the group is in this state
      ev.state = db.debug.force;
      ev.kept = ev.isOwner || ev.state === `ok` || ev.state === `grace` || (t.keepers || []).includes(who);
      ev.blocked = !ev.isOwner && ((ev.state === `restricted` && !ev.kept) || ev.state === `locked`);
    }
    return ev;
  }

  async function entitlementFor(t, who) {
    const before = t.graceStart || null;
    let ev = evalFor(t, who);
    if (before !== ev.graceStart) { t.graceStart = ev.graceStart; ev = evalFor(t, who); }
    const claims = claimsFor({ issuer: `stub`, appId: `paran`, tenant: t, ev });
    save();
    return { ev, body: { entitlement: claims, token: await sign(claims), messages: messagesFor(ev, `Paran`), nextCheckAt: nextCheckAt(ev), minAppVersion: null, tenantId: t._id } };
  }

  /** Session token: s1.stub.<base64url {email, iid}>. */
  async function who(headers) {
    const m = /^Bearer s1\.stub\.([A-Za-z0-9_-]+)$/.exec(headers.Authorization || ``);
    if (!m) return null;
    try {
      const p = JSON.parse(fromB64url(m[1]));
      return p.iid === headers[`X-Install-Id`] ? emailHash(p.email) : null;
    } catch { return null; }
  }

  async function handle(method, path, headers, body) {
    const route = `${method} ${path}`;
    if (route === `GET /keys`) return { status: 200, data: { keys: [pair.pub] } };
    if (route === `POST /auth`) {
      const m = /^stub:(.+@.+)$/.exec(body?.identityToken || ``);
      if (!m) return problem(401, `auth_invalid`, `The stub expects identity token "stub:<email>"`);
      return { status: 200, data: { token: `s1.stub.${b64urlText(JSON.stringify({ email: m[1], iid: headers[`X-Install-Id`] }))}`, expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString() } };
    }
    if (route === `POST /usage`) {
      db.usage = [...db.usage, { at: new Date().toISOString(), install: headers[`X-Install-Id`], batch: body }].slice(-50); save();
      return { status: 202, data: null };
    }
    const me = await who(headers);
    if (!me) return problem(401, `auth_invalid`, `Missing or invalid session`);
    if (route === `DELETE /me`) {
      for (const [k, m] of Object.entries(db.memberships)) if (m.personHash === me) delete db.memberships[k];
      for (const t of Object.values(db.tenants)) t.keepers = (t.keepers || []).filter((h) => h !== me);
      save(); return { status: 202, data: null };
    }
    if (route === `POST /session`) {
      const b = db.bindings[body.inventoryId];
      const canonical = b ? b.tenantId : body.tenantId;
      const t = db.tenants[canonical];
      if (!t) return problem(404, `tenant_unknown`);
      applySources(t, body.tenantIdSources, Date.now());
      if (b && body.tenantId !== canonical) addFlag(t, `session_wrong_id`);
      if (me !== t.ownerHash && reportIsFresh(t, Date.now()) && !(t.access.hashes || []).includes(me)) addFlag(t, `session_not_in_report`);
      const key = `${t._id}|${me}`;
      db.memberships[key] = { ...(db.memberships[key] || { tenantId: t._id, personHash: me }), lastOpenedAt: new Date().toISOString(), role: body.role };
      const { ev, body: out } = await entitlementFor(t, me);
      const deny = ev.mode === `enforce` && ev.blocked;
      return { status: 200, data: { ...out, decision: deny ? `deny` : `allow`, reason: deny ? (ev.state === `locked` ? `locked` : `not_kept`) : null } };
    }
    const m = /^(PUT|POST) \/tenants\/([^/]+)(?:\/(access|members|keepers|checkout))?$/.exec(route);
    if (!m) return problem(400, `bad_request`, `No such route in the stub: ${route}`);
    const [, , tenantId, sub] = m;
    let t = db.tenants[tenantId];
    if (!sub) {
      if (t && t.ownerHash !== me) return problem(409, `tenant_owned_elsewhere`, `This group id belongs to another owner`, { copiedFrom: tenantId });
      for (const inv of body.inventories) {
        const bnd = db.bindings[inv.inventoryId];
        if (bnd && bnd.tenantId !== tenantId) {
          return bnd.ownerHash === me ? problem(409, `inventory_bound`, `This sheet already belongs to another of your groups`, { tenantId: bnd.tenantId })
            : problem(409, `inventory_owned_elsewhere`, `This sheet belongs to someone else's group`);
        }
      }
      t = db.tenants[tenantId] ||= { _id: tenantId, appId: `paran`, ownerHash: me, createdAt: body.createdAt, plan: `free`, keepers: [], flags: [],
        graceStart: null, tamper: null, access: null, inventories: [], copiedFrom: headers[`X-Copied-From`] || null };
      for (const inv of body.inventories) {
        db.bindings[inv.inventoryId] ||= { tenantId, ownerHash: me };
        if (!t.inventories.some((i) => i.inventoryId === inv.inventoryId)) t.inventories.push(inv);
      }
      const key = `${tenantId}|${me}`;
      db.memberships[key] = { ...(db.memberships[key] || { tenantId, personHash: me }), lastOpenedAt: new Date().toISOString(), role: `owner` };
      return { status: 200, data: (await entitlementFor(t, me)).body };
    }
    if (!t) return problem(404, `tenant_unknown`);
    if (t.ownerHash !== me) return problem(403, `not_owner`);
    if (sub === `access`) {
      const { removed, present } = applyAccessReport({ app: APP, tenant: t, memberships: memberships(t._id), settings: settings(), report: body, now: Date.now() });
      for (const h of removed) { const k = `${t._id}|${h}`; if (db.memberships[k]) db.memberships[k].removedAt = new Date().toISOString(); }
      for (const h of present) { const k = `${t._id}|${h}`; if (db.memberships[k]) delete db.memberships[k].removedAt; }
      return { status: 200, data: (await entitlementFor(t, me)).body };
    }
    if (sub === `members`) {
      const ev = evalFor(t, t.ownerHash);
      const asked = new Set(body.emailHashes);
      return { status: 200, data: {
        members: [...asked].map((h) => ({ emailHash: h, lastOpenedAt: db.memberships[`${t._id}|${h}`]?.lastOpenedAt || null, seat: ev.seatHolders.has(h),
          kept: h === t.ownerHash || ev.state === `ok` || ev.state === `grace` || (t.keepers || []).includes(h) })),
        others: [...ev.seatHolders].filter((h) => !asked.has(h)).length,
      } };
    }
    if (sub === `keepers`) {
      const keep = [...new Set(body.keep || [])].filter((h) => h !== t.ownerHash);
      const cap = planFor(APP, t, settings()).limits.members;
      if (cap != null && keep.length + 1 > cap) return problem(422, `too_many_keepers`, `You can keep up to ${cap - 1} people besides yourself.`);
      t.keepers = keep;
      return { status: 200, data: (await entitlementFor(t, me)).body };
    }
    if (sub === `checkout`) return problem(501, `not_implemented`, `Payments aren’t set up yet.`);
    return problem(400, `bad_request`);
  }

  return {
    handle,
    publicKeys: async () => [pair.pub],
    debug: () => ({ ...db.debug }),
    setDebug(patch) { db.debug = { ...db.debug, ...patch }; save(); },
    lastUsage: () => db.usage[db.usage.length - 1] || null,
    tenant: (id) => db.tenants[id] || null,
    binding: (inventoryId) => db.bindings[inventoryId] || null,
    reset() { db = fresh(); save(); },
  };
}
