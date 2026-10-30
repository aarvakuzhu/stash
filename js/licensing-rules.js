// VENDORED from Urimam (github.com/aarvakuzhu/urimam) src/rules.js @ d15666b — used only by the in-browser test stub
// (licensing-stub.js) so it applies exactly the server's rules. Keep in sync: copy the file, don't edit it here.

// The phase rules (Licensing project, licensing-phases.md), as pure functions so every route and every test uses
// exactly the same logic. No I/O here.

const DAY = 86400_000;

/** Settings for one app: database values over registry defaults. */
export function effectiveSettings(app, stored = {}) {
  return { ...app.defaults, ...Object.fromEntries(Object.entries(stored || {}).filter(([, v]) => v !== undefined)) };
}

/** Plan definition for a tenant; the free plan's member limit follows the app setting (decided at end of pilot). */
export function planFor(app, tenant, settings) {
  const name = app.plans[tenant.plan] ? tenant.plan : `free`;
  const def = app.plans[name];
  const limits = { ...def.limits };
  if (name === `free` && settings.freeMembers != null) limits.members = Number(settings.freeMembers);
  return { name, limits, features: { ...def.features } };
}

export const REPORT_FRESH_MS = 24 * 3600_000;

/** Is the owner's Drive access report recent enough to be the only source of seats? */
export const reportIsFresh = (tenant, now) => Boolean(tenant.access?.at && now - Date.parse(tenant.access.at) < REPORT_FRESH_MS);

/**
 * Who holds a seat. The owner always counts.
 * - Fresh owner report (< 24 h): exactly the people with Drive access. Sessions don't add seats, so someone who
 *   merely knows the group id (a removed member, a stranger) can't push the group over its limit.
 * - Stale report: the report, plus people who opened the group since it (shared in Drive after the owner's last
 *   sync), except anyone a report has marked removed.
 * - No report yet (owner's app never reported): everyone who has opened it and isn't marked removed.
 */
export function seatHolders(tenant, memberships, now = Date.now()) {
  const set = new Set([tenant.ownerHash]);
  const reportAt = tenant.access?.at ? Date.parse(tenant.access.at) : null;
  if (reportAt != null) {
    for (const h of tenant.access.hashes || []) set.add(h);
    const dropped = new Set(tenant.access.removedHashes || []);
    if (!reportIsFresh(tenant, now)) for (const m of memberships) if (!m.removedAt && !dropped.has(m.personHash) && Date.parse(m.lastOpenedAt) > reportAt) set.add(m.personHash);
  } else {
    for (const m of memberships) if (!m.removedAt) set.add(m.personHash);
  }
  return set;
}

/**
 * Evaluate one tenant for one person.
 * Returns the state plus `graceStart`, which the caller persists when it changed (it starts the 14 days).
 */
export function evaluate({ app, tenant, memberships = [], settings, who, now = Date.now() }) {
  const plan = planFor(app, tenant, settings);
  const seats = seatHolders(tenant, memberships, now);
  const cap = plan.limits.members;
  const unknowable = Boolean(tenant.access?.unknowable);
  const over = cap != null && (unknowable || seats.size > cap);
  const graceStart = over ? (tenant.graceStart || new Date(now).toISOString()) : null;
  const graceDays = Number.isFinite(Number(settings.graceDays)) ? Number(settings.graceDays) : 14;
  const graceEndsMs = graceStart ? Date.parse(graceStart) + graceDays * DAY : null;
  let state = !over ? `ok` : now < graceEndsMs ? `grace` : `restricted`;
  if (tenant.tamper) state = `locked`;
  const mode = tenant.mode || settings.mode || `observe`;
  const isOwner = who === tenant.ownerHash;
  const keepers = new Set(tenant.keepers || []);
  const kept = isOwner || state === `ok` || state === `grace` || keepers.has(who);
  const blocked = !isOwner && ((state === `restricted` && !kept) || state === `locked`);
  return {
    plan, mode, state, isOwner, kept, blocked, used: seats.size, cap, unknowable, graceStart,
    graceEndsAt: graceEndsMs != null && state !== `ok` ? new Date(graceEndsMs).toISOString() : null,
    seatHolders: seats,
  };
}

/** Server-written banner text (the app shows it as given, so wording changes need no app release). */
export function messagesFor(ev, appName) {
  const date = ev.graceEndsAt ? new Date(ev.graceEndsAt).toLocaleDateString(`en-US`, { day: `numeric`, month: `short`, timeZone: `UTC` }) : ``;
  const planName = ev.plan.name[0].toUpperCase() + ev.plan.name.slice(1);
  const m = [];
  if (ev.state === `grace`) {
    m.push({ id: `grace_owner`, severity: `warning`, audience: `owner`, dismissible: false,
      text: ev.unknowable ? `Link sharing is on, so this group can’t be counted. Turn it off or upgrade by ${date}.`
        : `Your group has ${ev.used} people; the ${planName} plan includes ${ev.cap}. Remove people or upgrade by ${date}.`,
      action: ev.unknowable ? `turn_off_link_sharing` : `open_people` });
    m.push({ id: `grace_member`, severity: `info`, audience: `all`, dismissible: true,
      text: `This group is over its plan’s limit. The owner has until ${date} to sort it out.`, action: null });
  }
  if (ev.state === `restricted`) {
    m.push({ id: `restricted_owner`, severity: `critical`, audience: `owner`, dismissible: false,
      text: `Sharing is off: your group is over the ${planName} plan’s limit. Choose who keeps access, remove people, or upgrade.`, action: `open_people` });
  }
  if (ev.state === `locked`) {
    m.push({ id: `locked_owner`, severity: `critical`, audience: `owner`, dismissible: false,
      text: `Some features are off because this group’s sharing doesn’t match its records. Remove extra people in Google Drive to restore it.`, action: `open_people` });
  }
  void appName;
  return m;
}

