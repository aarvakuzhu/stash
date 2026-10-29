// In-browser stand-in for the licensing server (CONFIG.LICENSE_URL = `stub`). For building and testing the app
// before the real server exists. Implements the v1 contract and the phase rules on data from this browser only:
// it knows people through the owner's Drive access report and through sessions opened here.
// Debug switches (More → Licensing test) change the mode, the free cap, the grace length, or force a state.
import { emailHash } from './licensing.js';

const KEY = `lic.stub`;
const KEYPAIR = `lic.stub.key`;
const DAY = 86400_000;

const FREE = {
  limits: { members: 5, inventories: 1, activeEvents: 1 },
  features: { invite: true, viewOnlyMembers: false, multipleInventories: false, events: true, eventAssignments: false,
    eventDayOf: false, ownershipTransfer: false, auditExport: false, aiScan: true, hostedAi: false },
};

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
const fresh = () => ({ tenants: {}, usage: [], debug: { mode: `observe`, cap: 5, graceDays: 14, force: `` } });
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
const problem = (status, code, detail = code) => ({ status, data: { type: `about:blank`, title: code, status, code, detail } });

export async function createStub() {
  let db = load() || fresh();
  db.debug = { ...fresh().debug, ...(db.debug || {}) };
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

  /** The phase rules (licensing-phases.md, Phase 2) for one person looking at one tenant. */
  function evaluate(t, who) {
    const d = db.debug;
    const seatSet = new Set([...(t.access?.hashes || []), ...Object.keys(t.sessions || {})]);
    const used = seatSet.size;
    const cap = Number(d.cap) || FREE.limits.members;
    const unknowable = Boolean(t.access?.unknowable);
    const over = unknowable || used > cap;
    const now = Date.now();
    if (over && !t.graceStart) t.graceStart = new Date(now).toISOString();
    if (!over) t.graceStart = null;
    const graceEnds = t.graceStart ? Date.parse(t.graceStart) + (Number.isFinite(Number(d.graceDays)) && d.graceDays !== `` ? Number(d.graceDays) : 14) * DAY : null;
    let state = !over ? `ok` : now < graceEnds ? `grace` : `restricted`;
    if (t.tamper) state = `locked`;
    if (d.force) state = d.force;
    const isOwner = who === t.owner;
    const keepers = t.keepers || [];
    const kept = isOwner || state === `ok` || state === `grace` || keepers.includes(who);
    const blocked = !isOwner && ((state === `restricted` && !kept) || state === `locked`);
    return {
      state, isOwner, kept, blocked, used, cap, unknowable,
      graceEndsAt: graceEnds && state !== `ok` ? new Date(graceEnds).toISOString() : null,
    };
  }

  function messagesFor(ev) {
    const date = ev.graceEndsAt ? new Date(ev.graceEndsAt).toLocaleDateString(undefined, { day: `numeric`, month: `short` }) : ``;
    const m = [];
    if (ev.state === `grace`) {
      m.push({ id: `grace_owner`, severity: `warning`, audience: `owner`, dismissible: false,
        text: ev.unknowable ? `Link sharing is on, so this group can’t be counted. Turn it off or upgrade by ${date}.`
          : `Your group has ${ev.used} people; the free plan includes ${ev.cap}. Remove people or upgrade by ${date}.`,
        action: ev.unknowable ? `turn_off_link_sharing` : `open_people` });
      m.push({ id: `grace_member`, severity: `info`, audience: `all`, dismissible: true,
        text: `This group is over its free limit. The owner has until ${date} to sort it out.`, action: null });
    }
    if (ev.state === `restricted`) {
      m.push({ id: `restricted_owner`, severity: `critical`, audience: `owner`, dismissible: false,
        text: `Sharing is off: your group is over the free limit. Choose who keeps access, remove people, or upgrade.`, action: `open_people` });
    }
    if (ev.state === `locked`) {
      m.push({ id: `locked_owner`, severity: `critical`, audience: `owner`, dismissible: false,
        text: `Some features are off because this group’s sharing doesn’t match its records. Remove extra people in Google Drive to restore it.`, action: `open_people` });
    }
    return m;
  }

  async function entitlementFor(tenantId, who) {
    const t = db.tenants[tenantId];
    const ev = evaluate(t, who);
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: `stub`, aud: `paran`, sub: tenantId, iat, exp: iat + 86400, mode: db.debug.mode,
      plan: `free`, state: ev.state, graceEndsAt: ev.graceEndsAt,
      seats: { used: ev.used, cap: ev.cap, unknowable: ev.unknowable },
      limits: { ...FREE.limits, members: ev.cap }, features: { ...FREE.features },
      you: { isOwner: ev.isOwner, kept: ev.kept, blocked: ev.blocked }, overrides: [],
    };
    save();
    return {
      entitlement: claims, token: await sign(claims), messages: messagesFor(ev),
      nextCheckAt: new Date(Date.now() + (ev.state === `ok` ? 6 * 3600_000 : 3600_000)).toISOString(), minAppVersion: null,
      _ev: ev,
    };
  }

  async function handle(method, path, headers, body, identity) {
    const route = `${method} ${path}`;
    if (route === `GET /keys`) return { status: 200, data: { keys: [pair.pub] } };
    if (route === `POST /usage`) {
      db.usage = [...db.usage, { at: new Date().toISOString(), install: headers[`X-Install-Id`], batch: body }].slice(-50); save();
      return { status: 202, data: null };
    }
    if (!headers.Authorization || !identity?.email) return problem(401, `auth_invalid`);
    const who = await emailHash(identity.email);
    if (route === `DELETE /me`) {
      for (const t of Object.values(db.tenants)) { delete t.sessions?.[who]; t.keepers = (t.keepers || []).filter((h) => h !== who); }
      save(); return { status: 202, data: null };
    }
    if (route === `POST /session`) {
      const t = db.tenants[body.tenantId];
      if (!t) return problem(404, `tenant_unknown`);
      const s = body.tenantIdSources || {};
      t.flags = t.flags || [];
      if (s.appProperties && s.metaTab && s.appProperties !== s.metaTab) t.tamper = `ids_disagree`;
      else if (t.tamper === `ids_disagree`) t.tamper = null;
      else if (!s.appProperties || !s.metaTab) t.flags.push({ at: new Date().toISOString(), what: `id_missing`, who });
      t.sessions = { ...(t.sessions || {}), [who]: { lastOpenedAt: new Date().toISOString(), role: body.role } };
      const r = await entitlementFor(body.tenantId, who);
      const deny = db.debug.mode === `enforce` && r._ev.blocked;
      delete r._ev;
      return { status: 200, data: { ...r, decision: deny ? `deny` : `allow`, reason: deny ? (r.entitlement.state === `locked` ? `locked` : `not_kept`) : null } };
    }
    const m = /^(PUT|POST|GET) \/tenants\/([^/]+)(?:\/(access|members|keepers|checkout))?$/.exec(route);
    if (!m) return problem(400, `bad_request`, `No such route in the stub: ${route}`);
    const [, , tenantId, sub] = m;
    let t = db.tenants[tenantId];
    if (!sub) {
      if (t && t.owner !== who) return { status: 409, data: { ...problem(409, `tenant_owned_elsewhere`).data, copiedFrom: tenantId } };
      t = db.tenants[tenantId] = { ...(t || { owner: who, createdAt: body.createdAt, sessions: {}, keepers: [] }), inventories: body.inventories,
        copiedFrom: headers[`X-Copied-From`] || t?.copiedFrom || null };
      const r = await entitlementFor(tenantId, who); delete r._ev;
      return { status: 200, data: r };
    }
    if (!t) return problem(404, `tenant_unknown`);
    if (t.owner !== who) return problem(403, `not_owner`);
    if (sub === `access`) {
      const hashes = new Set(); let unknowable = false;
      for (const f of body.files || []) {
        if (f.general !== `restricted`) unknowable = true;
        for (const p of f.people || []) { if (p.type === `group`) unknowable = true; else hashes.add(p.emailHash); }
      }
      const tab = new Set(body.membersTab || []);
      const notOnMembersTab = [...hashes].filter((h) => h !== t.owner && !tab.has(h)).length; // recorded only: same as a Drive-direct share
      const cap = Number(db.debug.cap) || FREE.limits.members;
      const before = t.access?.count ?? null;
      const prevState = evaluate(t, who).state;
      t.access = { at: body.reportedAt, hashes: [...hashes], unknowable, notOnMembersTab, count: hashes.size };
      // sharing more people outside Paran after the group was Restricted → tamper → Locked
      if (prevState === `restricted` && before != null && hashes.size > before) t.tamper = `reshared_after_restricted`;
      if (t.tamper === `reshared_after_restricted` && hashes.size <= cap && !unknowable) t.tamper = null;
      for (const h of Object.keys(t.sessions || {})) if (!hashes.has(h) && h !== t.owner) delete t.sessions[h]; // access removed → seat freed
      const r = await entitlementFor(tenantId, who); delete r._ev;
      return { status: 200, data: r };
    }
    if (sub === `members`) {
      const all = new Set([...(t.access?.hashes || []), ...Object.keys(t.sessions || {})]);
      const ev = evaluate(t, who);
      return { status: 200, data: { members: [...all].map((h) => ({ emailHash: h, lastOpenedAt: t.sessions?.[h]?.lastOpenedAt || null,
        kept: h === t.owner || ev.state === `ok` || ev.state === `grace` || (t.keepers || []).includes(h) })) } };
    }
    if (sub === `keepers`) {
      const keep = [...new Set(body.keep || [])].filter((h) => h !== t.owner);
      const cap = Number(db.debug.cap) || 5;
      if (keep.length + 1 > cap) return problem(422, `too_many_keepers`, `You can keep up to ${cap - 1} people besides yourself.`);
      t.keepers = keep;
      const r = await entitlementFor(tenantId, who); delete r._ev;
      return { status: 200, data: r };
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
    reset() { db = fresh(); save(); },
  };
}