/** Entitlement claims (signed by the caller). */
export function claimsFor({ issuer, appId, tenant, ev, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  return {
    iss: issuer, aud: appId, sub: tenant._id, iat, exp: iat + 86400, mode: ev.mode,
    plan: ev.plan.name, state: ev.state, graceEndsAt: ev.graceEndsAt,
    seats: { used: ev.used, cap: ev.cap, unknowable: ev.unknowable },
    limits: ev.plan.limits, features: ev.plan.features,
    you: { isOwner: ev.isOwner, kept: ev.kept, blocked: ev.blocked },
    overrides: tenant.overrides || [],
  };
}

/** Next check: soon while something is wrong, every 6 hours otherwise. */
export const nextCheckAt = (ev, now = Date.now()) => new Date(now + (ev.state === `ok` ? 6 * 3600_000 : 3600_000)).toISOString();

/**
 * Apply an owner's Drive access report to a tenant (mutates and returns it). People hashes in `report` must already
 * be server keys (personKey). Returns who dropped out (marked removed) and who is present (un-marked).
 * Tamper: more people shared after the group was Restricted → Locked; clears once back within the limit.
 * People not on the Members tab are only recorded (they look the same as an honest Drive share).
 */
export function applyAccessReport({ app, tenant, memberships, settings, report, now = Date.now() }) {
  const hashes = new Set(); let unknowable = false;
  for (const f of report.files) {
    if (f.general !== `restricted`) unknowable = true;
    for (const p of f.people) { if (p.type === `group`) unknowable = true; else hashes.add(p.emailHash); }
  }
  const tab = new Set(report.membersTab || []);
  const notOnMembersTab = [...hashes].filter((h) => h !== tenant.ownerHash && !tab.has(h)).length;
  const before = evaluate({ app, tenant, memberships, settings, who: tenant.ownerHash, now });
  const prevCount = tenant.access?.count ?? null;
  // people a report once listed and a later one doesn't: removed, whether or not they ever opened the app
  const removedHashes = new Set(tenant.access?.removedHashes || []);
  for (const h of tenant.access?.hashes || []) if (!hashes.has(h)) removedHashes.add(h);
  for (const h of hashes) removedHashes.delete(h);
  tenant.access = { at: new Date(now).toISOString(), reportedAt: report.reportedAt, hashes: [...hashes], unknowable, notOnMembersTab, count: hashes.size,
    removedHashes: [...removedHashes].slice(-500) };
  if (before.state === `restricted` && prevCount != null && hashes.size > prevCount) tenant.tamper = `reshared_after_restricted`;
  const cap = planFor(app, tenant, settings).limits.members;
  if (tenant.tamper === `reshared_after_restricted` && (cap == null || hashes.size <= cap) && !unknowable) tenant.tamper = null;
  const removed = memberships.filter((m) => !m.removedAt && !hashes.has(m.personHash) && m.personHash !== tenant.ownerHash).map((m) => m.personHash);
  const present = memberships.filter((m) => m.removedAt && hashes.has(m.personHash)).map((m) => m.personHash);
  return { tenant, removed, present };
}

/** Record something odd about a group for review (capped). Never changes the group's state by itself. */
export function addFlag(tenant, what, now = Date.now(), extra = {}) {
  const last = (tenant.flags || []).findLast((f) => f.what === what);
  if (last && now - Date.parse(last.at) < 3600_000) { last.count = (last.count || 1) + 1; return tenant; } // same thing again within the hour: count it
  tenant.flags = [...(tenant.flags || []), { at: new Date(now).toISOString(), what, ...extra }].slice(-50);
  return tenant;
}

/**
 * What the app read for the group id. The server is the authority (it binds each sheet to one group), so a
 * mismatch or a missing copy is only recorded. Locking on it would let any editor lock the owner's group by
 * editing the visible Meta tab.
 */
export function applySources(tenant, sources = {}, now = Date.now()) {
  const a = sources.appProperties; const b = sources.metaTab;
  if (tenant.tamper === `ids_disagree`) tenant.tamper = null; // older rule; ids no longer lock
  if (a && b && a !== b) addFlag(tenant, `ids_disagree`, now);
  else if (a && a !== tenant._id) addFlag(tenant, `id_not_canonical`, now);
  else if (!a || !b) addFlag(tenant, `id_missing`, now);
  return tenant;
}
