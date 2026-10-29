import { CONFIG } from './config.js';
import { googleConfigured, pickerConfigured, signIn, signOut, hasValidToken, tokenTimeLeft, pickSpreadsheet, AuthError } from './google.js';
import { Repo } from './store.js';
import { search, findDuplicates } from './search.js';
import { processPhoto, processExtraPhoto, shrinkForAi, cropItem } from './image.js';
import { aiReady, aiSettings, saveAiSettings, disableAi, analyzePhoto, describeItem, scanPhotos, verifyKey, aiUsageToday, AiError, SIZES } from './ai.js';
import { esc, $, $$, toast, sheet, confirmSheet, promptSheet, icon, timeAgo } from './ui.js';
import { captureScan } from './scan.js';
import { scanLabel } from './qrscan.js';
import { lic, emailHash, LicError } from './licensing.js';

const MODE_KEY = `stash.mode`;
const RECENT_LOC_KEY = `stash.recentLocs`;
let repo = null;
let findState = { q: ``, filter: `` };

const app = $(`#app`);
const KIND_ICON = { place: `home`, room: `room`, container: `box` };
const STATUS_LABEL = { lent: `Lent`, missing: `Missing`, reserved: `Reserved`, home: `` };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, `0`)}-${String(d.getDate()).padStart(2, `0`)}`; };
const isoDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, `0`)}-${String(d.getDate()).padStart(2, `0`)}`; };
/** "by Fri, Oct 16", "today", "2 days late" for a YYYY-MM-DD pick-up date. */
function dueText(due) {
  if (!due) return { text: ``, late: false };
  const days = Math.round((new Date(`${due}T00:00`) - new Date(`${todayStr()}T00:00`)) / 86400000);
  if (days < 0) return { text: `${-days} day${days === -1 ? `` : `s`} late`, late: true };
  if (days === 0) return { text: `pick up today`, late: false };
  if (days === 1) return { text: `pick up tomorrow`, late: false };
  return { text: `pick up by ${new Date(`${due}T00:00`).toLocaleDateString(undefined, { weekday: `short`, month: `short`, day: `numeric` })}`, late: false };
}

// ============================================================ updates
// The app opens from the copy on the phone. When a new version has finished downloading in the background,
// offer a reload (or apply it silently if the app was only just opened).
const bootedAt = Date.now();
function registerServiceWorker() {
  if (!(`serviceWorker` in navigator) || location.protocol === `file:`) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register(`./sw.js`, { updateViaCache: `none` }).then((reg) => {
    document.addEventListener(`visibilitychange`, () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener(`controllerchange`, () => {
    if (!hadController || reloading) return; // first install: nothing to update
    const busy = document.querySelector(`.sheet-wrap.open, .viewer`) || [`add`, `edit`].includes(route().name);
    if (Date.now() - bootedAt < 4000 && !busy) { reloading = true; location.reload(); return; }
    toast(`A new version of Paran is ready`, { action: `Reload`, ms: 15000, onAction: () => { reloading = true; location.reload(); } });
  });
}

// ============================================================ boot
async function boot() {
  registerServiceWorker();
  await lic.init().catch((e) => console.warn(`licensing init`, e)); // no-op unless CONFIG.LICENSE_URL is set
  window.addEventListener(`hashchange`, () => { if (sel.on) selStop(); render(); });
  installSelectionGestures();
  window.addEventListener(`online`, () => repo?.refresh());
  document.addEventListener(`visibilitychange`, () => { if (!document.hidden) repo?.refresh(); });

  const mode = localStorage.getItem(MODE_KEY);
  if (mode === `demo`) return start(`demo`);
  if (mode === `google` && googleConfigured()) {
    if (resumeGoogle()) return;            // open instantly from the phone's copy, sync when Google says OK
    if (hasValidToken()) return start(`google`);
    return renderReconnect();
  }
  renderWelcome();
}

async function start(kind, { interactive = false, choice } = {}) {
  try {
    if (kind === `google` && (interactive || !hasValidToken())) await signIn();
    renderLoading(kind === `google` ? `Opening your inventory…` : `Loading…`);
    repo = new Repo(kind);
    const info = await repo.connect(choice);
    if (info.needsChoice) return renderChoice(info.user);
    localStorage.setItem(MODE_KEY, kind);
    repo.addEventListener(`change`, onRepoChange);
    repo.addEventListener(`status`, renderStatus);
    if (kind === `google` && interactive) lic.count(`signin`);
    if (choice === `create`) lic.count(`inventory.create`); else if (choice) lic.count(`inventory.join`);
    renderShell();
    attachLic();
    if (choice === `create`) location.hash = `#/setup`; // brand-new inventory: start by naming your places
    render();
    if (kind === `google`) installQuietRenew();
  } catch (e) {
    console.error(e);
    renderWelcome(e.message || String(e));
  }
}

/** Reopen straight into the inventory from the saved session; no sign-in screen. */
function resumeGoogle() {
  const r = new Repo(`google`);
  if (!r.resume()) return false;
  repo = r;
  repo.addEventListener(`change`, onRepoChange);
  repo.addEventListener(`status`, renderStatus);
  renderShell(); attachLic(); render();
  if (hasValidToken()) repo.refresh();
  else repo.setStatus(navigator.onLine ? `auth` : `offline`);
  installQuietRenew();
  return true;
}

// ---- quiet renew: Google tokens last ~1 hour and a browser app can't refresh them in the background
// without a server. So the first tap after (or just before) expiry renews it, using the saved account
// as a hint: the Google popup usually opens and closes by itself, no account picker, no consent screen.
let renewing = null; let lastRenewFail = 0;
function needsRenew() { return repo?.backend.kind === `google` && navigator.onLine && tokenTimeLeft() < 5 * 60_000; }
async function renewNow({ quiet = true } = {}) {
  if (renewing) return renewing;
  renewing = (async () => {
    try {
      await signIn({ silent: true, hint: repo.user?.email || `` });
      await repo.refresh();
      if (!quiet) toast(`Synced`);
      return true;
    } catch (e) {
      lastRenewFail = Date.now();
      if (!quiet) toast(`Couldn’t reach Google: ${e.message}`);
      repo.setStatus(`auth`);
      return false;
    } finally { renewing = null; }
  })();
  return renewing;
}
let quietInstalled = false;
function installQuietRenew() {
  if (quietInstalled) return; quietInstalled = true;
  document.addEventListener(`click`, (e) => {
    if (!needsRenew() || renewing || Date.now() - lastRenewFail < 120_000) return;
    if (e.target.closest(`#status`)) return; // the status pill handles its own tap
    renewNow(); // inside a user gesture, so the browser allows Google's popup
  }, true);
}

function onRepoChange() {
  const r = route().name;
  if (r === `find`) { renderResults(); return; }
  if (r === `add` || r === `edit`) return; // never wipe a form mid-edit
  if (document.querySelector(`.sheet-wrap.open`)) return; // a sheet is open; its owner redraws
  render();
}

// ============================================================ pre-app screens
function renderWelcome(error) {
  window.__stashStarted = true; // something is on screen: the startup watchdog in index.html stands down
  const g = googleConfigured();
  app.innerHTML = `
  <main class="welcome">
    <div class="brand-mark">${icon(`box`)}</div>
    <h1>${esc(CONFIG.APP_NAME)}</h1>
    <p class="lead">Know what you have, where it is, and what it’s for.</p>
    <ul class="points">
      <li>${icon(`camera`)}<span>Snap, name, pick a place. Done in seconds.</span></li>
      <li>${icon(`search`)}<span>Search by what you need it for, not just its name.</span></li>
      <li>${icon(`cloud`)}<span>${lic.on() ? `Your inventory lives in <b>your own Google Drive</b>. ${esc(CONFIG.APP_NAME)} never sees what’s in it.` : `Your data lives in <b>your own Google Drive</b>. Nothing is stored anywhere else.`}</span></li>
    </ul>
    ${error ? `<p class="error-box">${icon(`alert`)} ${esc(error)}</p>` : ``}
    <div class="stack">
      ${g ? `<button class="btn primary big" id="gsign">${googleG()} Continue with Google</button>`
        : `<p class="note">Google sign-in isn’t set up yet. Add your OAuth Client ID in <code>js/config.js</code> (see README).</p>`}
      <button class="btn ghost big" id="demo">Try it without an account</button>
      <p class="fine">Demo data stays in this browser only.</p>
    </div>
  </main>`;
  $(`#gsign`)?.addEventListener(`click`, () => start(`google`, { interactive: true }));
  $(`#demo`).addEventListener(`click`, () => { lic.count(`demo.start`); start(`demo`); });
}

function renderReconnect() {
  window.__stashStarted = true; // something is on screen: the startup watchdog in index.html stands down
  app.innerHTML = `
  <main class="welcome">
    <div class="brand-mark">${icon(`box`)}</div>
    <h1>Welcome back</h1>
    <p class="lead">Sign in again to open your inventory.</p>
    <div class="stack"><button class="btn primary big" id="gsign">${googleG()} Continue with Google</button>
    <button class="btn ghost" id="switch">Use demo instead</button></div>
  </main>`;
  $(`#gsign`).onclick = () => start(`google`, { interactive: true });
  $(`#switch`).onclick = () => { localStorage.setItem(MODE_KEY, `demo`); start(`demo`); };
}

function renderChoice(user) {
  window.__stashStarted = true; // something is on screen: the startup watchdog in index.html stands down
  app.innerHTML = `
  <main class="welcome">
    <h1>Hi ${esc((user.name || ``).split(` `)[0] || `there`)}</h1>
    <p class="lead">Start a new inventory, or join one someone shared with you.</p>
    <div class="choice-grid">
      <button class="choice" id="create">${icon(`plus`)}<b>Start a new inventory</b><span>Creates a “${esc(CONFIG.ROOT_FOLDER_NAME)}” folder and sheet in your Drive.</span></button>
      <button class="choice" id="join" ${pickerConfigured() ? `` : `disabled`}>${icon(`users`)}<b>Join a shared inventory</b>
        <span>${pickerConfigured() ? `Pick the “${esc(CONFIG.SHEET_NAME)}” (or older “${esc(CONFIG.LEGACY_SHEET_NAME)}”) sheet someone shared with you.` : `Needs API_KEY and APP_ID in js/config.js.`}</span></button>
    </div>
  </main>`;
  $(`#create`).onclick = () => start(`google`, { choice: `create` });
  $(`#join`).onclick = async () => {
    try {
      const id = await pickSpreadsheet();
      if (id) start(`google`, { choice: id });
    } catch (e) { toast(e.message); }
  };
}

function renderLoading(msg) {
  window.__stashStarted = true; // something is on screen: the startup watchdog in index.html stands down
  app.innerHTML = `<main class="welcome"><div class="spinner"></div><p class="muted">${esc(msg)}</p></main>`;
}

const googleG = () => `<svg class="g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

// ============================================================ shell + routing
function renderShell() {
  window.__stashStarted = true; // something is on screen: the startup watchdog in index.html stands down
  app.innerHTML = `
    <header class="topbar">
      <a href="#/" class="logo">${icon(`box`)}<span>${esc(CONFIG.APP_NAME)}</span></a>
      <button class="status" id="status" type="button"></button>
    </header>
    <div id="licbar" class="licbar" hidden></div>
    <main id="view" class="view"></main>
    <nav class="tabbar">
      <a href="#/" data-tab="find">${icon(`search`)}<span>Find</span></a>
      <a href="#/places" data-tab="places">${icon(`place`)}<span>Places</span></a>
      <a href="#/add" class="fab" data-tab="add" aria-label="Add item">${icon(`plus`)}</a>
      <a href="#/out" data-tab="out">${icon(`lend`)}<span>Out</span><b class="tab-badge" hidden></b></a>
      <a href="#/more" data-tab="more">${icon(`more`)}<span>More</span></a>
    </nav>`;
  $(`#status`).onclick = onStatusClick;
  renderStatus();
}

function renderStatus() {
  const el = $(`#status`); if (!el || !repo) return;
  const s = repo.status;
  const pending = repo.outbox.length;
  const map = {
    synced: [`ok`, `Saved`], idle: [`ok`, `Saved`], syncing: [`busy`, `Saving…`],
    pending: [`warn`, `${pending} to save`], offline: [`warn`, pending ? `Offline · ${pending} waiting` : `Offline`],
    auth: [`warn`, pending ? `${pending} waiting · tap to sync` : `Tap to sync`], error: [`bad`, `Not saved yet`],
  };
  const [cls, label] = repo.backend.kind === `demo` ? [`demo`, `Demo`] : (map[s] || map.idle);
  el.className = `status ${cls}`;
  el.innerHTML = `<i></i>${esc(label)}`;
}

async function onStatusClick() {
  if (repo.backend.kind === `demo`) return toast(`Demo mode: data stays in this browser. Sign in with Google from More.`);
  if (repo.status === `auth` || needsRenew()) { await renewNow({ quiet: false }); return; }
  if (repo.status === `error`) return toast(`Sync failed: ${repo.lastError?.message || `unknown error`}`, { action: `Retry`, onAction: () => repo.refresh() });
  repo.refresh();
}

function route() {
  const h = location.hash.replace(/^#\/?/, ``);
  const [path, qs] = h.split(`?`);
  const parts = path.split(`/`).filter(Boolean);
  const params = new URLSearchParams(qs || ``);
  if (!parts.length) return { name: `find`, params };
  return { name: parts[0], id: parts[1], params };
}

// In-app navigation history, so Back returns to where you came from (a place, Out, a search…).
const navStack = [];
let lastHash = null;
function goBack(fallback = `#/`) {
  navStack.pop(); // current screen
  const prev = navStack.pop();
  location.hash = prev ?? fallback;
}

function render() {
  if (!repo || !$(`#view`)) return;
  const r = route();
  const routeChanged = location.hash !== lastHash;
  if (routeChanged) {
    lastHash = location.hash;
    if (navStack[navStack.length - 1] !== location.hash) navStack.push(location.hash);
    if (navStack.length > 30) navStack.shift();
  }
  const tab = { find: `find`, item: `find`, edit: `add`, add: `add`, places: `places`, place: `places`, out: `out`, more: `more`, setup: `places` }[r.name] || `find`;
  $$(`.tabbar a`).forEach((a) => a.classList.toggle(`active`, a.dataset.tab === tab));
  document.body.classList.toggle(`focus-mode`, r.name === `add` || r.name === `edit` || r.name === `setup`); // no tab bar while filling a form
  if (routeChanged && (r.name === `add` || r.name === `edit`)) $$(`#toasts .toast`).forEach((t) => t.remove()); // an Undo from another screen doesn't belong here
  updateOutBadge();
  const view = $(`#view`);
  const y = window.scrollY;
  view.onclick = null;
  const screens = { find: viewFind, item: viewItem, add: viewEdit, edit: viewEdit, places: viewPlace, place: viewPlace, out: viewOut, more: viewMore, setup: viewSetup };
  renderLicBar();
  if (lic.blocked() && r.name !== `more`) viewBlocked(view);
  else (screens[r.name] || viewFind)(view, r);
  window.scrollTo(0, routeChanged ? 0 : y); // a background sync must not jump the page to the top
}

function updateOutBadge() {
  const b = $(`.tab-badge`); if (!b || !repo) return;
  const late = repo.activeItems().filter((i) => attentionReason(i)?.urgent).length;
  b.hidden = !late; b.textContent = late;
}

// ============================================================ shared bits
function thumbHtml(item, cls = `thumb`) {
  const t = repo.thumbs[item.id];
  return t ? `<img class="${cls}" src="${t}" alt="" loading="lazy">` : `<div class="${cls} ph">${icon(`photo`)}</div>`;
}

/** Card for an item. The location is the answer people came for, so it's the most visible line. */
function itemCard(item, { reason } = {}) {
  const parts = repo.pathOf(item.locationId);
  const near = parts.slice(-2).map((l) => l.name).join(` › `);           // "Garage › Blue bin"
  const far = parts.length > 2 ? parts.slice(0, -2).map((l) => l.name).join(` › `) : ``; // "Home"
  const due = item.status === `reserved` ? dueText(item.dueAt) : { text: `` };
  const badge = item.status === `reserved`
    ? `<span class="badge reserved${due.late ? ` late` : ``}">Reserved · ${esc(item.lentTo || `someone`)}${due.text ? ` · ${esc(due.text)}` : ``}</span>`
    : STATUS_LABEL[item.status] ? `<span class="badge ${esc(item.status)}">${esc(STATUS_LABEL[item.status])}${item.status === `lent` && item.lentTo ? ` · ${esc(item.lentTo)}` : ``}</span>` : ``;
  const cls = `${sel.on ? ` selectable` : ``}${sel.ids.has(item.id) ? ` selected` : ``}`;
  return `<a class="card${cls}" href="#/item/${esc(item.id)}" data-id="${esc(item.id)}">
    <span class="sel-tick" aria-hidden="true">${icon(`check`)}</span>
    ${thumbHtml(item)}
    <div class="card-main">
      <div class="card-title">${esc(item.name)}${Number(item.qty) > 1 ? ` <span class="qty">×${esc(item.qty)}</span>` : ``}</div>
      <div class="card-path">${icon(`place`)}<span>${near ? esc(near) : `<i>No location yet</i>`}${far ? `<small> · ${esc(far)}</small>` : ``}</span></div>
      ${reason ? `<div class="card-reason ${reason.urgent ? `urgent` : ``}">${esc(reason.text)}</div>`
        : item.purpose ? `<div class="card-purpose">${esc(item.purpose)}</div>` : ``}
      ${reason ? `` : badge}
    </div></a>`;
}

// ---- what deserves attention on the dashboard and the Out tab
const LONG_LENT_DAYS = 30;
let lentMemo = { key: ``, map: new Map() };
function lentSinceMap() {
  const key = `${repo.log.length}:${repo.items.length}:${repo.outbox.length}`;
  if (lentMemo.key !== key) {
    const map = new Map();
    for (const p of repo.lendPeriods()) if (p.lentAt && !p.returnedAt) map.set(p.itemId, p.lentAt);
    lentMemo = { key, map };
  }
  return lentMemo.map;
}
/** { text, urgent, rank } or null. Lower rank = show first. */
function attentionReason(item) {
  if (item.status === `reserved` && item.dueAt) {
    const d = dueText(item.dueAt);
    if (d.late) return { text: `Pick-up ${d.text} · ${item.lentTo}`, urgent: true, rank: 0 };
    if (/today|tomorrow/.test(d.text)) return { text: `${d.text.replace(/^pick up/, `Pick-up`)} · ${item.lentTo}`, urgent: false, rank: 1 };
  }
  if (item.status === `lent`) {
    const since = lentSinceMap().get(item.id); const n = since ? daysBetween(since) : null;
    if (n !== null && n >= LONG_LENT_DAYS) return { text: `With ${item.lentTo} for ${n} days`, urgent: false, rank: 2 };
  }
  if (item.status === `missing`) return { text: `Marked missing`, urgent: false, rank: 3 };
  return null;
}

function crumbs(locId, { link = true } = {}) {
  const parts = repo.pathOf(locId);
  if (!parts.length) return `<span class="muted">No location</span>`;
  return parts.map((l) => (link ? `<a href="#/place/${esc(l.id)}">${esc(l.name)}</a>` : `<span>${esc(l.name)}</span>`)).join(`<span class="sep">›</span>`);
}

function rememberLoc(id) {
  if (!id) return;
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_LOC_KEY) || `[]`).filter((x) => x !== id);
    list.unshift(id); localStorage.setItem(RECENT_LOC_KEY, JSON.stringify(list.slice(0, 6)));
  } catch { /* ignore */ }
}
function recentLocs() {
  try { return JSON.parse(localStorage.getItem(RECENT_LOC_KEY) || `[]`).filter((id) => repo.locById(id)); } catch { return []; }
}

function kindFor(parentId) {
  const depth = parentId ? repo.pathOf(parentId).length : 0;
  return depth === 0 ? `place` : depth === 1 ? `room` : `container`;
}

/** Location picker as a bottom sheet. Resolves with a location id or null. */
function pickLocation(startId = ``, title = `Where does it live?`, { exclude = null, inside = null } = {}) {
  return new Promise((resolve) => {
    let current = inside ?? (startId ? (repo.locById(startId)?.parentId || ``) : ``);
    if (exclude?.has(current)) current = ``;
    let done = false;
    const ok = (l) => !exclude || !exclude.has(l.id);
    sheet(title, (el, close) => {
      const finish = (id) => { done = true; rememberLoc(id); resolve(id); close(); };
      el.innerHTML = `<label class="search sm">${icon(`search`)}<input data-q type="search" placeholder="Search places" autocomplete="off" enterkeyhint="search">
        <button type="button" class="icon-btn search-qr" data-scanpick aria-label="Scan a label">${icon(`qr`)}</button></label><div class="pk-body"></div>`;
      const qEl = $(`[data-q]`, el); const body = $(`.pk-body`, el);
      $(`[data-scanpick]`, el).addEventListener(`click`, async (e) => {
        e.preventDefault();
        const loc = await scanToPlace(title, `Point at the label on the box or shelf.`);
        if (loc && ok(loc)) finish(loc.id);
        else if (loc) toast(`Can’t put it there`);
      });
      const draw = () => {
        const q = qEl.value.trim().toLowerCase();
        if (q) {
          const terms = q.split(/\s+/);
          const hits = repo.locations.filter((l) => !l.deleted && ok(l))
            .map((l) => ({ l, path: repo.pathText(l.id) }))
            .filter(({ path }) => terms.every((t) => path.toLowerCase().includes(t)))
            .sort((a, b) => a.path.length - b.path.length).slice(0, 25);
          const here = repo.locById(current);
          body.innerHTML = `<div class="list">${hits.map(({ l, path }) => `<div class="list-row">
              <button type="button" class="list-main" data-pick="${esc(l.id)}">${icon(KIND_ICON[l.kind] || `box`)}<span>${esc(path)}</span></button></div>`).join(``)
              || `<p class="muted pad">No place matches “${esc(qEl.value.trim())}”.</p>`}</div>
            <div class="row-actions"><button type="button" class="btn ghost" data-create="${esc(qEl.value.trim())}">${icon(`plus`)} New “${esc(qEl.value.trim())}”${here ? ` in ${esc(here.name)}` : ``}</button></div>`;
          return;
        }
        const kids = repo.childrenOf(current).filter(ok);
        const here = repo.locById(current);
        const recents = !current ? recentLocs().filter((id) => ok({ id })) : [];
        body.innerHTML = `
          ${recents.length ? `<div class="label-sm">Recent</div><div class="chips">${recents.map((id) => `<button type="button" class="chip" data-pick="${esc(id)}">${esc(repo.pathText(id))}</button>`).join(``)}</div>` : ``}
          <div class="picker-crumbs"><button type="button" class="link" data-go="">All places</button>${repo.pathOf(current).map((l) => `<span class="sep">›</span><button type="button" class="link" data-go="${esc(l.id)}">${esc(l.name)}</button>`).join(``)}</div>
          <div class="list">
            ${kids.map((l) => `<div class="list-row">
                <button type="button" class="list-main" data-pick="${esc(l.id)}">${icon(KIND_ICON[l.kind] || `box`)}<span>${esc(l.name)}</span></button>
                ${repo.childrenOf(l.id).filter(ok).length ? `<button type="button" class="icon-btn" data-go="${esc(l.id)}" aria-label="Open ${esc(l.name)}">${icon(`chevron`)}</button>` : ``}
              </div>`).join(``) || `<p class="muted pad">Nothing inside yet.</p>`}
          </div>
          <div class="row-actions">
            <button type="button" class="btn ghost" data-new>${icon(`plus`)} New place${current ? ` in ${esc(here?.name || ``)}` : ``}</button>
            ${current ? `<button type="button" class="btn primary" data-pick="${esc(current)}">Put in ${esc(here?.name || ``)}</button>` : ``}
          </div>`;
      };
      qEl.addEventListener(`input`, draw);
      body.addEventListener(`click`, async (e) => {
        const b = e.target.closest(`button`); if (!b) return;
        if (b.dataset.pick !== undefined) return finish(b.dataset.pick);
        if (b.dataset.go !== undefined) { current = b.dataset.go; return draw(); }
        if (b.dataset.create !== undefined) {
          const loc = repo.saveLocation({ name: b.dataset.create, parentId: current, kind: kindFor(current) });
          return finish(loc.id);
        }
        if (b.dataset.new !== undefined) {
          const name = await inlineName(body, current ? `e.g. Blue bin, Top shelf, Drawer 2` : `e.g. Home, Storage unit, Office`);
          if (name) { const loc = repo.saveLocation({ name, parentId: current, kind: kindFor(current) }); current = loc.id; }
          draw();
        }
      });
      draw();
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

// ============================================================ Moving (single, bulk, undo)
/** Move items and offer Undo. Moving a lent item means it's back home. */
async function moveWithUndo(items, toId) {
  const moving = items.filter((i) => i && (i.locationId !== toId || i.status === `lent`));
  if (!moving.length) { toast(`Already there`); return; }
  const prev = moving.map((i) => ({ id: i.id, locationId: i.locationId, status: i.status, lentTo: i.lentTo }));
  for (const it of moving) await repo.moveItem(it, toId);
  rememberLoc(toId);
  const label = moving.length === 1 ? moving[0].name : `${moving.length} items`;
  toast(`Moved ${label} to ${repo.pathText(toId)}`, {
    action: `Undo`, ms: 7000,
    onAction: async () => {
      for (const p of prev) {
        const it = repo.items.find((i) => i.id === p.id); if (!it) continue;
        await repo.saveItem({ id: p.id, locationId: p.locationId, status: p.status === `lent` ? `home` : p.status }, { logAction: `moved` });
        if (p.status === `lent`) await repo.lendItem(it, p.lentTo);
      }
      toast(`Move undone`);
    },
  });
}

async function moveSpot(loc) {
  const id = await pickLocation(loc.parentId, `Move ${loc.name} into…`, { exclude: repo.descendantIds(loc.id) });
  if (!id || id === loc.parentId) return;
  const before = loc.parentId;
  repo.saveLocation({ id: loc.id, parentId: id });
  const n = repo.itemsIn(loc.id, true).length;
  toast(`Moved ${loc.name}${n ? ` and its ${n} item${n > 1 ? `s` : ``}` : ``} to ${repo.pathText(id)}`, {
    action: `Undo`, ms: 7000, onAction: () => { repo.saveLocation({ id: loc.id, parentId: before }); toast(`Move undone`); },
  });
}

/** From a place: pick items elsewhere and bring them here. */
function bringItemsSheet(loc) {
  const chosen = new Set();
  sheet(`Bring items to ${loc.name}`, (el, close) => {
    el.innerHTML = `<label class="search sm">${icon(`search`)}<input data-q type="search" placeholder="Search your items" autocomplete="off" enterkeyhint="search"></label>
      <div class="bring-list"></div>
      <div class="row-actions sticky-actions"><button type="button" class="btn primary full" data-go disabled>Select items</button></div>`;
    const qEl = $(`[data-q]`, el); const listEl = $(`.bring-list`, el); const go = $(`[data-go]`, el);
    const upd = () => { const n = chosen.size; go.disabled = !n; go.textContent = n ? `Move ${n} here` : `Select items`; };
    const draw = () => {
      const pool = repo.activeItems().filter((i) => i.locationId !== loc.id);
      const q = qEl.value.trim();
      const list = q ? search(pool, q, (id) => repo.pathText(id)) : [...pool].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      listEl.innerHTML = list.slice(0, 80).map((i) => `<label class="bring-row">
          <input type="checkbox" data-id="${esc(i.id)}" ${chosen.has(i.id) ? `checked` : ``}>
          ${thumbHtml(i, `thumb sm`)}
          <div><b>${esc(i.name)}</b><small>${esc(repo.pathText(i.locationId) || `No location`)}${i.status === `lent` ? ` · lent to ${esc(i.lentTo)}` : ``}</small></div>
        </label>`).join(``) || `<p class="muted pad">${q ? `No items match “${esc(q)}”.` : `Everything is already here.`}</p>`;
      upd();
    };
    listEl.addEventListener(`change`, (e) => { const id = e.target.dataset.id; if (!id) return; if (e.target.checked) chosen.add(id); else chosen.delete(id); upd(); });
    qEl.addEventListener(`input`, draw);
    go.onclick = async () => {
      const items = [...chosen].map((id) => repo.items.find((i) => i.id === id)).filter(Boolean);
      close(); await moveWithUndo(items, loc.id);
    };
    draw();
  });
}

// ---- selection mode (Find results and places): tap "Select" or long-press a card
const sel = { on: false, ids: new Set() };
let suppressClick = false;
function selStart(id) { sel.on = true; if (id) sel.ids.add(id); refreshSel(); }
function selStop() { sel.on = false; sel.ids.clear(); refreshSel(); }
const visibleIds = () => $$(`#view .card[data-id]`).map((c) => c.dataset.id);
function refreshSel() {
  $$(`.card[data-id]`).forEach((c) => { c.classList.toggle(`selectable`, sel.on); c.classList.toggle(`selected`, sel.ids.has(c.dataset.id)); });
  $$(`[data-select-toggle]`).forEach((b) => { b.textContent = sel.on ? `Done` : `Select`; });
  let bar = $(`#selbar`);
  if (!sel.on) { bar?.remove(); document.body.classList.remove(`selecting`); return; }
  if (!bar) { bar = document.createElement(`div`); bar.id = `selbar`; bar.className = `selbar`; document.body.appendChild(bar); bar.onclick = onSelBar; }
  document.body.classList.add(`selecting`);
  const n = sel.ids.size; const vis = visibleIds(); const all = vis.length && vis.every((id) => sel.ids.has(id));
  bar.innerHTML = `<button type="button" class="btn text" data-s="cancel">Cancel</button>
    <span class="sel-count"><b>${n}</b> selected</span>
    <button type="button" class="btn text" data-s="all">${all ? `None` : `All`}</button>
    <button type="button" class="btn ghost" data-s="share" ${n ? `` : `disabled`} aria-label="Share">${icon(`share`)}<span>Share</span></button>
    <button type="button" class="btn primary" data-s="move" ${n ? `` : `disabled`}>${icon(`move`)} Move</button>`;
}
async function onSelBar(e) {
  const s = e.target.closest(`[data-s]`)?.dataset.s; if (!s) return;
  if (s === `cancel`) return selStop();
  if (s === `all`) {
    const vis = visibleIds(); const all = vis.every((id) => sel.ids.has(id));
    vis.forEach((id) => (all ? sel.ids.delete(id) : sel.ids.add(id))); return refreshSel();
  }
  if (s === `share`) {
    const items = [...sel.ids].map((id) => repo.items.find((i) => i.id === id)).filter(Boolean);
    if (await shareSelection(items)) selStop();
    return;
  }
  if (s === `move`) {
    const items = [...sel.ids].map((id) => repo.items.find((i) => i.id === id)).filter(Boolean);
    const common = items.every((i) => i.locationId === items[0]?.locationId) ? items[0]?.locationId : ``;
    const id = await pickLocation(common, `Move ${items.length} item${items.length > 1 ? `s` : ``} to…`);
    if (!id) return;
    selStop(); await moveWithUndo(items, id);
  }
}
function installSelectionGestures() {
  let timer = null, start = null;
  document.addEventListener(`click`, (e) => {
    const toggle = e.target.closest(`[data-select-toggle]`);
    if (toggle) { e.preventDefault(); return sel.on ? selStop() : selStart(); }
    const card = e.target.closest(`#view .card[data-id]`); if (!card) return;
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; return; }
    if (sel.on) {
      e.preventDefault(); e.stopPropagation();
      const id = card.dataset.id; if (sel.ids.has(id)) sel.ids.delete(id); else sel.ids.add(id);
      refreshSel();
    }
  }, true);
  document.addEventListener(`pointerdown`, (e) => {
    const card = e.target.closest(`#view .card[data-id]`); if (!card || sel.on) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 800);
      navigator.vibrate?.(15); selStart(card.dataset.id);
    }, 450);
  });
  const cancel = () => { clearTimeout(timer); start = null; };
  document.addEventListener(`pointerup`, cancel); document.addEventListener(`pointercancel`, cancel);
  document.addEventListener(`pointermove`, (e) => { if (start && (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10)) cancel(); });
  document.addEventListener(`contextmenu`, (e) => { if (e.target.closest(`#view .card[data-id]`)) e.preventDefault(); });
}

function inlineName(container, placeholder) {
  return new Promise((resolve) => {
    const row = document.createElement(`form`);
    row.className = `inline-new`;
    row.innerHTML = `<input placeholder="${esc(placeholder)}" required><button class="btn primary">Add</button>`;
    container.querySelector(`.row-actions`).replaceWith(row);
    const input = row.querySelector(`input`); input.focus();
    row.onsubmit = (e) => { e.preventDefault(); resolve(input.value.trim()); };
    input.addEventListener(`keydown`, (e) => { if (e.key === `Escape`) resolve(null); });
  });
}

// ============================================================ People you lend to
const fmtDate = (iso) => {
  if (!iso) return ``;
  const d = new Date(iso); if (isNaN(d)) return ``;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: `short`, day: `numeric`, ...(sameYear ? {} : { year: `numeric` }) });
};
const daysBetween = (a, b = new Date().toISOString()) => {
  if (!a) return null;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
};
const dayText = (n) => (n === null ? `` : n === 0 ? `today` : n === 1 ? `1 day` : `${n} days`);
const initials = (name) => String(name || `?`).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join(``).toUpperCase();

/**
 * Lend now or save for later. Free-text name with a dropdown of people you've lent to before.
 * Resolves { name, mode: 'now'|'later', dueAt } or null.
 */
function lendSheet(item, { mode: startMode = `now` } = {}) {
  return new Promise((resolve) => {
    let done = false; let mode = startMode; let picked = ``;
    const people = repo.people();
    sheet(item.name, (el, close) => {
      const finish = (v) => { done = true; resolve(v); close(); };
      el.innerHTML = `<form class="stack lend-form" autocomplete="off">
          <div class="seg" role="tablist">
            <button type="button" data-mode="now" role="tab">${icon(`lend`)} Lend now</button>
            <button type="button" data-mode="later" role="tab">${icon(`clock`)} Reserve</button>
          </div>
          <label class="field"><span data-wholabel></span>
            <input name="who" placeholder="Type a name" required autocomplete="off" autocapitalize="words" enterkeyhint="done"></label>
          <div class="suggest" role="listbox"></div>
          <div class="field" data-duebox hidden><span>Pick up by <small>(optional)</small></span>
            <div class="chips" data-quick>
              <button type="button" class="chip" data-due="${isoDay(0)}">Today</button>
              <button type="button" class="chip" data-due="${isoDay(1)}">Tomorrow</button>
              <button type="button" class="chip" data-due="${isoDay(3)}">In 3 days</button>
              <button type="button" class="chip" data-due="${isoDay(7)}">Next week</button>
            </div>
            <input type="date" name="due" min="${todayStr()}">
          </div>
          <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary" data-ok></button></div>
        </form>`;
      const input = $(`[name=who]`, el); const box = $(`.suggest`, el); const due = $(`[name=due]`, el);
      const drawMode = () => {
        $$(`[data-mode]`, el).forEach((b) => b.classList.toggle(`on`, b.dataset.mode === mode));
        $(`[data-wholabel]`, el).textContent = mode === `now` ? `Who has it?` : `Who is it for?`;
        $(`[data-duebox]`, el).hidden = mode !== `later`;
        $(`[data-ok]`, el).textContent = mode === `now` ? `Lend` : `Reserve`;
      };
      const drawQuick = () => $$(`[data-due]`, el).forEach((c) => c.classList.toggle(`on`, c.dataset.due === due.value));
      const draw = () => {
        const q = Repo.personKey(input.value);
        const list = (q ? people.filter((p) => p.key.includes(q)).sort((a, b) => (b.key.startsWith(q) - a.key.startsWith(q))) : people)
          .filter((p) => p.key !== q || !picked); // hide the exact match once chosen
        box.innerHTML = list.slice(0, 6).map((p) => `<button type="button" class="suggest-row" data-name="${esc(p.name)}" role="option">
            <span class="avatar sm">${esc(initials(p.name))}</span><span>${esc(p.name)}</span>
            <small>${[p.holding.length ? `has ${p.holding.length}` : ``, p.saved.length ? `${p.saved.length} reserved` : ``].filter(Boolean).join(` · `) || `lent ${p.total}×`}</small></button>`).join(``);
        box.hidden = !list.length;
        if (!q && list.length) box.insertAdjacentHTML(`afterbegin`, `<div class="label-sm">People you’ve lent to</div>`);
      };
      const submit = (nameRaw) => {
        const typed = String(nameRaw || ``).trim(); if (!typed) { input.focus(); return; }
        const same = people.find((p) => p.key === Repo.personKey(typed));
        finish({ name: same ? same.name : typed, mode, dueAt: mode === `later` ? due.value : `` }); // reuse existing spelling
      };
      el.addEventListener(`click`, (e) => {
        const m = e.target.closest(`[data-mode]`); if (m) { mode = m.dataset.mode; drawMode(); return; }
        const d = e.target.closest(`[data-due]`); if (d) { due.value = due.value === d.dataset.due ? `` : d.dataset.due; drawQuick(); }
      });
      due.addEventListener(`input`, drawQuick);
      input.addEventListener(`input`, () => { picked = ``; draw(); });
      box.onclick = (e) => {
        const b = e.target.closest(`[data-name]`); if (!b) return;
        if (mode === `now`) return submit(b.dataset.name); // one tap to lend
        input.value = b.dataset.name; picked = b.dataset.name; draw(); // saving: still lets you set a date
      };
      $(`[data-no]`, el).onclick = () => finish(null);
      $(`form`, el).onsubmit = (e) => { e.preventDefault(); submit(input.value); };
      drawMode(); draw();
      setTimeout(() => input.focus(), 250);
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

/** Lend or save an item, asking first if it's already saved for someone else. */
async function lendOrSave(item, opts) {
  const res = await lendSheet(item, opts); if (!res) return;
  const savedFor = item.status === `reserved` ? item.lentTo : ``;
  if (savedFor && Repo.personKey(savedFor) !== Repo.personKey(res.name)) {
    const ok = await confirmSheet(`Reserved for ${savedFor}`, `${item.name} is reserved for ${savedFor}. ${res.mode === `now` ? `Lend it to ${res.name}` : `Reserve it for ${res.name}`} instead?`, `Yes, ${res.mode === `now` ? `lend to` : `reserve for`} ${res.name}`);
    if (!ok) return;
  }
  if (res.mode === `now`) {
    if (savedFor && Repo.personKey(savedFor) === Repo.personKey(res.name)) await repo.pickUp(item);
    else await repo.lendItem(item, res.name);
    toast(`Lent to ${res.name}`);
  } else {
    await repo.reserveItem(item, res.name, res.dueAt);
    toast(`Reserved for ${res.name}${res.dueAt ? ` · ${dueText(res.dueAt).text}` : ``}`);
  }
}

// ---------------- full-screen photo, inside the app (no Drive page, no second login)
const SIZE_HINT = { Pocket: `keys, cables`, 'Hand-held': `drill, book`, Shoebox: `fits in a shoebox`, 'Carry-on': `suitcase-sized`, Large: `needs two hands`, Furniture: `needs two people` };
const MAX_PHOTOS = 6; // main + 5 more

/** Row of additional photos + an "add more" tile. `tiles` = [{ key, thumb }] */
function photoRowHtml(tiles, { canAdd = true } = {}) {
  return `<div class="pstrip">${tiles.map((t) => `<button type="button" class="ptile" data-view="${esc(t.key)}">${t.thumb ? `<img src="${t.thumb}" alt="Photo">` : `<span class="ph">${icon(`photo`)}</span>`}</button>`).join(``)}
    ${canAdd ? `<label class="ptile add"><input type="file" accept="image/*" multiple hidden data-xadd>${icon(`plus`)}<b>${tiles.length ? `More` : `More photos`}</b><small>other sides, labels, size</small></label>` : ``}</div>`;
}
function itemPhotoRowHtml(item) {
  const xs = repo.photosOf(item);
  return photoRowHtml(xs.map((p) => ({ key: p.pid, thumb: repo.thumbs[`x:${p.pid}`] })), { canAdd: xs.length + 1 < MAX_PHOTOS });
}
/** Up to 6 of the item's photos, reduced for AI (skips any this device can't read). */
async function itemAiImages(item, { skipCover = false } = {}) {
  const out = [];
  const add = async (getUrl) => { try { const url = await getUrl(); if (url) out.push(await shrinkForAi(await (await fetch(url)).blob())); } catch { /* skip */ } };
  if (!skipCover && (item.photoId || repo.thumbs[item.id])) await add(() => repo.photoObjectUrl(item));
  for (const p of repo.photosOf(item)) { if (out.length >= MAX_PHOTOS) break; await add(() => repo.extraPhotoUrl(p)); }
  return out;
}
const specLine = (r) => [r.model, r.details].filter(Boolean).join(` · `);

/** Saved item: look at all its photos and fill in what's missing. Never overwrites what's there; Undo restores. */
async function aiMergeIntoItem(itemId) {
  if (!aiReady() || !aiSettings().auto) return;
  const item = repo.items.find((i) => i.id === itemId); if (!item) return;
  try {
    const imgs = await itemAiImages(item); if (!imgs.length) return;
    toast(`Looking at ${imgs.length} photo${imgs.length > 1 ? `s` : ``}…`, { ms: 15000 });
    const r = await describeItem(imgs, item, { categories: repo.categories() });
    const cur = repo.items.find((i) => i.id === itemId); if (!cur) return;
    const patch = {}; const before = {}; const said = [];
    const mayChange = (k) => !String(cur[k] ?? ``).trim() || repo.fieldSetByAi(itemId, k); // empty, or AI's own earlier guess
    const fill = (k, v, label) => { if (v && mayChange(k) && String(cur[k] ?? ``) !== v) { patch[k] = v; before[k] = cur[k] || ``; said.push(label); } };
    fill(`purpose`, r.purpose, `what it’s for`); fill(`category`, r.category, `category`); fill(`size`, r.size, `size (${r.size})`); fill(`tags`, r.tags, `search words`);
    const line = specLine(r);
    if (line && !String(cur.notes || ``).toLowerCase().includes((r.model || line).toLowerCase())) {
      before.notes = cur.notes || ``; patch.notes = cur.notes ? `${cur.notes}\n${line}` : line; said.push(r.model ? `model ${r.model}` : `specs`);
    }
    if (!said.length) { toast(`AI found nothing new in the photos`); return; }
    await repo.saveItem({ id: itemId, ...patch }, { info: `Updated by AI (${imgs.length} photo${imgs.length > 1 ? `s` : ``}): ${said.join(`, `)}` });
    toast(`AI updated ${said.join(`, `)}. You can restore earlier text from History.`, { action: `Undo`, ms: 9000, onAction: () => repo.saveItem({ id: itemId, ...before }, { info: `Undid the AI update` }) });
  } catch (err) { toast(err instanceof AiError ? err.message : `AI couldn’t read the photos this time`, { ms: 5000 }); }
}

// ---------------- full-screen photos, inside the app (no Drive page, no second login); swipe between them
function photoViewer(item, startKey = `main`) {
  const slides = [];
  if (repo.thumbs[item.id] || item.photoId) slides.push({ key: `main`, label: `Photo`, thumb: repo.thumbs[item.id], load: () => repo.photoObjectUrl(item), url: item.photoUrl });
  for (const p of repo.photosOf(item)) {
    slides.push({ key: p.pid, pid: p.pid, label: `Photo`, thumb: repo.thumbs[`x:${p.pid}`], load: () => repo.extraPhotoUrl(p), url: p.url, removable: true });
  }
  if (!slides.length) return;
  let idx = Math.max(0, slides.findIndex((x) => x.key === startKey));
  const wrap = document.createElement(`div`);
  wrap.className = `viewer`;
  wrap.innerHTML = `<button type="button" class="viewer-x" aria-label="Close">${icon(`x`)}</button>
    <div class="viewer-stage"></div>
    ${slides.length > 1 ? `<button type="button" class="viewer-nav prev" aria-label="Previous">${icon(`back`)}</button><button type="button" class="viewer-nav next" aria-label="Next">${icon(`chevron`)}</button>` : ``}
    <div class="viewer-bar"><div class="viewer-cap"></div><span class="viewer-note"></span>
      ${slides.length > 1 ? `<div class="viewer-dots">${slides.map((_, i) => `<i data-i="${i}"></i>`).join(``)}</div>` : ``}</div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add(`open`));
  const stage = $(`.viewer-stage`, wrap); const note = $(`.viewer-note`, wrap); const cap = $(`.viewer-cap`, wrap);
  const close = () => { wrap.classList.remove(`open`); setTimeout(() => wrap.remove(), 200); document.removeEventListener(`keydown`, onKey); };
  const go = (d) => { idx = (idx + d + slides.length) % slides.length; show(); };
  const onKey = (e) => { if (e.key === `Escape`) close(); if (e.key === `ArrowRight`) go(1); if (e.key === `ArrowLeft`) go(-1); };
  document.addEventListener(`keydown`, onKey);
  let token = 0;
  const show = () => {
    const sl = slides[idx]; const my = ++token;
    stage.innerHTML = sl.thumb ? `<img src="${sl.thumb}" alt="${esc(item.name)} – ${esc(sl.label)}">` : `<div class="spinner"></div>`;
    cap.innerHTML = `<b>${esc(item.name)}</b>${slides.length > 1 ? ` · ${idx + 1} of ${slides.length}` : ``}${sl.removable ? ` <button type="button" class="link-light" data-remove>Remove</button>` : ``}`;
    note.textContent = ``;
    $$(`.viewer-dots i`, wrap).forEach((d, i) => d.classList.toggle(`on`, i === idx));
    sl.load().then((url) => {
      if (my !== token) return;
      if (url) { stage.innerHTML = `<img src="${url}" alt="${esc(item.name)} – ${esc(sl.label)}">`; return; }
      if (!sl.thumb) stage.innerHTML = `<p class="muted">Not uploaded yet.</p>`;
      else if (sl.url) note.innerHTML = `Preview only. The full photo is in ${esc((item.addedBy || `another member`).split(`@`)[0])}’s Drive. <a href="${esc(sl.url)}" target="_blank" rel="noopener">Open in Drive</a>`;
    }).catch((err) => {
      if (my !== token || !(err instanceof AuthError)) return;
      note.innerHTML = `<button type="button" class="btn small primary" data-load>Load full photo</button>`;
      $(`[data-load]`, note).onclick = async (ev) => { ev.stopPropagation(); note.textContent = `Loading…`; if (await renewNow()) show(); else note.textContent = `Couldn’t reach Google. Showing preview.`; };
    });
  };
  wrap.addEventListener(`click`, async (e) => {
    if (e.target.closest(`.viewer-nav.prev`)) return go(-1);
    if (e.target.closest(`.viewer-nav.next`)) return go(1);
    const dot = e.target.closest(`.viewer-dots i`); if (dot) { idx = Number(dot.dataset.i); return show(); }
    if (e.target.closest(`[data-remove]`)) {
      const sl = slides[idx];
      if (await confirmSheet(`Remove this photo?`, `The item keeps its other photos.`, `Remove`, true)) { close(); await repo.removeExtraPhoto(item.id, sl.pid); toast(`Photo removed`); }
      return;
    }
    if (e.target === wrap || e.target.closest(`.viewer-x`) || e.target.classList.contains(`viewer-stage`)) close();
  });
  let sx = null; // swipe left/right
  stage.addEventListener(`touchstart`, (e) => { if (e.touches.length === 1) sx = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener(`touchend`, (e) => { if (sx === null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50 && slides.length > 1) go(dx < 0 ? 1 : -1); });
  show();
}

// ---------------- item history
const fmtWhen = (iso) => {
  const d = new Date(iso); if (isNaN(d)) return ``;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: `short`, day: `numeric`, ...(sameYear ? {} : { year: `numeric` }), hour: `numeric`, minute: `2-digit` });
};
const whoName = (email) => (!email || email === repo.user.email ? `` : (repo.members.find((m) => m.email === email)?.email || email).split(`@`)[0]);
const ACTION_ICON = { added: `plus`, moved: `move`, lent: `lend`, returned: `ret`, reserved: `clock`, unreserved: `x`, missing: `alert`, found: `check`, removed: `trash`, edited: `edit` };

/** One log entry → { icon, title, note }. `prev` is the entry before it (older), to spot pickups. */
function describeEntry(e, prev) {
  const due = /due (\d{4}-\d{2}-\d{2})/.exec(e.info || ``)?.[1];
  const person = (n) => `<button type="button" class="person-link" data-person="${esc(Repo.personKey(n))}">${esc(n)}</button>`;
  switch (true) {
    case e.action === `added`: return { title: `Added${e.detail ? ` to ${esc(e.detail)}` : ``}` };
    case e.action === `moved`: return { title: `Moved to ${esc(e.detail || `no location`)}`, note: e.info ? esc(e.info.replace(/^from /, `From `)) : `` };
    case e.action === `lent`: {
      const picked = prev?.action === `reserved` && Repo.personKey(prev.detail) === Repo.personKey(e.detail);
      return { title: `${picked ? `Picked up by` : `Lent to`} ${person(e.detail)}` };
    }
    case e.action === `returned`: return { title: e.detail ? `Returned by ${person(e.detail)}` : `Returned` };
    case e.action === `reserved`: return { title: `Reserved for ${person(e.detail)}`, note: due ? `Pick up by ${esc(new Date(`${due}T00:00`).toLocaleDateString(undefined, { weekday: `short`, month: `short`, day: `numeric` }))}` : `` };
    case e.action === `unreserved`: return { title: `No longer reserved for ${e.detail ? person(e.detail) : `them`}` };
    case e.action === `missing`: return { title: `Marked missing` };
    case e.action === `found`: return { title: `Found` };
    case e.action === `removed`: return { title: `Removed from inventory` };
    case e.action === `edited`: return { title: `Edited`, note: esc(e.info || ``) };
    case /^qty\+\d+$/.test(e.action): return { title: `Added ${esc(e.action.slice(4))} more`, icon: `plus` };
    default: return { title: esc(e.action) };
  }
}

const FIELD_LABEL = { name: `Name`, purpose: `What it’s for`, category: `Category`, size: `Size`, tags: `Search words`, qty: `How many`, warranty: `Warranty until`, expiry: `Expires`, notes: `Notes` };

function itemHistoryHtml(item) {
  const hist = repo.itemHistory(item.id);
  if (!hist.length) return ``;
  const SHOW = 5;
  const rows = hist.map((e, i) => {
    const d = describeEntry(e, hist[i + 1]);
    const who = whoName(e.by);
    const ch = Repo.parseChanges(e.changes); delete ch._ai;
    const fields = Object.keys(ch).filter((f) => FIELD_LABEL[f]);
    const diff = fields.length ? `<div class="ih-diff">${fields.map((f) => `<div class="ih-change">
        <div class="ih-field">${esc(FIELD_LABEL[f])}</div>
        <div class="ih-old">${ch[f][0] ? esc(ch[f][0]) : `<i>empty</i>`}</div>
        <div class="ih-new">${ch[f][1] ? esc(ch[f][1]) : `<i>empty</i>`}</div>
        <button type="button" class="btn ghost small" data-useold="${esc(e.ts)}" data-field="${f}">Restore</button></div>`).join(``)}
      ${fields.length > 1 ? `<button type="button" class="link small" data-useold="${esc(e.ts)}" data-field="*">Restore all</button>` : ``}</div>` : ``;
    const title = fields.length && /^(AI\b|Updated by AI)/.test(e.info || ``) ? `${icon(`spark`)} ${esc(e.info.split(`:`)[0].replace(/^AI from (.+)$/, `Updated by AI ($1)`))}` : d.title;
    return `<div class="ih-row${i >= SHOW ? ` extra` : ``}">
      <span class="ih-ic">${icon(d.icon || ACTION_ICON[e.action] || `edit`)}</span>
      <div><div class="ih-title">${title}</div>${diff || (d.note ? `<div class="ih-note">${d.note}</div>` : ``)}
        <small>${esc(fmtWhen(e.ts))}${who ? ` · by ${esc(who)}` : ``}</small></div></div>`;
  }).join(``);
  return `<div class="label-sm">History</div><div class="ih">${rows}</div>
    ${hist.length > SHOW ? `<button type="button" class="btn ghost small" data-hist-all>Show all ${hist.length}</button>` : ``}`;
}

function historyState(h) {
  if (h.lentAt && !h.returnedAt) return `open`;
  if (h.savedAt && !h.lentAt && !h.cancelledAt) return `saved`;
  if (h.cancelledAt && !h.lentAt) return `cancelled`;
  return ``;
}
function historyText(h) {
  const parts = [];
  if (h.savedAt) parts.push(`Reserved ${fmtDate(h.savedAt)}${h.dueAt ? ` (by ${fmtDate(`${h.dueAt}T12:00`)})` : ``}`);
  if (h.lentAt) {
    const lateBy = h.dueAt ? Math.round((new Date(String(h.lentAt).slice(0, 10) + `T00:00`) - new Date(`${h.dueAt}T00:00`)) / 86400000) : 0;
    parts.push(`${h.savedAt ? `picked up` : `lent`} ${fmtDate(h.lentAt)}${lateBy > 0 ? ` (${dayText(lateBy)} late)` : ``}`);
  }
  if (h.cancelledAt && !h.lentAt) parts.push(`cancelled ${fmtDate(h.cancelledAt)}`);
  else if (h.savedAt && !h.lentAt) {
    const d = dueText(h.item?.dueAt); parts.push(d.text ? `waiting, ${d.text}` : `waiting for pickup`);
  } else if (h.returnedAt) {
    const n = daysBetween(h.lentAt, h.returnedAt);
    parts.push(`${h.how && h.how !== `returned` ? `closed` : `returned`} ${fmtDate(h.returnedAt)} (${n === 0 ? `same day` : dayText(n)})`);
  } else if (h.lentAt) parts.push(`still out, ${dayText(daysBetween(h.lentAt))}`);
  const s = parts.join(` → `);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Person card: what they have now + lend/return history. */
function personSheet(key) {
  const person = repo.people().find((p) => p.key === key);
  if (!person) return toast(`No lending history for that name yet`);
  sheet(person.name, (el, close) => {
    const draw = () => {
      const p = repo.people().find((x) => x.key === key) || { ...person, holding: [], saved: [] };
      const hist = repo.personHistory(key);
      const sinceOf = (id) => hist.find((h) => h.itemId === id && h.lentAt && !h.returnedAt)?.lentAt;
      const borrowed = hist.filter((h) => h.lentAt).length;
      const summary = [p.holding.length ? `Has ${p.holding.length} item${p.holding.length > 1 ? `s` : ``} now` : `Has nothing of yours now`,
        p.saved.length ? `${p.saved.length} reserved` : ``, borrowed ? `borrowed ${borrowed} time${borrowed === 1 ? `` : `s`}` : ``].filter(Boolean).join(` · `);
      el.innerHTML = `
        <div class="person-head"><span class="avatar">${esc(initials(p.name))}</span>
          <div><b>${esc(p.name)}</b><small>${esc(summary)}</small></div></div>
        ${p.saved.length ? `<div class="label-sm">Reserved for ${esc(p.name)}</div>
          <div class="list">${p.saved.map((it) => { const d = dueText(it.dueAt); return `<div class="list-row hold-row">
              ${thumbHtml(it, `thumb sm`)}
              <button type="button" class="hold-main" data-open="${esc(it.id)}"><b>${esc(it.name)}</b><small class="${d.late ? `late` : ``}">${esc(d.text || `no pick-up date`)} · ${esc(repo.pathText(it.locationId) || `no location`)}</small></button>
              <button type="button" class="icon-btn" data-unsave="${esc(it.id)}" aria-label="Cancel">${icon(`x`)}</button>
              <button type="button" class="btn ghost small" data-pick="${esc(it.id)}">Picked up</button>
            </div>`; }).join(``)}</div>
          ${p.saved.length > 1 ? `<div class="row-actions"><button type="button" class="btn primary" data-pickall>Picked up everything</button></div>` : ``}` : ``}
        ${p.holding.length ? `<div class="label-sm">Has now</div>
          <div class="list">${p.holding.map((it) => `<div class="list-row hold-row">
              ${thumbHtml(it, `thumb sm`)}
              <button type="button" class="hold-main" data-open="${esc(it.id)}"><b>${esc(it.name)}</b><small>since ${esc(fmtDate(sinceOf(it.id)) || `unknown`)}${sinceOf(it.id) ? ` · ${dayText(daysBetween(sinceOf(it.id)))}` : ``}</small></button>
              <button type="button" class="btn ghost small" data-back="${esc(it.id)}">Got it back</button>
            </div>`).join(``)}</div>
          ${p.holding.length > 1 ? `<div class="row-actions"><button type="button" class="btn primary" data-all>Got everything back</button></div>` : ``}` : ``}
        <div class="label-sm">History</div>
        ${hist.length ? `<div class="timeline">${hist.map((h) => `<div class="tl-row ${historyState(h)}">
            <i></i>
            <div><button type="button" class="link-plain" ${h.item ? `data-open="${esc(h.itemId)}"` : `disabled`}>${esc(h.itemName)}</button>
              <small>${esc(historyText(h))}</small></div>
          </div>`).join(``)}</div>` : `<p class="muted">No history yet.</p>`}`;
    };
    el.onclick = async (e) => {
      const b = e.target.closest(`button`); if (!b) return;
      if (b.dataset.open) { close(); location.hash = `#/item/${b.dataset.open}`; return; }
      if (b.dataset.back) {
        const it = repo.items.find((i) => i.id === b.dataset.back);
        if (it) { await repo.returnItem(it); toast(`${it.name} returned`); draw(); }
        return;
      }
      if (b.dataset.pick) {
        const it = repo.items.find((i) => i.id === b.dataset.pick);
        if (it) { await repo.pickUp(it); toast(`${it.name} is now lent to ${it.lentTo}`); draw(); }
        return;
      }
      if (b.dataset.unsave) {
        const it = repo.items.find((i) => i.id === b.dataset.unsave);
        if (it) { await repo.cancelReservation(it); toast(`No longer reserved for ${person.name}`); draw(); }
        return;
      }
      if (b.hasAttribute(`data-pickall`)) {
        const p = repo.people().find((x) => x.key === key);
        for (const it of p?.saved || []) await repo.pickUp(it);
        toast(`${person.name} picked up everything`); draw(); return;
      }
      if (b.hasAttribute(`data-all`)) {
        const p = repo.people().find((x) => x.key === key);
        for (const it of p?.holding || []) await repo.returnItem(it);
        toast(`Everything is back from ${person.name}`); draw();
      }
    };
    draw();
  }, { onClose: () => render() });
}

// ============================================================ Find (landing dashboard + search)
function viewFind(view) {
  const cats = repo.categories();
  { // drop a filter whose chip no longer exists
    const f = findState.filter;
    if ([`lent`, `reserved`, `missing`].includes(f) && !repo.activeItems().some((i) => i.status === f)) findState.filter = ``;
    if (f.startsWith(`cat:`) && !cats.includes(f.slice(4))) findState.filter = ``;
  }
  const first = (repo.user?.name || ``).split(` `)[0];
  const hr = new Date().getHours();
  const hello = `${hr < 12 ? `Good morning` : hr < 18 ? `Good afternoon` : `Good evening`}${first ? `, ${first}` : ``}`;
  view.innerHTML = `
    <div class="find-top" id="find-top">
      <div class="hello"><small>${esc(hello)}</small><h1>Your things</h1></div>
      <div class="search-wrap">
        <label class="search">${icon(`search`)}<input id="q" type="search" placeholder="Search, e.g. fix a leak" value="${esc(findState.q)}" autocomplete="off" enterkeyhint="search">
          <button type="button" class="icon-btn search-qr" id="scanlabel" aria-label="Scan a box or shelf label">${icon(`qr`)}</button></label>
      </div>
      ${cats.length ? `<div class="chips scroll" id="filters">${cats.map((c) => `<button class="chip" data-f="cat:${esc(c)}">${esc(c)}</button>`).join(``)}</div>` : `<div id="filters"></div>`}
    </div>
    <div id="results"></div>`;
  const q = $(`#q`); const top = $(`#find-top`);
  // Category chips only while searching, so the landing page stays calm.
  const searching = () => top.classList.toggle(`searching`, document.activeElement === q || Boolean(findState.q.trim() || findState.filter.startsWith(`cat:`)));
  q.addEventListener(`focus`, searching);
  q.addEventListener(`blur`, () => setTimeout(searching, 250)); // let a chip tap land first
  q.addEventListener(`input`, () => { findState.q = q.value; renderResults(); });
  $(`#scanlabel`).addEventListener(`click`, (e) => { e.preventDefault(); scanLabelFlow(); });
  $(`#results`).addEventListener(`click`, async (e) => {
    const p = e.target.closest(`[data-person]`); if (p) { e.preventDefault(); return personSheet(p.dataset.person); }
    const s = e.target.closest(`[data-show]`); if (s) { e.preventDefault(); findState.filter = s.dataset.show; renderResults(); return window.scrollTo(0, 0); }
    const q2 = e.target.closest(`[data-quick]`);
    if (q2) {
      e.preventDefault();
      const it = repo.items.find((x) => x.id === q2.dataset.id); if (!it) return;
      if (q2.dataset.quick === `return`) { await repo.returnItem(it); toast(`${it.name} returned`); }
      else if (q2.dataset.quick === `pickup`) { await repo.pickUp(it); toast(`Lent to ${it.lentTo}`); }
      else if (q2.dataset.quick === `found`) { await repo.markFound(it); toast(`Found`); }
      renderResults();
    }
  });
  $(`#filters`).addEventListener(`click`, (e) => {
    const b = e.target.closest(`[data-f]`); if (!b) return;
    findState.filter = findState.filter === b.dataset.f ? `` : b.dataset.f;
    renderResults(); searching();
  });
  searching();
  renderResults();
}

/** A soft colour per word, so tiles without photos still look intentional (and differ from each other). */
const TINTS = [150, 35, 265, 12, 205, 60, 330, 95];
function tintOf(text) {
  let h = 7; for (const ch of String(text || ``)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}
function tileImg(item, cls) {
  const t = repo.thumbs[item.id];
  return t ? `<img class="${cls}" src="${t}" alt="" loading="lazy">`
    : `<div class="${cls} tint" style="--h:${tintOf(item.id || item.name)}">${icon(`box`)}</div>`;
}

function renderResults() {
  const box = $(`#results`); if (!box) return;
  const sig = repo.categories().join();
  if (box.dataset.sig && box.dataset.sig !== sig) { box.dataset.sig = ``; return viewFind($(`#view`)); } // chips changed
  box.dataset.sig = sig;
  $$(`#filters [data-f]`).forEach((b) => b.classList.toggle(`on`, b.dataset.f === findState.filter));
  const all = repo.activeItems();
  const f = findState.filter; const q = findState.q.trim();
  $(`#find-top`)?.classList.toggle(`busy`, Boolean(q || f));

  if (!all.length) {
    const noPlaces = !repo.locations.some((l) => !l.deleted);
    box.innerHTML = `<div class="empty">${icon(`box`, `big`)}<h3>Nothing here yet</h3>
      ${noPlaces ? `<p>Start by telling Paran where you keep things. It takes 30 seconds.</p><a class="btn primary" href="#/setup">${icon(`place`)} Set up your places</a>`
        : `<p>Add the first thing you always end up hunting for.</p><a class="btn primary" href="#/add">${icon(`plus`)} Add an item</a>`}</div>`;
    return;
  }

  if (q || f) { // search / filter results
    let list = all;
    if ([`lent`, `missing`, `reserved`].includes(f)) list = list.filter((i) => i.status === f);
    else if (f.startsWith(`cat:`)) list = list.filter((i) => i.category === f.slice(4));
    list = q ? search(list, q, (id) => repo.pathText(id))
      : f === `recent` ? [...list].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))
      : [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (q && !list.length) {
      box.innerHTML = `<div class="empty"><h3>No match for “${esc(q)}”</h3><p>Looks like you don’t have it logged. Maybe you don’t have one, or it hasn’t been added yet.</p><a class="btn ghost" href="#/add?name=${encodeURIComponent(q)}">${icon(`plus`)} Add “${esc(q)}”</a></div>`;
      return;
    }
    const title = !q && f === `all` ? `All items · ${list.length}` : !q && f === `recent` ? `Recently added` : `${list.length} found`;
    const back = !q && (f === `all` || f === `recent`) ? `<button type="button" class="link small" data-show="">${icon(`back`)} Home</button>` : ``;
    box.innerHTML = `<div class="list-head"><div class="label-sm">${back}${esc(title)}</div><button type="button" class="link small" data-select-toggle>${sel.on ? `Done` : `Select`}</button></div>
      <div class="cards">${list.slice(0, 300).map((i) => itemCard(i)).join(``)}</div>`;
    return;
  }

  // ---- dashboard (cards)
  const attention = all.map((i) => ({ i, r: attentionReason(i) })).filter((x) => x.r).sort((a, b) => a.r.rank - b.r.rank);
  const out = repo.people().filter((p) => p.holding.length || p.saved.length);
  const outCount = all.filter((i) => i.status === `lent` || i.status === `reserved`).length;
  const late = attention.filter((x) => x.r.urgent).length;
  const placeCount = repo.locations.filter((l) => !l.deleted).length;
  const recent = [...all].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt))).slice(0, 10);
  const live = repo.locations.filter((l) => !l.deleted);
  let rooms = live.filter((l) => l.parentId && !repo.locById(l.parentId)?.parentId); // second level: Garage, Kitchen…
  if (rooms.filter((l) => repo.itemsIn(l.id, true).length).length < 2) rooms = live.filter((l) => !l.parentId); // only top-level places so far
  rooms = rooms.map((l) => ({ l, items: repo.itemsIn(l.id, true) })).filter((x) => x.items.length).sort((a, b) => b.items.length - a.items.length).slice(0, 6);
  const mosaic = (items, l) => {
    const pick = [...items.filter((i) => repo.thumbs[i.id]), ...items.filter((i) => !repo.thumbs[i.id])].slice(0, 3);
    while (pick.length < 3) pick.push(null);
    return pick.map((i, k) => (i ? tileImg(i, `m${k}`) : `<div class="m${k} tint" style="--h:${tintOf(`${l.id}${k}`)}"></div>`)).join(``);
  };
  const quick = (i) => i.status === `lent` ? [`return`, `Got it back`] : i.status === `reserved` ? [`pickup`, `Picked up`] : i.status === `missing` ? [`found`, `Found it`] : null;
  const personLine = (p) => {
    const lateN = [...p.holding, ...p.saved].filter((i) => attentionReason(i)?.urgent).length;
    const bits = [];
    if (p.holding.length) bits.push(`${p.holding.length} item${p.holding.length > 1 ? `s` : ``}`);
    if (p.saved.length) bits.push(p.holding.length ? `${p.saved.length} reserved` : (dueText(p.saved[0].dueAt).text ? `Reserved · ${dueText(p.saved[0].dueAt).text}` : `${p.saved.length} reserved`));
    if (lateN) bits.push(`${lateN} late`);
    return bits.join(` · `);
  };
  box.innerHTML = `
    <div class="stats">
      <button type="button" class="stat" data-show="all"><b>${all.length}</b><span>Item${all.length === 1 ? `` : `s`}</span></button>
      <a class="stat${late ? ` warn` : ``}" href="#/out"><b>${outCount}</b><span>Out${late ? ` · ${late} late` : ``}</span></a>
      <a class="stat" href="#/places"><b>${placeCount}</b><span>Place${placeCount === 1 ? `` : `s`}</span></a>
    </div>
    ${attention.length ? `<div class="alerts">${attention.slice(0, 3).map(({ i, r }) => { const a = quick(i); return `
      <a class="alert-card${r.urgent ? ` urgent` : ``}" href="#/item/${esc(i.id)}">${tileImg(i, `thumb sm`)}
        <div><b>${esc(i.name)}</b><small>${esc(r.text)}</small></div>
        ${a ? `<button type="button" class="btn small ghost" data-quick="${a[0]}" data-id="${esc(i.id)}">${a[1]}</button>` : ``}</a>`; }).join(``)}
      ${attention.length > 3 ? `<a class="link small" href="#/out">See all ${attention.length}</a>` : ``}</div>` : ``}
    ${rooms.length ? `<section class="dash"><div class="dash-head"><h2>Places</h2><a class="link small" href="#/places">All places</a></div>
      <div class="place-tiles">${rooms.map(({ l, items }) => `<a class="place-tile" href="#/place/${esc(l.id)}">
        <div class="mosaic">${mosaic(items, l)}</div>
        <div class="pt-name"><b>${esc(l.name)}</b><span>${items.length} item${items.length === 1 ? `` : `s`}</span></div></a>`).join(``)}</div></section>` : ``}
    ${out.length ? `<section class="dash"><div class="dash-head"><h2>Out now</h2><a class="link small" href="#/out">See all</a></div>
      <div class="hscroll">${out.map((p) => `<button type="button" class="person-card" data-person="${esc(p.key)}">
        <span class="avatar">${esc(initials(p.name))}</span><span><b>${esc(p.name)}</b><small>${esc(personLine(p))}</small></span></button>`).join(``)}</div></section>` : ``}
    <section class="dash"><div class="dash-head"><h2>Recently added</h2><button type="button" class="link small" data-show="recent">See all</button></div>
      <div class="hscroll">${recent.map((i) => { const parts = repo.pathOf(i.locationId).slice(-2).map((l) => l.name).join(` › `); return `
        <a class="item-tile" href="#/item/${esc(i.id)}">${tileImg(i, `it-img`)}
          <div class="it-name"><b>${esc(i.name)}</b><span>${esc(parts || `No location yet`)}</span></div></a>`; }).join(``)}</div></section>`;
}

// ============================================================ First-run setup: places in 30 seconds
const SETUP_TOP = [`Home`, `Storage unit`, `Office`, `Car`, `Cabin`];
const SETUP_ROOMS = {
  Home: [`Garage`, `Kitchen`, `Basement`, `Attic`, `Living room`, `Bedroom`, `Kids’ room`, `Office`, `Closet`, `Laundry`, `Bathroom`, `Shed`],
  'Storage unit': [`Shelf 1`, `Shelf 2`, `Boxes`],
  Office: [`Desk`, `Cabinet`, `Supply closet`],
  Car: [`Trunk`, `Glovebox`],
  Cabin: [`Kitchen`, `Bedroom`, `Shed`],
};
function viewSetup(view) {
  const existingTop = repo.childrenOf(``);
  const picked = new Map(); // top name -> Set(rooms)
  if (!existingTop.length) picked.set(`Home`, new Set([`Garage`, `Kitchen`]));
  else existingTop.forEach((l) => picked.set(l.name, new Set()));
  const extraTop = existingTop.map((l) => l.name).filter((n) => !SETUP_TOP.includes(n));
  const has = (top, room) => { const t = existingTop.find((l) => l.name.toLowerCase() === top.toLowerCase()); return Boolean(t && repo.childrenOf(t.id).some((c) => c.name.toLowerCase() === room.toLowerCase())); };
  const draw = () => {
    const tops = [...SETUP_TOP, ...extraTop, ...[...picked.keys()].filter((k) => !SETUP_TOP.includes(k) && !extraTop.includes(k))];
    const n = [...picked.entries()].reduce((sum, [top, rooms]) => sum + (existingTop.some((l) => l.name === top) ? 0 : 1) + [...rooms].filter((r) => !has(top, r)).length, 0);
    view.innerHTML = `<div class="setup">
      <div class="form-head"><button type="button" class="back" data-a="cancel">${icon(`x`)} ${existingTop.length ? `Close` : `Skip for now`}</button></div>
      <h1>Where do you keep things?</h1>
      <p class="muted">Tap what applies. You can rename, move or add more any time.</p>
      <div class="chips big">${tops.map((t) => `<button type="button" class="chip ${picked.has(t) ? `on` : ``}" data-top="${esc(t)}">${picked.has(t) ? icon(`check`) : ``}${esc(t)}</button>`).join(``)}
        <button type="button" class="chip add" data-addtop>${icon(`plus`)} Other</button></div>
      ${[...picked.keys()].map((top) => { const rooms = [...new Set([...(SETUP_ROOMS[top] || []), ...picked.get(top)])]; return `
        <div class="label-sm">Inside ${esc(top)}</div>
        <div class="chips">${rooms.map((r) => { const done = has(top, r); const on = done || picked.get(top).has(r); return `<button type="button" class="chip ${on ? `on` : ``}" data-top-of="${esc(top)}" data-room="${esc(r)}" ${done ? `disabled title="Already added"` : ``}>${on ? icon(`check`) : ``}${esc(r)}</button>`; }).join(``)}
          <button type="button" class="chip add" data-addroom="${esc(top)}">${icon(`plus`)} Other</button></div>`; }).join(``)}
      <div class="form-actions"><button type="button" class="btn primary big" data-a="create" ${n ? `` : `disabled`}>${n ? `Add ${n} place${n > 1 ? `s` : ``}` : `Pick at least one`}</button></div>
    </div>`;
  };
  view.onclick = async (e) => {
    const b = e.target.closest(`button`); if (!b) return;
    if (b.dataset.a === `cancel`) return goBack(`#/places`);
    if (b.dataset.top) { const t = b.dataset.top; if (picked.has(t)) { if (!existingTop.some((l) => l.name === t)) picked.delete(t); } else picked.set(t, new Set()); return draw(); }
    if (b.dataset.room) { const set = picked.get(b.dataset.topOf); if (set.has(b.dataset.room)) set.delete(b.dataset.room); else set.add(b.dataset.room); return draw(); }
    if (b.hasAttribute(`data-addtop`)) { const name = await promptSheet(`Another place`, { label: `Name`, placeholder: `e.g. Parents’ house, Boat`, okLabel: `Add` }); if (name) picked.set(name, new Set()); return draw(); }
    if (b.dataset.addroom) { const name = await promptSheet(`Inside ${b.dataset.addroom}`, { label: `Name`, placeholder: `e.g. Pantry, Workbench`, okLabel: `Add` }); if (name) picked.get(b.dataset.addroom).add(name); return draw(); }
    if (b.dataset.a === `create`) {
      let made = 0; let firstRoom = null;
      for (const [top, rooms] of picked) {
        let t = existingTop.find((l) => l.name.toLowerCase() === top.toLowerCase());
        if (!t) { t = repo.saveLocation({ name: top, parentId: ``, kind: `place` }); made++; }
        for (const r of rooms) {
          if (repo.childrenOf(t.id).some((c) => c.name.toLowerCase() === r.toLowerCase())) continue;
          const room = repo.saveLocation({ name: r, parentId: t.id, kind: `room` }); made++; firstRoom ||= room;
        }
      }
      if (firstRoom) rememberLoc(firstRoom.id);
      toast(`Added ${made} place${made === 1 ? `` : `s`}. Now add something you always hunt for.`);
      location.hash = `#/places`;
    }
  };
  draw();
}

// ============================================================ Out (lent + reserved, by person)
function viewOut(view) {
  const people = repo.people();
  const active = people.filter((p) => p.holding.length || p.saved.length);
  const past = people.filter((p) => !p.holding.length && !p.saved.length);
  const late = repo.activeItems().filter((i) => attentionReason(i)?.urgent);
  const nOut = active.reduce((n, p) => n + p.holding.length + p.saved.length, 0);
  const since = lentSinceMap();
  view.innerHTML = `
    <div class="out">
      <h1>Out</h1>
      <p class="muted">${nOut ? `${nOut} item${nOut > 1 ? `s` : ``} with ${active.length} ${active.length > 1 ? `people` : `person`}` : `Nothing is lent or reserved right now.`}</p>
      ${late.length ? `<div class="label-sm">Overdue pick-ups</div><div class="cards">${late.map((i) => itemCard(i, { reason: attentionReason(i) })).join(``)}</div>` : ``}
      ${active.length ? `<div class="label-sm">By person</div><div class="person-cards">${active.map((p) => {
        const items = [...p.holding, ...p.saved];
        const oldest = p.holding.map((i) => since.get(i.id)).filter(Boolean).sort()[0];
        const lateN = p.saved.filter((i) => dueText(i.dueAt).late).length;
        return `<button type="button" class="person-card" data-person="${esc(p.key)}">
          <span class="avatar">${esc(initials(p.name))}</span>
          <div class="pc-main"><b>${esc(p.name)}</b>
            <small>${[p.holding.length ? `has ${p.holding.length}` : ``, p.saved.length ? `${p.saved.length} reserved` : ``].filter(Boolean).join(` · `)}${oldest ? ` · oldest ${dayText(daysBetween(oldest))}` : ``}${lateN ? ` · <em>${lateN} pick-up late</em>` : ``}</small>
            <span class="pc-items">${items.slice(0, 4).map((i) => esc(i.name)).join(`, `)}${items.length > 4 ? ` +${items.length - 4}` : ``}</span></div>
          ${icon(`chevron`)}</button>`; }).join(``)}</div>`
        : `<div class="empty">${icon(`lend`, `big`)}<p>Use <b>Lend or reserve</b> on any item to keep track of who has it.</p></div>`}
      ${past.length ? `<div class="label-sm">Past borrowers</div><div class="chips">${past.map((p) => `<button type="button" class="chip" data-person="${esc(p.key)}">${esc(p.name)}</button>`).join(``)}</div>` : ``}
    </div>`;
  view.onclick = (e) => { const b = e.target.closest(`[data-person]`); if (b) { e.preventDefault(); personSheet(b.dataset.person); } };
}

// ============================================================ Item detail
function viewItem(view, r) {
  const item = repo.items.find((i) => i.id === r.id && !i.deleted);
  if (!item) { view.innerHTML = `<div class="empty"><h3>Item not found</h3><a class="btn ghost" href="#/">Back</a></div>`; return; }
  const personBtn = `<button type="button" class="person-link" data-person="${esc(Repo.personKey(item.lentTo))}">${esc(item.lentTo || `someone`)}</button>`;
  const due = dueText(item.dueAt);
  const status = item.status === `lent` ? `<div class="banner lent">${icon(`lend`)}<div class="grow"><span>Lent to ${personBtn}</span>${lentSinceText(item)}</div></div>`
    : item.status === `reserved` ? `<div class="banner reserved${due.late ? ` late` : ``}">${icon(`clock`)}<div class="grow"><span>Reserved for ${personBtn}</span>${due.text ? `<small>${esc(due.text)}</small>` : ``}</div>
        <button type="button" class="btn text small" data-a="unsave">Cancel reservation</button></div>`
    : item.status === `missing` ? `<div class="banner missing">${icon(`alert`)} Marked missing</div>` : ``;
  const tags = String(item.tags || ``).split(`,`).map((t) => t.trim()).filter(Boolean);
  const hasPhoto = Boolean(repo.thumbs[item.id] || item.photoId);
  // the two things people do most, front and centre
  const second = item.status === `lent` ? `<button class="btn primary big" data-a="return">${icon(`ret`)} Got it back</button>`
    : item.status === `reserved` ? `<button class="btn primary big" data-a="pickup">${icon(`check`)} Picked up</button>`
    : item.status === `missing` ? `<button class="btn primary big" data-a="found">${icon(`check`)} Found it</button>`
    : `<button class="btn ghost big" data-a="lend">${icon(`lend`)} Lend or reserve</button>`;
  view.innerHTML = `
    <div class="detail">
      <div class="detail-top">
        <button type="button" class="back" data-a="back">${icon(`back`)} Back</button>
        <div class="detail-tools">
          <button type="button" class="icon-btn" data-a="share" aria-label="Share">${icon(`share`)}</button>
          <a class="icon-btn" href="#/edit/${esc(item.id)}" aria-label="Edit">${icon(`edit`)}</a>
          <button type="button" class="icon-btn" data-a="menu" aria-label="More actions">${icon(`more`)}</button>
        </div>
      </div>
      ${hasPhoto ? `<div class="hero zoomable">${thumbHtml(item, `hero-img`)}</div>`
        : `<label class="add-photo"><input type="file" accept="image/*" capture="environment" hidden data-addphoto>${icon(`camera`)}<span>Add a photo</span></label>`}
      ${hasPhoto ? itemPhotoRowHtml(item) : ``}
      <h1>${esc(item.name)}${Number(item.qty) > 1 ? ` <span class="qty">×${esc(item.qty)}</span>` : ``}</h1>
      ${status}
      <div class="where"><div class="label-sm">Where</div><div class="crumbs">${crumbs(item.locationId)}</div></div>
      <div class="main-actions">
        <button class="btn ghost big" data-a="move">${icon(`move`)} Move</button>
        ${second}
      </div>
      ${item.purpose ? `<div class="block"><div class="label-sm">What it’s for</div><p>${esc(item.purpose)}</p></div>` : ``}
      <div class="facts">
        ${item.size ? `<div><span>Size</span><b>${esc(item.size)}</b></div>` : ``}
        ${item.category ? `<div><span>Category</span><b>${esc(item.category)}</b></div>` : ``}
        ${item.warranty ? `<div><span>Warranty until</span><b>${esc(item.warranty)}</b></div>` : ``}
        ${item.expiry ? `<div><span>Expires</span><b>${esc(item.expiry)}</b></div>` : ``}
        <div><span>Added</span><b>${esc(timeAgo(item.addedAt))}${item.addedBy && item.addedBy !== repo.user.email ? ` by ${esc(item.addedBy.split(`@`)[0])}` : ``}</b></div>
      </div>
      ${tags.length ? `<div class="chips">${tags.map((t) => `<a class="chip" href="#/?q" data-tag="${esc(t)}">${esc(t)}</a>`).join(``)}</div>` : ``}
      ${item.notes ? `<div class="block"><div class="label-sm">Notes</div><p class="pre">${esc(item.notes)}</p></div>` : ``}
      ${itemHistoryHtml(item)}
    </div>`;

  // Full-size photo from the phone's cache or Drive; tap to view it full screen.
  if (hasPhoto) repo.photoObjectUrl(item).then((url) => {
    if (!url) return;
    const img = $(`.hero-img`, view);
    if (img?.tagName === `IMG`) img.src = url; else $(`.hero`, view).innerHTML = `<img class="hero-img" src="${url}" alt="">`;
  }).catch(() => { /* not signed in right now: thumbnail stays */ });

  $(`[data-xadd]`, view)?.addEventListener(`change`, async (e) => {
    const files = [...(e.target.files || [])]; if (!files.length) return;
    let added = 0; let capped = false;
    for (const file of files) {
      if (repo.photosOf(repo.items.find((i) => i.id === item.id)).length + 1 >= MAX_PHOTOS) { capped = true; break; }
      try { if (await repo.addExtraPhoto(item.id, await processExtraPhoto(file))) added++; } catch { toast(`Couldn’t read one of the photos`); }
    }
    const capNote = capped ? ` (${MAX_PHOTOS} is the most per item)` : ``;
    if (added) { toast(`${added} photo${added > 1 ? `s` : ``} added${capNote}`); aiMergeIntoItem(item.id); }
    else if (capped) toast(`An item can have up to ${MAX_PHOTOS} photos`);
  });

  $(`[data-addphoto]`, view)?.addEventListener(`change`, async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const { photo, thumb } = await processPhoto(file); await repo.saveItem({ id: item.id }, { photo, thumb, logAction: `edited`, info: `New photo` }); toast(`Photo added`); aiMergeIntoItem(item.id); }
    catch { toast(`Couldn’t read that photo`); }
  });

  view.onclick = async (e) => {
    const tag = e.target.closest(`[data-tag]`);
    if (tag) { e.preventDefault(); findState = { q: tag.dataset.tag, filter: `` }; location.hash = `#/`; return; }
    const who = e.target.closest(`[data-person]`);
    if (who) { personSheet(who.dataset.person); return; }
    if (e.target.closest(`.hero.zoomable`)) { photoViewer(item, `main`); return; }
    const pv = e.target.closest(`[data-view]`); if (pv) { photoViewer(item, pv.dataset.view); return; }
    const uo = e.target.closest(`[data-useold]`);
    if (uo) { location.hash = `#/edit/${item.id}?restore=${encodeURIComponent(uo.dataset.useold)}&f=${uo.dataset.field}`; return; }
    if (e.target.closest(`[data-hist-all]`)) { $(`.ih`, view).classList.add(`all`); e.target.closest(`[data-hist-all]`).remove(); return; }
    const b = e.target.closest(`[data-a]`); if (!b) return;
    const a = b.dataset.a;
    if (a === `back`) goBack(`#/`);
    else if (a === `menu`) itemMenu(item);
    else if (a === `share`) shareItem(item);
    else if (a === `move`) {
      const id = await pickLocation(item.locationId, `Move to…`);
      if (id) await moveWithUndo([item], id);
    } else if (a === `lend`) {
      await lendOrSave(item);
    } else if (a === `pickup`) {
      await repo.pickUp(item); toast(`Lent to ${item.lentTo}`);
    } else if (a === `unsave`) {
      const who = item.lentTo; const was = item.dueAt;
      await repo.cancelReservation(item);
      toast(`No longer reserved for ${who}`, { action: `Undo`, ms: 6000, onAction: () => repo.reserveItem(item, who, was) });
    } else if (a === `return`) { await repo.returnItem(item); toast(`Returned`); }
    else if (a === `found`) { await repo.markFound(item); toast(`Found`); }
  };
}

function lentSinceText(item) {
  const since = repo.lendPeriods().filter((p) => p.itemId === item.id && p.lentAt && !p.returnedAt).pop()?.lentAt;
  return since ? `<small>since ${esc(fmtDate(since))} · ${dayText(daysBetween(since))}</small>` : ``;
}

/** Less frequent item actions. */
function itemMenu(item) {
  sheet(item.name, (el, close) => {
    el.innerHTML = `<div class="menu">
      <a href="#/edit/${esc(item.id)}" data-m="edit">${icon(`edit`)} Edit details</a>
      ${item.status === `lent` || item.status === `reserved` ? `` : `<button data-m="lend">${icon(`lend`)} Lend or reserve</button>`}
      ${item.status === `missing` ? `<button data-m="found">${icon(`check`)} Found it</button>` : `<button data-m="missing">${icon(`alert`)} Mark as missing</button>`}
      <button data-m="delete" class="danger">${icon(`trash`)} Remove from inventory</button></div>`;
    el.onclick = async (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `lend`) await lendOrSave(item);
      if (m === `missing`) { await repo.markMissing(item); toast(`Marked missing`); }
      if (m === `found`) { await repo.markFound(item); toast(`Found`); }
      if (m === `delete` && await confirmSheet(`Remove “${item.name}”?`, `It will be hidden from the app. The row stays in your sheet, marked as removed.`, `Remove`, true)) {
        await repo.deleteItem(item); toast(`Removed`); goBack(`#/`);
      }
    };
  });
}

// ============================================================ Add / Edit
function viewEdit(view, r) {
  const editing = r.name === `edit` ? repo.items.find((i) => i.id === r.id) : null;
  const item = editing || {
    name: r.params.get(`name`) || ``, purpose: ``, category: ``, tags: ``, qty: 1, warranty: ``, expiry: ``, notes: ``,
    locationId: r.params.get(`loc`) || recentLocs()[0] || ``,
  };
  let locationId = item.locationId;
  let photo = null, thumb = null;
  const cats = repo.categories();

  view.innerHTML = `
    <form class="form" id="f" autocomplete="off">
      <div class="form-head"><button type="button" class="back" data-cancel>${icon(`x`)} Cancel</button></div>
      <h1>${editing ? `Edit item` : `Add an item`}</h1>
      <label class="photo-pick" id="pp">
        <input type="file" accept="image/*" capture="environment" id="photo" hidden>
        <div class="pp-view">${editing && repo.thumbs[editing.id] ? `<img src="${repo.thumbs[editing.id]}" alt="">` : `<div class="pp-empty">${icon(`camera`)}<span>Take a photo</span></div>`}</div>
        <div class="pp-busy" hidden><div class="spinner"></div><span>Reading photos…</span></div>
      </label>
      <div id="xstrip"></div>
      <div id="aiRow"></div>
      <label class="field"><span>What is it?</span><input name="name" required value="${esc(item.name)}" placeholder="e.g. Stud finder"></label>
      <label class="field"><span>What’s it for?</span><textarea name="purpose" rows="2" placeholder="e.g. Finding studs before hanging shelves or a TV">${esc(item.purpose)}</textarea></label>
      <div class="field"><span>Where is it?</span>
        <button type="button" class="loc-btn" id="loc">${icon(`place`)}<span id="locText"></span>${icon(`chevron`)}</button></div>
      <div class="field"><span>How big is it? <small>(optional)</small></span>
        <input type="hidden" name="size" value="${esc(item.size || ``)}">
        <div class="chips size-chips" id="sizes">${SIZES.map((z) => `<button type="button" class="chip${item.size === z ? ` on` : ``}" data-size="${esc(z)}">${esc(z)}<small>${esc(SIZE_HINT[z])}</small></button>`).join(``)}</div></div>
      <details ${editing && (item.category || item.tags || Number(item.qty) > 1 || item.warranty || item.expiry || item.notes) ? `open` : ``}>
        <summary>More details <small>category, qty, notes</small></summary>
        <div class="two">
          <label class="field"><span>Category</span><input name="category" list="cats" value="${esc(item.category)}" placeholder="Tools"></label>
          <label class="field"><span>How many</span><input name="qty" type="number" min="0" inputmode="numeric" value="${esc(item.qty || 1)}"></label>
        </div>
        <datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join(``)}</datalist>
        <label class="field"><span>Search words <small>(optional)</small></span><input name="tags" value="${esc(item.tags)}" placeholder="e.g. plumbing, teflon"></label>
        <div class="two">
          <label class="field"><span>Warranty until</span><input name="warranty" type="date" value="${esc(item.warranty)}"></label>
          <label class="field"><span>Expires</span><input name="expiry" type="date" value="${esc(item.expiry)}"></label>
        </div>
        <label class="field"><span>Notes</span><textarea name="notes" rows="3" placeholder="Model number, where you bought it, manual link…">${esc(item.notes)}</textarea></label>
      </details>
      <div class="form-actions">
        ${editing ? `` : `<button type="submit" class="btn ghost" data-again>Save &amp; add another</button>`}
        <button type="submit" class="btn primary">Save</button>
      </div>
    </form>`;

  $(`[data-cancel]`, view).onclick = () => goBack(editing ? `#/item/${editing.id}` : `#/`);
  const setLocText = () => { $(`#locText`).innerHTML = locationId ? crumbs(locationId, { link: false }) : `<span class="muted">Choose a place</span>`; };
  setLocText();
  $(`#loc`).onclick = async () => { const id = await pickLocation(locationId); if (id) { locationId = id; setLocText(); } };

  let shot = null; // { canvas, aiImage } of the current photo, for AI + crops

  // size chips (one tap, tap again to clear)
  const sizeInput = () => $(`#f`).elements.size;
  const drawSizes = () => $$(`#sizes [data-size]`, view).forEach((b) => b.classList.toggle(`on`, b.dataset.size === sizeInput().value));
  $(`#sizes`).onclick = (e) => {
    const b = e.target.closest(`[data-size]`); if (!b) return;
    sizeInput().value = sizeInput().value === b.dataset.size ? `` : b.dataset.size;
    $(`#sizes`).classList.remove(`suggested`); drawSizes();
  };

  // more photos of the same item: saved straight away when editing, kept until Save when adding
  const pendingExtras = []; // [{ key, photo, thumb, aiImage }]
  const drawStrip = () => {
    const box = $(`#xstrip`); if (!box) return;
    const coverTaken = Boolean(photo || (editing && (repo.thumbs[editing.id] || editing.photoId)));
    if (!coverTaken) { box.innerHTML = ``; return; } // the big photo area comes first
    if (editing) box.innerHTML = itemPhotoRowHtml(repo.items.find((i) => i.id === editing.id) || editing);
    else box.innerHTML = photoRowHtml(pendingExtras.map((p) => ({ key: p.key, thumb: p.thumb })), { canAdd: pendingExtras.length + 1 < MAX_PHOTOS });
    $(`[data-xadd]`, box)?.addEventListener(`change`, async (e) => {
      const files = [...(e.target.files || [])]; if (!files.length) return;
      for (const file of files) {
        const count = editing ? repo.photosOf(repo.items.find((i) => i.id === editing.id)).length : pendingExtras.length;
        if (count + 1 >= MAX_PHOTOS) { toast(`An item can have up to ${MAX_PHOTOS} photos`); break; }
        try {
          const x = await processExtraPhoto(file);
          if (editing) await repo.addExtraPhoto(editing.id, x);
          else pendingExtras.push({ key: `p${Date.now()}${Math.random()}`, ...x });
        } catch { toast(`Couldn’t read one of the photos`); }
      }
      drawStrip();
      if (aiReady() && aiSettings().auto) describeFromAllPhotos();
    });
    box.onclick = (e) => { // tap a pending photo to remove it before saving
      const t = e.target.closest(`[data-view]`); if (!t) return;
      if (editing) { photoViewer(repo.items.find((i) => i.id === editing.id), t.dataset.view); return; }
      const i = pendingExtras.findIndex((p) => p.key === t.dataset.view);
      if (i >= 0) confirmSheet(`Remove this photo?`, `It hasn’t been saved yet.`, `Remove`, true).then((ok) => { if (ok) { pendingExtras.splice(i, 1); drawStrip(); } });
    };
  };
  // AI looks at every photo of this item together and merges what it sees into the form
  async function describeFromAllPhotos() {
    busy(true);
    try {
      const imgs = editing ? [...(shot ? [await shot.aiImage()] : []), ...await itemAiImages(repo.items.find((i) => i.id === editing.id), { skipCover: Boolean(shot) })]
        : [...(shot ? [await shot.aiImage()] : []), ...await Promise.all(pendingExtras.map((p) => p.aiImage()))];
      if (!imgs.length) return;
      const f = $(`#f`);
      const current = Object.fromEntries([`name`, `purpose`, `category`, `notes`, `size`].map((k) => [k, f.elements[k]?.value || ``]));
      const r = await describeItem(imgs.slice(0, MAX_PHOTOS), current, { categories: cats });
      applySuggestion({ ...r, notes: specLine(r) }, { quietIfNone: true, mergeNotes: true });
    } catch (err) { toast(err instanceof AiError ? err.message : `AI couldn’t read the photos this time`, { ms: 5000 }); }
    finally { busy(false); }
  }
  const drawAiRow = () => {
    const row = $(`#aiRow`); if (!row) return;
    if (!aiReady()) {
      let hidden = false; try { hidden = localStorage.getItem(`stash.aiPromoHidden`) === `1`; } catch { /* ignore */ }
      row.innerHTML = editing || hidden ? `` : `<div class="ai-setup"><a href="#/more?ai=1">${icon(`spark`)}<span>Let AI suggest details from your photos</span><b>Set up</b></a>
        <button type="button" class="icon-btn" data-hidepromo aria-label="Don’t show again">${icon(`x`)}</button></div>`;
      const x = row.querySelector(`[data-hidepromo]`);
      if (x) x.onclick = () => { try { localStorage.setItem(`stash.aiPromoHidden`, `1`); } catch { /* ignore */ } row.innerHTML = ``; toast(`You can turn AI on any time in More`); };
      return;
    }
    const s = aiSettings();
    row.innerHTML = `<div class="ai-row">
        <label class="switch"><input type="checkbox" id="aiAuto" ${s.auto ? `checked` : ``}><i></i><span>${icon(`spark`)} Suggest details from photos</span></label>
        ${shot ? `<button type="button" class="btn ghost small" id="aiRun">${icon(`spark`)} Suggest now</button>` : ``}
      </div>`;
    $(`#aiAuto`).onchange = (e) => saveAiSettings({ auto: e.target.checked });
    const run = $(`#aiRun`); if (run) run.onclick = () => runAi();
  };

  const busy = (on) => { $(`#pp`).classList.toggle(`busy`, on); $(`#pp .pp-busy`).hidden = !on; };

  async function runAi() {
    if (!shot) return;
    busy(true);
    try {
      const items = await analyzePhoto(await shot.aiImage(), { categories: cats, location: locationId ? repo.pathText(locationId) : `` });
      if (!items.length) { toast(`AI couldn’t recognize anything. Fill in the details yourself.`); return; }
      if (items.length === 1) { applySuggestion(items[0]); return; }
      const choice = await reviewItems(items, shot.canvas, locationId);
      if (choice?.single) {
        const { photo: p, thumb: t } = await cropItem(shot.canvas, choice.single.box);
        photo = p; thumb = t; $(`#pp .pp-view`).innerHTML = `<img src="${thumb}" alt="">`;
        applySuggestion(choice.single);
      } else if (choice?.added) {
        location.hash = `#/place/${choice.locationId}`;
      }
    } catch (err) {
      toast(err instanceof AiError ? err.message : `AI suggestion failed. Fill in the details yourself.`, { ms: 5000 });
    } finally { busy(false); }
  }

  function applySuggestion(sug, { quietIfNone = false, mergeNotes = false } = {}) {
    const f = $(`#f`); let n = 0;
    if (sug.size && (!sizeInput().value || $(`#sizes`).classList.contains(`suggested`)) && sizeInput().value !== sug.size) { sizeInput().value = sug.size; drawSizes(); $(`#sizes`).classList.add(`suggested`); n++; }
    if (mergeNotes && sug.notes) { // keep what's in Notes; add the model/specs line if it isn't there yet
      const el = f.elements.notes;
      if (el.value && !el.classList.contains(`suggested`) && !el.value.toLowerCase().includes(sug.notes.toLowerCase())) { el.value = `${el.value}\n${sug.notes}`; n++; }
      if (el.value && !el.classList.contains(`suggested`)) sug = { ...sug, notes: `` };
    }
    const set = (name, value) => {
      const el = f.elements[name];
      if (!el || !value) return;
      const untouched = !el.value || el.classList.contains(`suggested`) || (name === `qty` && String(el.value) === `1`);
      if (!untouched || el.value === String(value)) return; // never overwrite what the user typed
      el.value = value; el.classList.add(`suggested`); n++;
      el.addEventListener(`input`, () => el.classList.remove(`suggested`), { once: true });
    };
    set(`name`, sug.name); set(`purpose`, sug.purpose); set(`category`, sug.category);
    set(`tags`, sug.tags); if (sug.qty > 1) set(`qty`, sug.qty);
    if (sug.notes) set(`notes`, sug.notes);
    if (f.querySelector(`details .suggested`)) f.querySelector(`details`).open = true; // never hide what AI filled
    if (n) toast(`AI filled ${n} field${n > 1 ? `s` : ``}. Check them before saving.`);
    else if (!quietIfNone) toast(`AI had nothing to add to what you typed.`);
  }

  $(`#photo`).addEventListener(`change`, async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    $(`#pp`).classList.add(`busy`);
    try {
      const p = await processPhoto(file);
      ({ photo, thumb } = p); shot = p;
      $(`#pp .pp-view`).innerHTML = `<img src="${thumb}" alt="">`;
      drawAiRow(); drawStrip();
    } catch { toast(`Couldn’t read that photo`); return; }
    finally { $(`#pp`).classList.remove(`busy`); }
    if (aiReady() && aiSettings().auto) (pendingExtras.length || editing ? describeFromAllPhotos() : runAi()); // one photo may show many items; several photos show one
    else if (!$(`input[name=name]`).value) $(`input[name=name]`).focus();
  });
  drawAiRow(); drawStrip();

  // "Restore" from History: put the earlier value(s) back into the form. Nothing changes until Save.
  if (editing && r.params.get(`restore`)) {
    const entry = repo.log.find((x) => x.itemId === editing.id && x.ts === r.params.get(`restore`));
    const ch = Repo.parseChanges(entry?.changes); delete ch._ai;
    const want = r.params.get(`f`);
    const keys = Object.keys(ch).filter((k) => FIELD_LABEL[k] && (want === `*` || k === want));
    const f = $(`#f`); let first = null;
    for (const k of keys) {
      const old = ch[k][0];
      if (k === `size`) { sizeInput().value = old; drawSizes(); $(`#sizes`).classList.add(`restored`); first ||= $(`#sizes`); continue; }
      const el = f.elements[k]; if (!el) continue;
      el.value = old; el.classList.remove(`suggested`); el.classList.add(`restored`); first ||= el;
      el.addEventListener(`input`, () => el.classList.remove(`restored`), { once: true });
      el.closest(`details`)?.setAttribute(`open`, ``);
    }
    if (keys.length) {
      $(`h1`, view).insertAdjacentHTML(`afterend`, `<div class="restore-note">${icon(`ret`)}<span>Earlier ${esc(keys.map((k) => FIELD_LABEL[k].toLowerCase()).join(`, `))} from ${esc(fmtWhen(entry.ts))} restored. Tap <b>Save</b> to keep it, or Cancel.</span></div>`);
      setTimeout(() => first?.scrollIntoView({ block: `center`, behavior: `smooth` }), 150);
    } else toast(`That earlier version isn’t available any more`);
  }

  let again = false;
  $$(`button[type=submit]`, view).forEach((b) => b.addEventListener(`click`, () => { again = b.hasAttribute(`data-again`); }));
  let saving = false;
  const lock = (on) => { saving = on; $$(`button[type=submit]`, view).forEach((b) => { b.disabled = on; }); };
  const next = (id) => {
    if (again) { navStack.pop(); location.hash = `#/add?loc=${encodeURIComponent(locationId)}&t=${Date.now()}`; return; } // replace this form
    if (editing) return goBack(`#/item/${editing.id}`);
    if (id) { navStack.pop(); location.hash = `#/item/${id}`; return; }
    goBack(`#/`); // back to where Add was started (a place, Find…)
  };

  $(`#f`).addEventListener(`submit`, async (e) => {
    e.preventDefault();
    if (saving) return; // a double tap must not create two items
    lock(true);
    try {
      const fd = new FormData(e.target);
      const fields = Object.fromEntries([...fd.entries()].filter(([k]) => k !== `photo`).map(([k, v]) => [k, String(v).trim()]));
      fields.locationId = locationId;
      fields.qty = Number(fields.qty) || 1;
      if (editing) fields.id = editing.id;

      if (!editing) {
        const dups = findDuplicates(repo.activeItems(), fields.name, { locationId });
        if (dups.length) {
          const choice = await duplicatePrompt(fields, dups);
          if (!choice) { lock(false); return; } // back to the form
          if (choice.action === `open`) { location.hash = `#/item/${choice.item.id}`; return; }
          if (choice.action === `move` || choice.action === `more`) {
            const it = choice.item;
            const patch = { id: it.id };
            if (choice.action === `move`) { patch.locationId = locationId; patch.status = `home`; patch.lentTo = ``; }
            else patch.qty = (Number(it.qty) || 1) + fields.qty;
            const attach = photo && !it.photoId && !repo.thumbs[it.id]; // give it the photo if it had none
            await repo.saveItem(patch, { ...(attach ? { photo, thumb } : {}), logAction: choice.action === `move` ? `moved` : `qty+${fields.qty}` });
            rememberLoc(locationId);
            toast(choice.action === `move` ? `Moved ${it.name} to ${repo.pathText(locationId)}` : `${it.name} is now ×${patch.qty}`);
            return next(again ? null : it.id);
          }
          // choice.action === `new`: fall through and save as a separate item
        }
      }

      const aiFields = editing ? [] : [...$$(`#f .suggested`, view).map((el) => el.name), ...($(`#sizes`).classList.contains(`suggested`) ? [`size`] : [])].filter(Boolean);
      const saved = await repo.saveItem(fields, { photo, thumb, aiFields });
      for (const x of pendingExtras) await repo.addExtraPhoto(saved.id, x, { log: false });
      rememberLoc(locationId);
      toast(editing ? `Saved` : `Added ${saved.name}`, editing ? {} : { action: `View`, onAction: () => { location.hash = `#/item/${saved.id}`; } });
      next(editing ? saved.id : null);
    } catch (err) {
      console.error(err); toast(`Couldn’t save: ${err.message || err}`); lock(false);
    }
  });
}

/** "You may already have this". Resolves { action: open|move|more|new, item } or null (go back). */
function duplicatePrompt(fields, dups) {
  return new Promise((resolve) => {
    let done = false;
    const top = dups[0];
    sheet(top.samePlace ? `Already here?` : `Already have it?`, (el, close) => {
      const finish = (v) => { done = true; resolve(v); close(); };
      el.innerHTML = `
        <p class="muted">${top.samePlace
          ? `There’s already something similar in <b>${esc(repo.pathText(fields.locationId))}</b>.`
          : `You may already have this.`}</p>
        <div class="dup-list">
          ${dups.map((d, i) => `<div class="dup-row">
            <div class="dup-item">${thumbHtml(d.item)}<div><b>${esc(d.item.name)}</b>${Number(d.item.qty) > 1 ? ` <span class="qty">×${esc(d.item.qty)}</span>` : ``}
              <small>${icon(`place`)}${esc(repo.pathText(d.item.locationId) || `No location`)}${d.samePlace ? ` · same place` : ``}</small>
              ${d.item.status === `lent` ? `<small class="warn">Lent to ${esc(d.item.lentTo || `someone`)}</small>` : ``}</div></div>
            <div class="dup-actions">
              <button type="button" class="btn ghost small" data-act="open" data-i="${i}">Open it</button>
              ${!d.samePlace && fields.locationId ? `<button type="button" class="btn ghost small" data-act="move" data-i="${i}">It moved here</button>` : ``}
              <button type="button" class="btn ghost small" data-act="more" data-i="${i}">I have another (+${esc(fields.qty)})</button>
            </div>
          </div>`).join(``)}
        </div>
        <div class="row-actions">
          <button type="button" class="btn ghost" data-back>Keep editing</button>
          <button type="button" class="btn primary" data-new>Save as a new item</button>
        </div>`;
      el.onclick = (e) => {
        const b = e.target.closest(`button`); if (!b) return;
        if (b.hasAttribute(`data-back`)) return finish(null);
        if (b.hasAttribute(`data-new`)) return finish({ action: `new` });
        if (b.dataset.act) finish({ action: b.dataset.act, item: dups[Number(b.dataset.i)].item });
      };
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

/**
 * Several items found in one photo: let the user review, rename and untick, then add them all.
 * Resolves { added, locationId } | { single: suggestion } | null.
 */
function reviewItems(items, canvas, startLoc, { scan = false } = {}) {
  const canvases = Array.isArray(canvas) ? canvas : [canvas];
  return new Promise((resolve) => {
    let done = false;
    let locationId = startLoc;
    const spot = new Map(); // item index -> a different place than the one for everything
    const locOf = (i) => spot.get(i) || locationId;
    const hereDup = (it) => locationId && findDuplicates(repo.activeItems(), it.name, { locationId }).find((d) => d.samePlace);
    const ticked = new Set(items.map((_, i) => i).filter((i) => !hereDup(items[i])));
    const finish = (v) => { done = true; resolve(v); };
    sheet(`Found ${items.length} item${items.length === 1 ? `` : `s`}`, async (el, close) => {
      el.innerHTML = `<p class="muted small">Cutting out photos…</p>`;
      const crops = await Promise.all(items.map((it) => cropItem(canvases[it.photo || 0] || canvases[0], it.box)));
      const hasInside = () => locationId && repo.childrenOf(locationId).length;
      const draw = () => {
        el.innerHTML = `
          <p class="muted small">Suggested by AI. Untick anything you don’t want and fix names before adding.${scan ? ` Something missing? Add it yourself after, or scan again closer.` : ``}</p>
          ${items.length > 4 ? `<div class="review-tools"><button type="button" class="link small" data-all>${ticked.size === items.length ? `Untick all` : `Tick all`}</button></div>` : ``}
          <div class="review-list">
            ${items.map((it, i) => `<div class="review-row">
              <label class="tick"><input type="checkbox" data-i="${i}" ${ticked.has(i) ? `checked` : ``}></label>
              <img src="${crops[i].thumb}" alt="">
              <div class="review-main">
                <input class="review-name suggested" data-name="${i}" value="${esc(it.name)}">
                ${hereDup(it) ? `<small class="here-tag">Already here: ${esc(hereDup(it).item.name)}</small>` : ``}
                <small>${esc(it.purpose)}</small>
                ${it.qty > 1 ? `<small>×${it.qty}</small>` : ``}
                ${spot.has(i) || hasInside() ? `<button type="button" class="spot-btn${spot.has(i) ? ` set` : ``}" data-spot="${i}">${icon(`place`)}${esc(spot.has(i) ? repo.pathOf(spot.get(i)).slice(-2).map((l) => l.name).join(` › `) : `Put somewhere inside`)}</button>` : ``}
              </div>
              ${scan ? `` : `<button type="button" class="icon-btn" data-one="${i}" aria-label="Edit just this one">${icon(`edit`)}</button>`}
            </div>`).join(``)}
          </div>
          <div class="field"><span>Where are they?</span>
            <button type="button" class="loc-btn" data-loc>${icon(`place`)}<span>${locationId ? crumbs(locationId, { link: false }) : `<span class="muted">Choose a place</span>`}</span>${icon(`chevron`)}</button></div>
          <div class="row-actions"><button type="button" class="btn primary full" data-add>Add selected</button></div>`;
        updateCount();
      };
      const selected = () => [...ticked].sort((a, b) => a - b);
      const updateCount = () => { const n = selected().length; const b = $(`[data-add]`, el); b.textContent = n ? `Add ${n} item${n > 1 ? `s` : ``}` : `Nothing selected`; b.disabled = !n; };
      el.addEventListener(`change`, (e) => {
        if (!e.target.matches(`[data-i]`)) return;
        const i = Number(e.target.dataset.i);
        if (e.target.checked) ticked.add(i); else ticked.delete(i);
        updateCount();
      });
      el.addEventListener(`input`, (e) => {
        if (e.target.matches(`[data-name]`)) { items[Number(e.target.dataset.name)].name = e.target.value; e.target.classList.remove(`suggested`); }
      });
      el.addEventListener(`click`, async (e) => {
        const b = e.target.closest(`button`); if (!b) return;
        if (b.dataset.one !== undefined) { finish({ single: items[Number(b.dataset.one)] }); close(); return; }
        if (b.hasAttribute(`data-all`)) { if (ticked.size === items.length) ticked.clear(); else items.forEach((_, i) => ticked.add(i)); draw(); return; }
        if (b.dataset.spot !== undefined) {
          const i = Number(b.dataset.spot);
          const id = await pickLocation(locOf(i), `Where is “${items[i].name}”?`, { inside: locationId });
          if (id) { if (id === locationId) spot.delete(i); else spot.set(i, id); draw(); }
          return;
        }
        if (b.hasAttribute(`data-loc`)) {
          // keep the review sheet; stack the picker on top
          const id = await pickLocation(locationId, `Where are they?`);
          if (id) { locationId = id; items.forEach((it, i) => { if (hereDup(it)) ticked.delete(i); }); draw(); }
          return;
        }
        if (b.hasAttribute(`data-add`)) {
          if (!locationId) { const id = await pickLocation(``, `Where are they?`); if (!id) return; locationId = id; }
          const picks = selected();
          b.disabled = true; b.textContent = `Adding…`;
          let n = 0;
          for (const i of picks) {
            const it = items[i];
            if (!it.name.trim()) continue;
            b.textContent = `Adding ${++n} of ${picks.length}…`;
            await repo.saveItem({ name: it.name.trim(), purpose: it.purpose, category: it.category, tags: it.tags, qty: it.qty, notes: it.notes, size: it.size || ``, locationId: locOf(i) },
              { photo: crops[i].photo, thumb: crops[i].thumb, info: scan ? `AI scan` : `AI from photo`, aiFields: [`name`, `purpose`, `category`, `tags`, `size`, `notes`].filter((k) => it[k]) });
          }
          rememberLoc(locationId);
          toast(`Added ${n} item${n === 1 ? `` : `s`} to ${repo.pathText(locationId)}`);
          finish({ added: picks.length, locationId }); close();
        }
      });
      draw();
    }, { onClose: () => { if (!done) resolve(null); } });
  });
}

// ============================================================ Places
// Which rooms are expanded on a place page, remembered per place on this device.
const OPEN_KEY = `paran.openRooms`;
function openRooms(placeId) {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || `{}`)[placeId] || []); } catch { return new Set(); }
}
function saveOpenRooms(placeId, set) {
  try { const all = JSON.parse(localStorage.getItem(OPEN_KEY) || `{}`); all[placeId] = [...set]; localStorage.setItem(OPEN_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

function viewPlace(view, r) {
  const loc = r.id ? repo.locById(r.id) : null;
  if (r.id && !loc) { view.innerHTML = `<div class="empty"><h3>Place not found</h3><a class="btn ghost" href="#/places">All places</a></div>`; return; }
  const kids = repo.childrenOf(loc?.id || ``);
  const count = (id) => repo.itemsIn(id, true).length;
  const total = loc ? count(loc.id) : 0;
  const direct = loc ? repo.itemsIn(loc.id) : [];
  // everything inside, grouped by the place directly below this one
  const groups = loc ? kids.map((k) => ({ k, items: repo.itemsIn(k.id, true) })).filter((g) => g.items.length) : [];
  const sortByName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const addInsideRow = `<button type="button" class="list-row link-row add-row" data-a="new">${icon(`plus`)}<span>${loc ? `Add a place inside ${esc(loc.name)}` : `Add a place`}</span></button>`;

  view.innerHTML = `
    <div class="place">
      ${loc ? `<div class="crumbs top"><a href="#/places">All places</a><span class="sep">›</span>${crumbs(loc.id)}</div>` : ``}
      <div class="place-head">
        <h1>${loc ? `${icon(KIND_ICON[loc.kind] || `box`)} ${esc(loc.name)}` : `Places`}</h1>
        ${!loc ? `<button class="btn ghost small" data-a="scanlabel">${icon(`qr`)} Scan label</button>` : ``}
        ${loc ? `<div class="detail-tools">
            ${loc.kind === `container` ? `<button class="btn ghost small" data-a="qr">${icon(`qr`)} QR label</button>` : ``}
            <button class="icon-btn" data-a="share" aria-label="Share what’s here">${icon(`share`)}</button>
            <button class="icon-btn" data-a="menu" aria-label="Place options">${icon(`more`)}</button></div>` : ``}
      </div>
      ${loc ? `<div class="place-add"><a class="btn primary" href="#/add?loc=${esc(loc.id)}">${icon(`plus`)} Add item here</a>
        <button type="button" class="btn ghost" data-a="scan">${icon(`spark`)} Scan many</button></div>` : ``}
      ${!loc ? (kids.length ? `<div class="label-sm">Your places</div>
        <div class="list">${kids.map((k) => `<a class="list-row link-row" href="#/place/${esc(k.id)}">${icon(KIND_ICON[k.kind] || `box`)}<span>${esc(k.name)}</span><small>${count(k.id) || ``}</small>${icon(`chevron`)}</a>`).join(``)}${addInsideRow}</div>
        <a class="link small setup-link" href="#/setup">${icon(`plus`)} Quick-add rooms and places</a>`
        : `<div class="empty"><h3>No places yet</h3><p>Tell Paran where you keep things: a home or building and its rooms, a storage unit, a car…</p>
            <a class="btn primary" href="#/setup">${icon(`place`)} Set up your places</a></div>`) : ``}
      ${loc ? (() => {
        const open = openRooms(loc.id);
        const allOpen = kids.length && kids.filter((k) => count(k.id)).every((k) => open.has(k.id));
        const room = (k) => {
          const n = count(k.id); const isOpen = n && open.has(k.id);
          const subs = repo.childrenOf(k.id).length;
          return `<section class="room${isOpen ? ` open` : ``}">
            <div class="room-row">
              <button type="button" class="room-toggle" ${n ? `data-toggle="${esc(k.id)}" aria-expanded="${isOpen ? `true` : `false`}"` : `data-open="${esc(k.id)}"`}>
                <span class="caret">${n ? icon(`chevron`) : ``}</span>${icon(KIND_ICON[k.kind] || `box`)}
                <span class="room-name">${esc(k.name)}<small>${n ? itemsWord(n) : `Empty`}${subs ? ` · ${subs} place${subs > 1 ? `s` : ``} inside` : ``}</small></span>
              </button>
              <a class="icon-btn room-open" href="#/place/${esc(k.id)}" aria-label="Open ${esc(k.name)}">${icon(`chevron`)}</a>
            </div>
            ${isOpen ? `<div class="cards">${sortByName(repo.itemsIn(k.id, true)).map((i) => itemCard(i)).join(``)}</div>` : ``}
          </section>`;
        };
        return `
        <div class="list-head"><div class="label-sm">Inside ${esc(loc.name)}${total ? ` · ${itemsWord(total)}` : ``}</div>
          <div class="head-links">${groups.length > 1 ? `<button type="button" class="link small" data-a="${allOpen ? `collapse` : `expand`}">${allOpen ? `Collapse all` : `Expand all`}</button>` : ``}
          ${direct.length || kids.some((k) => open.has(k.id) && count(k.id)) ? `<button type="button" class="link small" data-select-toggle>${sel.on ? `Done` : `Select`}</button>` : ``}</div></div>
        ${direct.length ? `${kids.length ? `<div class="group-head">Directly in ${esc(loc.name)}</div>` : ``}<div class="cards">${sortByName(direct).map((i) => itemCard(i)).join(``)}</div>` : ``}
        ${kids.length ? `<div class="rooms">${kids.map(room).join(``)}</div>` : ``}
        ${!total && !kids.length ? `<p class="muted">Nothing here yet.</p>` : ``}
        <div class="list add-list">${addInsideRow}</div>`;
      })() : ``}
    </div>`;

  view.onclick = async (e) => {
    const t = e.target.closest(`[data-toggle]`);
    if (t && loc) {
      const open = openRooms(loc.id); const id = t.dataset.toggle;
      if (open.has(id)) open.delete(id); else open.add(id);
      saveOpenRooms(loc.id, open); render(); return;
    }
    const o = e.target.closest(`[data-open]`); if (o) { location.hash = `#/place/${o.dataset.open}`; return; }
    const b = e.target.closest(`[data-a]`); if (!b) return;
    if ((b.dataset.a === `expand` || b.dataset.a === `collapse`) && loc) {
      saveOpenRooms(loc.id, new Set(b.dataset.a === `expand` ? kids.filter((k) => count(k.id)).map((k) => k.id) : []));
      render(); return;
    }
    if (b.dataset.a === `new`) {
      const name = await promptSheet(loc ? `New place in ${loc.name}` : `New place`, {
        label: `Name`, placeholder: loc ? `e.g. Top shelf, Blue bin, Drawer 2` : `e.g. Home, Storage unit, Office`, okLabel: `Add` });
      if (name) { repo.saveLocation({ name, parentId: loc?.id || ``, kind: kindFor(loc?.id || ``) }); toast(`Added ${name}`); }
    }
    if (b.dataset.a === `menu`) placeMenu(loc);
    if (b.dataset.a === `qr`) printLabel(loc);
    if (b.dataset.a === `scan`) scanPlace(loc.id);
    if (b.dataset.a === `share`) sharePlace(loc);
    if (b.dataset.a === `scanlabel`) scanLabelFlow();
  };
}

// ============================================================ Share with anyone (a copy via the phone's share sheet)
const SHARE_SIGN = `Shared from Paran`;
// Where this inventory lives, using the sheet's real name (older pilot inventories are still called "Stash").
const driveWhere = (b) => b.isOwner
  ? (b.sheetName ? `Everything is in your Google Drive, in the “${esc(b.sheetName)}” sheet and its folder.` : `Everything is in your Google Drive.`)
  : `Everything is in the shared${b.sheetName ? ` “${esc(b.sheetName)}”` : ``} sheet.`;

/** Phone share sheet → files if supported → text only → clipboard → a sheet to copy from. */
async function shareOut({ title, text, file, files }) {
  const list = files || (file ? [file] : []);
  const data = { title, text };
  try {
    if (list.length && navigator.canShare?.({ files: list })) { await navigator.share({ ...data, files: list }); return true; }
    if (navigator.share && !list.length) { await navigator.share(data); return true; }
    if (navigator.share && list.length > 1 && navigator.canShare?.({ files: [list[0]] })) {
      toast(`This phone can’t share that many photos at once. Try fewer.`, { ms: 5000 }); return false;
    }
    if (navigator.share) { await navigator.share(data); return true; }
  } catch (e) {
    if (e?.name === `AbortError`) return false; // they closed the share sheet
  }
  for (const f of list) { // desktop: save the pictures, copy the text
    const a = document.createElement(`a`); a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const saved = list.length ? `${list.length > 1 ? `${list.length} pictures` : `Picture`} saved and text copied` : `Copied. Paste it into a message.`;
  try { await navigator.clipboard.writeText(text); toast(saved); return true; }
  catch {
    sheet(`Copy this`, (el) => { el.innerHTML = `<textarea class="share-copy" rows="10" readonly>${esc(text)}</textarea>`; const t = $(`textarea`, el); t.focus(); t.select(); });
    return true;
  }
}

const dataUrlToBlob = async (u) => (await fetch(u)).blob();
async function itemPhotoFile(item) {
  try {
    const url = item.photoId || repo.thumbs[item.id] ? await repo.photoObjectUrl(item).catch(() => null) : null;
    const blob = url ? await (await fetch(url)).blob() : repo.thumbs[item.id] ? await dataUrlToBlob(repo.thumbs[item.id]) : null;
    if (!blob) return null;
    return new File([blob], `${item.name.replace(/[^\w\- ]+/g, ``).trim() || `item`}.jpg`, { type: blob.type || `image/jpeg` });
  } catch { return null; }
}

function shareItem(item) {
  lic.count(`share.item`);
  const hasPhoto = Boolean(item.photoId || repo.thumbs[item.id]);
  const opts = { photo: hasPhoto, where: true };
  let file = null; // fetched up front: phones only allow sharing straight from the tap
  const textOf = () => [
    `${item.name}${Number(item.qty) > 1 ? ` ×${item.qty}` : ``}`,
    item.purpose ? `For: ${item.purpose}` : ``,
    item.size ? `Size: ${item.size}` : ``,
    item.notes ? item.notes.split(`\n`)[0] : ``,
    opts.where && item.locationId ? `Where: ${repo.pathText(item.locationId)}` : ``,
  ].filter(Boolean).join(`\n`) + `\n\n${SHARE_SIGN}`;
  sheet(`Share ${item.name}`, (el, close) => {
    const draw = () => {
      el.innerHTML = `
        <div class="share-card">${opts.photo && hasPhoto ? thumbHtml(item, `share-thumb`) : ``}<pre class="share-preview">${esc(textOf())}</pre></div>
        ${hasPhoto ? `<label class="check"><input type="checkbox" data-o="photo" ${opts.photo ? `checked` : ``}><span>Include photo</span></label>` : ``}
        <label class="check"><input type="checkbox" data-o="where" ${opts.where ? `checked` : ``}><span>Include where it’s kept</span></label>
        <p class="fine">They get a copy to read. Nothing in your inventory is shared.</p>
        <div class="row-actions"><button type="button" class="btn ghost" data-copy>Copy text</button><button type="button" class="btn primary" data-go>${icon(`share`)} Share</button></div>`;
    };
    el.addEventListener(`change`, (e) => { const o = e.target.dataset.o; if (o) { opts[o] = e.target.checked; draw(); } });
    el.addEventListener(`click`, async (e) => {
      if (e.target.closest(`[data-copy]`)) {
        try { await navigator.clipboard.writeText(textOf()); toast(`Copied`); } catch { await shareOut({ title: item.name, text: textOf() }); }
        return;
      }
      if (e.target.closest(`[data-go]`)) {
        const ok = await shareOut({ title: item.name, text: textOf(), file: opts.photo ? file : null });
        if (ok) close();
      }
    });
    draw();
    if (hasPhoto) itemPhotoFile(item).then((f) => { file = f; });
  });
}

/** Everything inside a place, grouped by the spot directly below it. */
function placeGroups(loc) {
  const sortByName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const groups = [];
  const direct = repo.itemsIn(loc.id);
  if (direct.length) groups.push({ name: ``, items: sortByName(direct) });
  for (const k of repo.childrenOf(loc.id)) {
    const items = repo.itemsIn(k.id, true);
    if (items.length) groups.push({ name: k.name, items: sortByName(items) });
  }
  return groups;
}

const itemsWord = (n) => `${n} item${n === 1 ? `` : `s`}`;
function listText(head, groups, { purpose }) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const line = (i) => `• ${i.name}${Number(i.qty) > 1 ? ` ×${i.qty}` : ``}${purpose && i.purpose ? ` – ${i.purpose}` : ``}`;
  const parts = [head.text ? `${head.text} · ${itemsWord(total)}` : itemsWord(total)];
  for (const g of groups) {
    parts.push(``);
    if (g.name) parts.push(`${g.name}:`);
    g.items.forEach((i) => parts.push(line(i)));
  }
  parts.push(``, SHARE_SIGN);
  return parts.join(`\n`);
}

/** A picture of the list with photos, for messaging apps. */
async function listPicture(head, groups, { purpose }) {
  const MAX = 80;
  const W = 1080, PAD = 48, ROW = purpose ? 132 : 112, IMG = 88, HEAD = 64;
  let shown = 0; const rows = [];
  for (const g of groups) {
    if (shown >= MAX) break;
    if (g.name) rows.push({ head: g.name });
    for (const i of g.items) { if (shown >= MAX) break; rows.push({ item: i }); shown++; }
  }
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const H = PAD + 120 + rows.reduce((h, r) => h + (r.head ? HEAD : ROW), 0) + (total > shown ? 60 : 0) + 80;
  const c = document.createElement(`canvas`); c.width = W; c.height = H;
  const x = c.getContext(`2d`);
  const font = (w, s) => `${w} ${s}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const fit = (t, max) => { if (x.measureText(t).width <= max) return t; while (t && x.measureText(`${t}…`).width > max) t = t.slice(0, -1); return `${t}…`; };
  x.fillStyle = `#fffdf9`; x.fillRect(0, 0, W, H);
  x.fillStyle = `#1d1b18`; x.font = font(700, 48); x.fillText(fit(head.title, W - PAD * 2), PAD, PAD + 44);
  x.fillStyle = `#5d5850`; x.font = font(400, 28);
  x.fillText(fit([...(head.sub ? [head.sub] : []), itemsWord(total)].join(` · `), W - PAD * 2), PAD, PAD + 90);
  const load = (src) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = src; });
  let y = PAD + 120;
  for (const r of rows) {
    if (r.head) {
      x.fillStyle = `#2f5d50`; x.font = font(700, 30); x.fillText(fit(r.head, W - PAD * 2), PAD, y + 44); y += HEAD; continue;
    }
    const i = r.item; const t = repo.thumbs[i.id];
    const iy = y + (ROW - IMG) / 2;
    x.save(); x.beginPath(); x.roundRect(PAD, iy, IMG, IMG, 14); x.clip();
    const im = t ? await load(t) : null;
    if (im) {
      const s = Math.max(IMG / im.width, IMG / im.height); const w = im.width * s, h = im.height * s;
      x.drawImage(im, PAD + (IMG - w) / 2, iy + (IMG - h) / 2, w, h);
    } else { x.fillStyle = `hsl(${tintOf(i.id || i.name)} 30% 84%)`; x.fillRect(PAD, iy, IMG, IMG); }
    x.restore();
    const tx = PAD + IMG + 28, tw = W - tx - PAD;
    x.fillStyle = `#1d1b18`; x.font = font(600, 34);
    x.fillText(fit(`${i.name}${Number(i.qty) > 1 ? `  ×${i.qty}` : ``}`, tw), tx, y + (purpose && i.purpose ? ROW / 2 - 6 : ROW / 2 + 12));
    if (purpose && i.purpose) { x.fillStyle = `#5d5850`; x.font = font(400, 27); x.fillText(fit(i.purpose, tw), tx, y + ROW / 2 + 34); }
    x.fillStyle = `#e2ddd4`; x.fillRect(tx, y + ROW - 1, W - tx - PAD, 1);
    y += ROW;
  }
  x.fillStyle = `#8f897f`; x.font = font(400, 26);
  if (total > shown) { x.fillText(`+ ${total - shown} more`, PAD, y + 40); y += 60; }
  x.fillText(SHARE_SIGN, PAD, H - PAD);
  const blob = await new Promise((r) => c.toBlob(r, `image/jpeg`, 0.86));
  return new File([blob], `${head.title.replace(/[^\w\- ]+/g, ``).trim() || `list`}.jpg`, { type: `image/jpeg` });
}

function sharePlace(loc) {
  lic.count(`share.place`);
  const groups = placeGroups(loc);
  if (!groups.length) { toast(`Nothing in ${loc.name} yet`); return; }
  shareList({
    sheetTitle: `Share what’s in ${loc.name}`,
    head: { title: loc.name, sub: repo.pathOf(loc.id).slice(0, -1).map((l) => l.name).join(` › `), text: repo.pathText(loc.id) },
    groups: (byPlace) => (byPlace ? groups : [{ name: ``, items: groups.flatMap((g) => g.items).sort((a, b) => a.name.localeCompare(b.name)) }]),
    groupLabel: `Group by spot`,
  });
}

/** Selected items (Select mode): grouped by where each one is kept, or one plain list. */
function shareSelection(items) {
  lic.count(`share.selection`);
  const byLoc = new Map();
  for (const i of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = i.locationId ? repo.pathOf(i.locationId).slice(-2).map((l) => l.name).join(` › `) : `No location yet`;
    if (!byLoc.has(key)) byLoc.set(key, []);
    byLoc.get(key).push(i);
  }
  const grouped = [...byLoc.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => ({ name, items: list }));
  return shareList({
    sheetTitle: `Share ${itemsWord(items.length)}`,
    head: { title: items.length === 1 ? items[0].name : `${itemsWord(items.length)}`, sub: ``, text: `` },
    groups: (byPlace) => (byPlace ? grouped : [{ name: ``, items: grouped.flatMap((g) => g.items).sort((a, b) => a.name.localeCompare(b.name)) }]),
    groupLabel: `Include where they’re kept`,
    byPlace: false,
  });
}

function shareList({ sheetTitle, head, groups: groupsFor, groupLabel, byPlace = true }) {
  const opts = { as: `text`, purpose: false, byPlace };
  const total = groupsFor(true).reduce((n, g) => n + g.items.length, 0);
  const MAX_PHOTOS = 10;
  const withPhoto = groupsFor(false).flatMap((g) => g.items).filter((i) => i.photoId || repo.thumbs[i.id]);
  let pic = null, picKey = ``;
  let photos = null, photosLoading = false, photosDone = 0; // full photos, fetched before Share so the tap can share them
  return new Promise((resolve) => {
    let shared = false;
    sheet(sheetTitle, (el, close) => {
      const groups = () => groupsFor(opts.byPlace);
      const makePic = async () => {
        const key = `${opts.purpose}|${opts.byPlace}`;
        if (pic && picKey === key) return;
        picKey = key; pic = null; draw();
        const f = await listPicture(head, groups(), opts);
        if (picKey === key) { pic = f; draw(); }
      };
      const loadPhotos = async () => {
        if (photos || photosLoading) return;
        photosLoading = true; photosDone = 0; draw();
        const out = [];
        for (const i of withPhoto.slice(0, MAX_PHOTOS)) {
          const f = await itemPhotoFile(i); if (f) out.push(f);
          photosDone++; if (opts.as === `photos`) draw();
        }
        photos = out; photosLoading = false; draw();
      };
      const photosBody = () => {
        if (!withPhoto.length) return `<p class="muted pad">None of these have a photo yet.</p>`;
        const n = Math.min(withPhoto.length, MAX_PHOTOS);
        return `<div class="share-photos">${withPhoto.slice(0, MAX_PHOTOS).map((i) => thumbHtml(i, `sp-img`)).join(``)}</div>
          <p class="fine">${photos ? `${photos.length} full photo${photos.length === 1 ? `` : `s`} ready` : `Getting full photos… ${photosDone} of ${n}`}${withPhoto.length > MAX_PHOTOS ? ` · first ${MAX_PHOTOS} only` : ``}${withPhoto.length < total ? ` · ${total - withPhoto.length} without a photo` : ``}. The list is sent as the message.</p>`;
      };
      const draw = () => {
        const text = listText(head, groups(), opts);
        const ready = opts.as === `pic` ? Boolean(pic) : opts.as === `photos` ? Boolean(photos?.length) : true;
        el.innerHTML = `
          <div class="seg three" role="tablist">
            <button type="button" data-as="text" class="${opts.as === `text` ? `on` : ``}" role="tab">List</button>
            <button type="button" data-as="pic" class="${opts.as === `pic` ? `on` : ``}" role="tab">Picture</button>
            <button type="button" data-as="photos" class="${opts.as === `photos` ? `on` : ``}" role="tab">Photos</button>
          </div>
          ${opts.as === `text` ? `<pre class="share-preview list">${esc(text)}</pre>`
            : opts.as === `photos` ? photosBody()
            : pic ? `<img class="share-pic" src="${URL.createObjectURL(pic)}" alt="Preview">` : `<div class="share-pic wait"><div class="spinner"></div></div>`}
          <label class="check"><input type="checkbox" data-o="purpose" ${opts.purpose ? `checked` : ``}><span>Include what each is for</span></label>
          <label class="check"><input type="checkbox" data-o="byPlace" ${opts.byPlace ? `checked` : ``}><span>${esc(groupLabel)}</span></label>
          <p class="fine">${itemsWord(total)}. They get a copy to read. Nothing in your inventory is shared.</p>
          <div class="row-actions">${opts.as === `text` ? `<button type="button" class="btn ghost" data-copy>Copy text</button>` : ``}
            <button type="button" class="btn primary" data-go ${ready ? `` : `disabled`}>${icon(`share`)} Share</button></div>`;
      };
      el.addEventListener(`change`, (e) => { const o = e.target.dataset.o; if (o) { opts[o] = e.target.checked; draw(); if (opts.as === `pic`) makePic(); } });
      el.addEventListener(`click`, async (e) => {
        const as = e.target.closest(`[data-as]`);
        if (as) { opts.as = as.dataset.as; draw(); if (opts.as === `pic`) makePic(); if (opts.as === `photos`) loadPhotos(); return; }
        const text = listText(head, groups(), opts);
        if (e.target.closest(`[data-copy]`)) { try { await navigator.clipboard.writeText(text); toast(`Copied`); } catch { await shareOut({ title: head.title, text }); } return; }
        if (e.target.closest(`[data-go]`)) {
          const ok = opts.as === `pic`
            ? await shareOut({ title: head.title, text: head.text ? `${head.text} · ${itemsWord(total)}` : head.title, file: pic })
            : opts.as === `photos` ? await shareOut({ title: head.title, text, files: photos })
            : await shareOut({ title: head.title, text });
          if (ok) { shared = true; resolve(true); close(); }
        }
      });
      draw();
    }, { onClose: () => { if (!shared) resolve(false); } });
  });
}

// ============================================================ Scan a QR label (in the app)
/** The place a label points to, if it's in this inventory. */
function labelLoc(text) {
  const m = /#\/place\/([\w-]+)/.exec(String(text || ``));
  const loc = m && repo.locById(m[1]);
  return loc && !loc.deleted ? loc : null;
}
const labelVerdict = (t) => (labelLoc(t) ? true
  : /#\/place\//.test(t) ? `This label is from another inventory, or that place was removed.` : `That isn’t a Paran label.`);
async function scanToPlace(title, hint) {
  const text = await scanLabel({ title, hint, accept: labelVerdict });
  return text ? labelLoc(text) : null;
}

/** Scan from Find or Places: see what's inside, or put things away there. */
async function scanLabelFlow() {
  lic.count(`qr.scan`);
  const loc = await scanToPlace(`Scan a label`, `Point at a box or shelf label.`);
  if (!loc) return;
  const n = repo.itemsIn(loc.id, true).length;
  sheet(loc.name, (el, close) => {
    el.innerHTML = `<p class="muted small">${esc(repo.pathText(loc.id))} · ${itemsWord(n)}</p>
      <div class="menu">
        <button data-m="open">${icon(`search`)} See what’s inside</button>
        <button data-m="bring">${icon(`ret`)} Put items away here</button>
        <button data-m="add">${icon(`plus`)} Add a new item here</button>
        <button data-m="scan">${icon(`spark`)} Scan many into it</button>
      </div>`;
    el.onclick = (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `open`) location.hash = `#/place/${loc.id}`;
      else if (m === `add`) location.hash = `#/add?loc=${loc.id}`;
      else if (m === `bring`) bringItemsSheet(loc);
      else if (m === `scan`) scanPlace(loc.id);
    };
  });
}

// ============================================================ Scan many: pan across a shelf, AI lists everything
const SCAN_MAX = 8;
async function scanPlace(locId) {
  if (!lic.allows(`aiScan`)) { toast(`Scan many is paused for this group`); return; }
  lic.count(`ai.scanMany`);
  if (!aiReady()) {
    const ok = await confirmSheet(`Scan many items at once`, `Pan your camera across a shelf or room, and AI lists everything it sees for you to review. This uses AI suggestions with your own free Gemini key.`, `Set up AI`);
    if (!ok || !(await aiConsent())) return;
  }
  let seen = false; try { seen = localStorage.getItem(`stash.scanNote`) === `1`; } catch { /* ignore */ }
  if (!seen) {
    const ok = await confirmSheet(`Before you scan`, `Wide photos of a room show more of your space than a single item. They go from this phone to Google Gemini, and on the free tier Google may use them to improve its products. Keep papers, screens and people out of the shot.`, `Start scanning`);
    if (!ok) return;
    try { localStorage.setItem(`stash.scanNote`, `1`); } catch { /* ignore */ }
  }
  const where = repo.pathText(locId);
  const shots = await captureScan({ max: SCAN_MAX, title: repo.locById(locId)?.name || `` });
  if (!shots?.length) return;
  const wait = document.createElement(`div`);
  wait.className = `scan-wait`;
  wait.innerHTML = `<div><div class="spinner"></div><b>Reading ${shots.length} photo${shots.length > 1 ? `s` : ``}…</b><small>This can take up to a minute.</small></div>`;
  document.body.appendChild(wait);
  let items;
  try {
    const blobs = await Promise.all(shots.map((c) => new Promise((r) => {
      const scale = Math.min(1, 1024 / Math.max(c.width, c.height));
      const d = document.createElement(`canvas`); d.width = Math.round(c.width * scale); d.height = Math.round(c.height * scale);
      d.getContext(`2d`).drawImage(c, 0, 0, d.width, d.height); d.toBlob(r, `image/jpeg`, 0.8);
    })));
    items = await scanPhotos(blobs, { categories: repo.categories(), location: where });
  } catch (err) {
    wait.remove();
    toast(err instanceof AiError ? err.message : `Scan failed. Try again, or add items one by one.`, { ms: 6000 });
    return;
  }
  wait.remove();
  if (!items.length) { toast(`AI couldn’t recognize anything. Try again closer, with more light.`, { ms: 5000 }); return; }
  const res = await reviewItems(items, shots, locId, { scan: true });
  if (res?.added) render();
}

function placeMenu(loc) {
  sheet(loc.name, (el, close) => {
    el.innerHTML = `<div class="menu">
      <button data-m="bring">${icon(`ret`)} Bring items here</button>
      <button data-m="share">${icon(`share`)} Share what’s here</button>
      <button data-m="new">${icon(`plus`)} Add a place inside</button>
      <button data-m="move">${icon(`move`)} Move ${esc(loc.name)} to another place</button>
      <button data-m="rename">${icon(`edit`)} Rename</button>
      <button data-m="qr">${icon(`qr`)} Print QR label</button>
      <button data-m="delete" class="danger">${icon(`trash`)} Remove place</button></div>`;
    el.onclick = async (e) => {
      const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
      close();
      if (m === `bring`) bringItemsSheet(loc);
      else if (m === `share`) sharePlace(loc);
      else if (m === `new`) {
        const name = await promptSheet(`New place in ${loc.name}`, { label: `Name`, placeholder: `e.g. Top shelf, Blue bin, Drawer 2`, okLabel: `Add` });
        if (name) { repo.saveLocation({ name, parentId: loc.id, kind: kindFor(loc.id) }); toast(`Added ${name}`); }
      } else if (m === `rename`) {
        const name = await promptSheet(`Rename`, { label: `Name`, value: loc.name });
        if (name) repo.saveLocation({ id: loc.id, name });
      } else if (m === `move`) {
        moveSpot(loc);
      } else if (m === `qr`) printLabel(loc);
      else if (m === `delete`) {
        const n = repo.itemsIn(loc.id, true).length + repo.descendantIds(loc.id).size - 1;
        if (n) return toast(`Move or remove what’s inside first`);
        if (await confirmSheet(`Remove ${loc.name}?`, `This place is empty.`, `Remove`, true)) { repo.deleteLocation(loc); location.hash = loc.parentId ? `#/place/${loc.parentId}` : `#/places`; }
      }
    };
  });
}

async function printLabel(loc) {
  lic.count(`qr.labelPrint`);
  const url = `${location.origin}${location.pathname}#/place/${loc.id}`;
  let svg = ``;
  try {
    await new Promise((res, rej) => {
      if (window.qrcode) return res();
      const s = document.createElement(`script`);
      s.src = `https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js`;
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    const qr = window.qrcode(0, `M`); qr.addData(url); qr.make();
    svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch { return toast(`QR needs a connection the first time`); }
  const items = repo.itemsIn(loc.id, true);
  const w = window.open(``, `_blank`);
  if (!w) return toast(`Allow pop-ups to print labels`);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(loc.name)} label</title>
    <style>body{font-family:system-ui,sans-serif;margin:24px;color:#111}.label{display:flex;gap:16px;align-items:center;border:2px dashed #999;padding:16px;width:fit-content;border-radius:12px}
    .label svg{width:140px;height:140px}.n{font-size:22px;font-weight:700}.p{color:#555;font-size:13px;margin-top:4px}ul{columns:2;font-size:13px;color:#333;max-width:640px}
    @media print{button{display:none}}</style></head><body>
    <div class="label">${svg}<div><div class="n">${esc(loc.name)}</div><div class="p">${esc(repo.pathText(loc.id))}</div><div class="p">Scan in Paran (QR button by the search bar) to see what’s inside</div></div></div>
    ${items.length ? `<h3>Inside (${items.length})</h3><ul>${items.map((i) => `<li>${esc(i.name)}</li>`).join(``)}</ul>` : ``}
    <p><button onclick="print()">Print</button></p></body></html>`);
  w.document.close();
}

/** Explicit opt-in for AI suggestions: explains the data flow, needs a checkbox + a working key. */
function aiConsent(keyOnly = false) {
  return new Promise((resolve) => {
    let done = false;
    sheet(keyOnly ? `Change Gemini key` : `AI suggestions`, (el, close) => {
      el.innerHTML = `<form class="stack consent">
        ${keyOnly ? `` : `<div class="consent-points">
          <p>${icon(`camera`)}<span>When you use it, a reduced copy of the photo is sent <b>from this phone directly to Google Gemini</b>, using your own API key. Paran never sees it.</span></p>
          <p>${icon(`alert`)}<span>On Gemini’s <b>free tier</b>, Google may use what you send to improve its products, and people at Google may review it. Don’t photograph IDs, documents or anything private with AI on. Paid-tier keys aren’t used that way.</span></p>
          <p>${icon(`check`)}<span>You always review suggestions before anything is saved. Nothing you typed gets overwritten.</span></p>
          <p>${icon(`cloud`)}<span>The free tier allows a few hundred photos a day (check your limits in Google AI Studio). One photo of a bin can list many items.</span></p>
        </div>`}
        <ol class="key-steps">
          <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in.</li>
          <li>Tap <b>Create API key</b>, then copy it.</li>
          <li>Paste it below. It’s stored only on this device, not in your Sheet.</li>
        </ol>
        <label class="field"><span>Gemini key</span><input name="key" autocomplete="off" spellcheck="false" placeholder="AIza…" required></label>
        ${keyOnly ? `` : `<label class="check"><input type="checkbox" name="agree" required><span>I understand that photos I choose to analyze are sent to Google Gemini.</span></label>`}
        <p class="error-box" hidden></p>
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button class="btn primary">${keyOnly ? `Save key` : `Verify &amp; turn on`}</button></div>
      </form>`;
      const form = $(`form`, el); const err = $(`.error-box`, el);
      $(`[data-no]`, el).onclick = () => { done = true; resolve(false); close(); };
      form.onsubmit = async (e) => {
        e.preventDefault();
        const key = form.elements.key.value.trim();
        const btn = form.querySelector(`button.primary`); btn.disabled = true; btn.textContent = `Checking key…`; err.hidden = true;
        try {
          const model = await verifyKey(key);
          saveAiSettings({ enabled: true, key, model, consentAt: aiSettings().consentAt || new Date().toISOString() });
          done = true; resolve(true); close();
          toast(keyOnly ? `Key updated` : `AI suggestions are on`);
        } catch (ex) {
          err.textContent = ex.message || String(ex); err.hidden = false;
          btn.disabled = false; btn.innerHTML = keyOnly ? `Save key` : `Verify &amp; turn on`;
        }
      };
    }, { onClose: () => { if (!done) resolve(false); } });
  });
}

// ============================================================ licensing (off unless CONFIG.LICENSE_URL is set)
const LOG_COUNTERS = { added: `item.add`, edited: `item.edit`, moved: `item.move`, removed: `item.remove`, missing: `item.missing`,
  found: `item.found`, lent: `lend.out`, returned: `lend.return`, reserved: `reserve.create`, unreserved: `reserve.cancel` };
let licRepo = null; let licListening = false; let lastBlocked = false;
const licDismissed = new Set();

function attachLic() {
  if (!lic.on() || licRepo === repo) return;
  licRepo = repo;
  repo.addEventListener(`logged`, (e) => {
    const c = LOG_COUNTERS[e.detail.action]; if (c) lic.count(c);
    if (e.detail.photo) lic.count(`photo.add`);
  });
  repo.addEventListener(`status`, () => { if (repo.status === `synced`) lic.tick(); });
  lic.setContext(licContext);
  lic.setGauges(() => ({
    items: repo.activeItems().length, places: repo.locations.filter((l) => !l.deleted).length,
    inventories: 1, activeEvents: 0, aiEnabled: aiReady() ? 1 : 0,
  }));
  if (!licListening) {
    licListening = true;
    lic.addEventListener(`change`, onLicChange);
    lic.addEventListener(`update-required`, () => toast(`Please update ${CONFIG.APP_NAME} to keep using it`, { action: `Update`, ms: 15000, onAction: () => location.reload() }));
  }
  setTimeout(maybeAskConsent, 1500);
  lic.tick(true);
}

/** What the licensing client needs to know about the open inventory. */
function licContext() {
  if (!repo) return null;
  const b = repo.backend;
  if (b.kind !== `google`) return { demo: true, tenantId: null };
  if (!b.tenantId) return null; // a member of a group whose owner hasn't opened this version yet: fail open
  const ownerRow = repo.members.find((m) => m.role === `owner`);
  return {
    tenantId: b.tenantId, inventoryId: b.sheetId, isOwner: b.isOwner, role: b.isOwner ? `owner` : `editor`,
    sources: b.tenantSources || { appProperties: null, metaTab: null }, email: repo.user?.email || null, copiedFrom: b.copiedFrom || null,
    createdAt: ownerRow?.joinedAt || undefined,
    inventories: [{ inventoryId: b.sheetId, photoFolderId: b.rootFolderId || null, createdAt: ownerRow?.joinedAt || new Date().toISOString(),
      legacy: b.sheetName === CONFIG.LEGACY_SHEET_NAME }],
    collectAccess: async () => ({
      files: (await b.listAccess()).map((f) => ({ fileId: f.fileId, kind: f.kind, inventoryId: f.inventoryId, general: f.general,
        people: f.perms.map((p) => ({ email: p.emailAddress, role: p.role, type: p.type })) })),
      membersTab: repo.members.map((m) => m.email),
    }),
    rekey: () => b.rekeyTenant(),
  };
}

function onLicChange() {
  renderLicBar();
  const blocked = lic.blocked();
  const r = route().name;
  if (blocked !== lastBlocked && r !== `add` && r !== `edit`) { lastBlocked = blocked; render(); return; }
  lastBlocked = blocked;
  if (r === `more` && !document.querySelector(`.sheet-wrap.open`)) render();
}

/** One line under the top bar, written by the server (so wording can change without an app release). */
function renderLicBar() {
  const el = $(`#licbar`); if (!el || !repo) return;
  const v = lic.view();
  const owner = repo.backend.kind === `google` && repo.backend.isOwner;
  const mine = v.messages.filter((m) => (owner ? m.audience === `owner` : m.audience === `all`) && !licDismissed.has(m.id));
  const m = mine[0] || (owner ? v.messages.find((x) => x.audience === `all` && !licDismissed.has(x.id)) : null);
  if (!m || lic.blocked()) { el.hidden = true; el.innerHTML = ``; return; }
  const act = { open_people: `Manage people`, upgrade: `Upgrade`, turn_off_link_sharing: `Open sharing`, update_app: `Update` }[m.action];
  el.hidden = false;
  el.className = `licbar ${m.severity}`;
  el.innerHTML = `${icon(m.severity === `info` ? `info` : `alert`)}<span>${esc(m.text)}</span>
    ${act ? `<button type="button" class="btn small" data-act="${esc(m.action)}">${act}</button>` : ``}
    ${m.dismissible ? `<button type="button" class="icon-btn" data-dismiss aria-label="Dismiss">${icon(`x`)}</button>` : ``}`;
  el.onclick = (e) => {
    if (e.target.closest(`[data-dismiss]`)) { licDismissed.add(m.id); renderLicBar(); return; }
    const a = e.target.closest(`[data-act]`)?.dataset.act; if (!a) return;
    if (a === `open_people`) { location.hash = `#/more?people=1`; if (route().name === `more`) render(); }
    else if (a === `upgrade`) upgradeNow();
    else if (a === `turn_off_link_sharing`) window.open(repo.backend.sheetUrl, `_blank`, `noopener`);
    else if (a === `update_app`) location.reload();
  };
}

function viewBlocked(view) {
  const v = lic.view();
  const owner = repo.members.find((m) => m.role === `owner`)?.email;
  const locked = v.reason === `locked` || v.state === `locked`;
  view.innerHTML = `<div class="blocked">
    <div class="brand-mark">${icon(`users`)}</div>
    <h1>${locked ? `This group is paused` : `This group is over its free limit`}</h1>
    <p class="muted">${locked ? `The owner needs to fix how this inventory is shared before others can use it.`
      : `${owner ? esc(owner) : `The owner`} can choose who keeps access, or upgrade the group. You’ll be back in as soon as they do.`}</p>
    <div class="stack"><button class="btn primary" id="lictry">Check again</button><a class="btn ghost" href="#/more">More</a></div>
  </div>`;
  $(`#lictry`).onclick = async (e) => {
    e.target.disabled = true;
    await lic.tick(true); render();
    if (lic.blocked()) toast(`Still waiting on the owner`);
  };
}

/** What Paran sends, and the choice about usage counts. ask = first time (two buttons). */
function privacySheet({ ask = false } = {}) {
  let answered = false;
  sheet(`What ${CONFIG.APP_NAME} sends`, (el, close) => {
    el.innerHTML = `<div class="stack consent">
      <div class="consent-points">
        <p>${icon(`cloud`)}<span>Your inventory stays in <b>your own Google Drive</b>. ${esc(CONFIG.APP_NAME)} never sees item names, notes, places or photos.</span></p>
        <p>${icon(`users`)}<span>To run free and paid plans, ${esc(CONFIG.APP_NAME)} checks your group with its licensing server: a random code for this phone, scrambled codes for the people the inventory is shared with (not their emails), and when each person last opened it.</span></p>
        <p>${icon(`spark`)}<span><b>Usage counts</b> (how many items you have, how often things like lending or scanning are used) help improve ${esc(CONFIG.APP_NAME)}. These are optional.</span></p>
        <p>${icon(`clock`)}<span>Kept for 2 years.</span></p>
      </div>
      ${ask ? `<div class="row-actions"><button type="button" class="btn ghost" data-no>Don’t send usage counts</button><button type="button" class="btn primary" data-yes>OK</button></div>`
        : `<label class="menu-switch"><span>Send usage counts</span><span class="switch"><input type="checkbox" data-usage ${lic.usageAllowed() ? `checked` : ``}><i></i></span></label>`}
    </div>`;
    $(`[data-yes]`, el)?.addEventListener(`click`, () => { answered = true; lic.setConsent(true); close(); });
    $(`[data-no]`, el)?.addEventListener(`click`, () => { answered = true; lic.setConsent(false); close(); });
    $(`[data-usage]`, el)?.addEventListener(`change`, (e) => lic.setConsent(e.target.checked));
  }, { onClose: () => { if (ask && !answered) setTimeout(maybeAskConsent, 60_000); } }); // closed without choosing: ask again later
}

function maybeAskConsent() {
  if (!lic.needsConsent() || !$(`#view`)) return;
  if (document.querySelector(`.sheet-wrap.open`) || [`add`, `edit`, `setup`].includes(route().name)) { setTimeout(maybeAskConsent, 20_000); return; }
  privacySheet({ ask: true });
}

const ROLE_LABEL = { owner: `Owner`, writer: `Can edit`, commenter: `Can comment`, reader: `View only` };
const RANK = { owner: 4, writer: 3, commenter: 2, reader: 1 };

/** Everyone with access to this inventory in Drive, with last-opened and kept status from the licensing server. */
async function loadPeople() {
  const files = await repo.backend.listAccess();
  const server = await lic.members().catch(() => []);
  const byHash = new Map(server.map((m) => [m.emailHash, m]));
  const onTab = new Set(repo.members.map((m) => String(m.email).toLowerCase()));
  const map = new Map();
  for (const f of files) {
    for (const p of f.perms) {
      const email = String(p.emailAddress || ``).toLowerCase(); if (!email) continue;
      const cur = map.get(email) || { email: p.emailAddress, name: p.displayName || ``, type: p.type, sheetRole: null, folderRole: null };
      if (f.kind === `sheet` && (!cur.sheetRole || RANK[p.role] > RANK[cur.sheetRole])) cur.sheetRole = p.role;
      if (f.kind !== `sheet` && (!cur.folderRole || RANK[p.role] > RANK[cur.folderRole])) cur.folderRole = p.role;
      map.set(email, cur);
    }
  }
  const people = await Promise.all([...map.values()].map(async (p) => {
    const hash = await emailHash(p.email); const s = byHash.get(hash);
    return { ...p, hash, isOwner: p.sheetRole === `owner`, lastOpenedAt: s?.lastOpenedAt || null, kept: s ? s.kept : true,
      viaDrive: p.sheetRole !== `owner` && !onTab.has(p.email.toLowerCase()) };
  }));
  people.sort((a, b) => (b.isOwner - a.isOwner) || String(a.lastOpenedAt || ``).localeCompare(String(b.lastOpenedAt || ``)));
  return { people, linkShared: files.some((f) => f.general !== `restricted`) };
}

const openedText = (iso) => (iso ? `Opened ${timeAgo(iso)}` : `Never opened ${esc(CONFIG.APP_NAME)}`);

async function renderPeople(el) {
  const v = lic.view();
  const over = v.enforced && (v.seats.unknowable || (v.seats.cap != null && v.seats.used > v.seats.cap));
  const seats = v.enforced && v.seats.cap != null
    ? `<div class="seats${over ? ` over` : ``}"><span><b>${v.seats.used} of ${v.seats.cap}</b> people${v.plan ? ` · ${esc(v.plan[0].toUpperCase() + v.plan.slice(1))} plan` : ``}</span>
        ${v.seats.used >= v.seats.cap ? `<button type="button" class="btn small" data-up>Upgrade</button>` : ``}</div>` : ``;
  el.innerHTML = `${seats}<div class="list"><div class="list-row">${icon(`clock`)}<span class="muted">Checking who has access…</span></div></div>`;
  let data;
  try { data = await loadPeople(); }
  catch (e) {
    el.innerHTML = `${seats}<div class="list">${repo.members.map((m) => `<div class="list-row">${icon(`users`)}<span>${esc(m.email)}</span><small>${m.role === `owner` ? `Owner` : `Can edit`}</small></div>`).join(``)}</div>
      <p class="fine">Couldn’t check Google Drive just now${e.message ? ` (${esc(e.message)})` : ``}.</p>`;
    return;
  }
  const { people, linkShared } = data;
  const keepersOn = v.enforced && (v.state === `grace` || v.state === `restricted`) && people.length > 1;
  el.innerHTML = `${seats}
    ${linkShared ? `<p class="note">${icon(`alert`)} Anyone with the link can open this inventory, so it can’t be counted. <a href="${esc(repo.backend.sheetUrl)}" target="_blank" rel="noopener">Turn off link sharing</a> in Google Drive.</p>` : ``}
    <div class="list people">
      ${people.map((p) => `<div class="list-row person">
        ${icon(p.isOwner ? `home` : `users`)}
        <span><b>${esc(p.name || p.email)}</b>
          <small>${p.name ? `${esc(p.email)} · ` : ``}${p.isOwner ? `Owner` : p.sheetRole ? ROLE_LABEL[p.sheetRole] : `Photos only`}${p.type === `group` ? ` · Google Group` : ``}</small>
          <small>${p.isOwner ? `` : openedText(p.lastOpenedAt)}${p.viaDrive ? `${p.isOwner ? `` : ` · `}<em class="tag">Added in Google Drive</em>` : ``}${keepersOn && v.state === `restricted` && !p.isOwner && !p.kept ? ` · <em class="tag bad">No access</em>` : ``}</small></span>
        ${p.isOwner ? `` : `<button type="button" class="btn small ghost" data-remove="${esc(p.email)}">Remove</button>`}
      </div>`).join(``)}
    </div>
    ${keepersOn ? `<button type="button" class="btn primary full" data-keepers>Choose who keeps access</button>` : ``}`;
  el.onclick = async (e) => {
    if (e.target.closest(`[data-up]`)) { upgradeNow(); return; }
    if (e.target.closest(`[data-keepers]`)) { keepersSheet(people, v); return; }
    const email = e.target.closest(`[data-remove]`)?.dataset.remove; if (!email) return;
    if (!(await confirmSheet(`Remove ${email}?`, `They lose access to this inventory and its photos in Google Drive. Nothing in the inventory is deleted.`, `Remove`, true))) return;
    try {
      const removed = await repo.backend.removeAccess(email);
      lic.count(`member.remove`); lic.markAccessDirty();
      toast(`Removed ${email}`, { action: `Undo`, ms: 8000, onAction: async () => {
        try { await repo.backend.restoreAccess(email, removed); lic.markAccessDirty(); await lic.tick(true); renderPeople(el); toast(`Access restored`); }
        catch (err) { toast(`Couldn’t restore: ${err.message}`); }
      } });
      await lic.tick(true);
      renderPeople(el);
    } catch (err) { toast(`Couldn’t remove: ${err.message}`); }
  };
}

function keepersSheet(people, v) {
  const others = people.filter((p) => !p.isOwner);
  const max = Math.max(0, (v.seats.cap ?? others.length + 1) - 1);
  const chosen = new Set(v.state === `restricted` ? others.filter((p) => p.kept).map((p) => p.hash) : []);
  sheet(`Choose who keeps access`, (el, close) => {
    const draw = () => {
      el.innerHTML = `<p class="muted">You can keep ${max} ${max === 1 ? `person` : `people`} besides yourself on the free plan.
        ${v.graceEndsAt && v.state === `grace` ? `Everyone else can’t open this group in ${esc(CONFIG.APP_NAME)} from ${esc(new Date(v.graceEndsAt).toLocaleDateString())}.` : ``}
        They keep their Google Drive access until you remove them.</p>
        <div class="list">${others.map((p) => `<label class="list-row check"><input type="checkbox" value="${esc(p.hash)}" ${chosen.has(p.hash) ? `checked` : ``}>
          <span><b>${esc(p.name || p.email)}</b><small>${esc(openedText(p.lastOpenedAt))}</small></span></label>`).join(``)}</div>
        <p class="fine">${chosen.size} of ${max} chosen</p>
        <p class="error-box" hidden></p>
        <div class="row-actions"><button type="button" class="btn ghost" data-no>Cancel</button><button type="button" class="btn primary" data-save ${chosen.size > max ? `disabled` : ``}>Save</button></div>`;
      el.querySelectorAll(`input[type=checkbox]`).forEach((c) => { c.onchange = () => { if (c.checked) chosen.add(c.value); else chosen.delete(c.value); draw(); }; });
      $(`[data-no]`, el).onclick = close;
      $(`[data-save]`, el).onclick = async (e) => {
        e.target.disabled = true;
        try { await lic.setKeepers([...chosen]); close(); toast(`Saved`); render(); }
        catch (err) { const box = $(`.error-box`, el); box.textContent = err instanceof LicError && err.data?.detail ? err.data.detail : err.message; box.hidden = false; e.target.disabled = false; }
      };
    };
    draw();
  });
}

function inviteBlockedSheet(why) {
  const text = {
    full: `Your group has reached the people included in its plan. Remove someone, or upgrade to add more.`,
    plan: `Inviting people isn’t included in this group’s plan.`,
    restricted: `Sharing is off because this group is over its free limit. Choose who keeps access or remove people first.`,
    locked: `Sharing is paused until this inventory’s sharing in Google Drive matches the group again.`,
  }[why] || ``;
  sheet(why === `full` ? `Your group is full` : `Sharing is off`, (el, close) => {
    el.innerHTML = `<p class="muted">${esc(text)}</p><div class="row-actions">
      <button type="button" class="btn ghost" data-people>Manage people</button><button type="button" class="btn primary" data-up>Upgrade</button></div>`;
    $(`[data-people]`, el).onclick = () => { close(); location.hash = `#/more?people=1`; };
    $(`[data-up]`, el).onclick = () => { close(); upgradeNow(); };
  });
}

async function upgradeNow() {
  try { const r = await lic.checkout(`group`); if (r?.url) window.open(r.url, `_blank`, `noopener`); }
  catch (e) { toast(e.status === 501 || e.code === `not_implemented` ? `Upgrades aren’t available yet` : `Couldn’t open the upgrade page: ${e.message}`); }
}

function licDebugHtml() {
  if (!lic.stub) return ``;
  const d = lic.stub.debug(); const v = lic.view();
  const sel = (name, opts, cur) => `<select data-dbg="${name}">${opts.map((o) => `<option value="${o}" ${String(cur) === o ? `selected` : ``}>${o || `(computed)`}</option>`).join(``)}</select>`;
  return `<div class="label-sm">Licensing test</div>
    <div class="menu dbg">
      <div class="menu-info">${icon(`info`)}<div><b>Stub server · ${esc(v.has ? `${v.mode} · ${v.state}` : `no answer yet`)}</b>
        <small>${v.has ? `${v.seats.used} of ${v.seats.cap ?? `∞`} people${v.seats.unknowable ? ` · link sharing` : ``} · ${v.decision}${v.you.blocked ? ` · you’re blocked` : ``}` : `Opens after the first check`}</small></div></div>
      <label class="dbg-row"><span>Mode</span>${sel(`mode`, [`observe`, `enforce`], d.mode)}</label>
      <label class="dbg-row"><span>Force state</span>${sel(`force`, [``, `ok`, `grace`, `restricted`, `locked`], d.force)}</label>
      <label class="dbg-row"><span>Free limit (people)</span><input type="number" min="1" max="50" value="${esc(d.cap)}" data-dbg="cap"></label>
      <label class="dbg-row"><span>Grace (days)</span><input type="number" min="0" max="60" step="0.01" value="${esc(d.graceDays)}" data-dbg="graceDays"></label>
      <button data-m="licnow">${icon(`cloud`)} Check now</button>
      <button data-m="licsent">${icon(`sheet`)} Last usage batch sent</button>
      <button data-m="licreset" class="danger">${icon(`trash`)} Reset test server</button>
    </div>`;
}

// ============================================================ More
function viewMore(view, r) {
  const g = repo.backend.kind === `google`;
  const total = repo.activeItems().length;
  const places = repo.locations.filter((l) => !l.deleted).length;
  view.innerHTML = `
    <div class="more">
      <h1>More</h1>
      <div class="account">
        ${repo.user.picture ? `<img src="${esc(repo.user.picture)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${esc((repo.user.name || `?`)[0])}</div>`}
        <div><b>${esc(repo.user.name)}</b><small>${esc(repo.user.email)}</small><small class="where-data">${icon(g ? `cloud` : `alert`)} ${esc(repo.label)}</small></div>
      </div>
      <div class="stats"><div><b>${total}</b><span>items</span></div><div><b>${places}</b><span>places</span></div>
        <div><b>${repo.activeItems().filter((i) => i.status === `lent`).length}</b><span>lent out</span></div></div>

      ${g ? `<div class="label-sm" id="people">People</div>
      ${lic.on() && repo.backend.canShare ? `<div id="people-lic"></div>` : `<div class="list">
        ${repo.members.map((m) => `<div class="list-row">${icon(`users`)}<span>${esc(m.email)}</span><small>${m.role === `owner` ? `Owner` : `Can edit`}</small></div>`).join(``)}
      </div>`}
      ${repo.backend.canShare ? (lic.inviteCheck().ok || lic.inviteCheck().why === `full`
        ? `<form class="inline-new" id="invite"><input type="email" placeholder="Their Google email" required><button class="btn primary">Invite</button></form>
        <p class="fine">They get edit access to the sheet and can view photos. They open ${esc(CONFIG.APP_NAME)}, sign in, and choose “Join a shared inventory”.</p>`
        : `<p class="note">${icon(`alert`)} Sharing is off for this group right now.</p>`) : `<p class="fine">This inventory is shared with you. The owner can invite others.</p>`}` : ``}

      <div class="label-sm" id="ai">AI suggestions</div>
      ${aiReady() ? `<div class="menu">
          <div class="menu-info">${icon(`spark`)}<div><b>On</b><small>Model: ${esc(aiSettings().model)}</small><small>${aiUsageToday()} photo${aiUsageToday() === 1 ? `` : `s`} analyzed today on this device · resets 3 AM ET</small></div></div>
          <label class="menu-switch"><span>Suggest details from photos</span><span class="switch"><input type="checkbox" data-aiauto ${aiSettings().auto ? `checked` : ``}><i></i></span></label>
          <button data-m="aikey">${icon(`edit`)} Change Gemini key</button>
          <button data-m="aioff" class="danger">${icon(`x`)} Turn off and remove key</button>
        </div>`
        : `<div class="ai-card">${icon(`spark`)}<div><b>AI suggestions</b><p>Gemini can name what’s in a photo, say what it’s for, and list several items from one shot of a bin or shelf. Off until you turn it on.</p>
          <button class="btn primary" data-m="aion">Set up AI suggestions</button></div></div>`}

      <div class="label-sm">Your data</div>
      <div class="menu">
        ${g ? `<a href="${esc(repo.backend.sheetUrl)}" target="_blank" rel="noopener">${icon(`sheet`)} Open the Google Sheet</a>` : ``}
        <button data-m="csv">${icon(`download`)} Download spreadsheet (CSV)</button>
        <button data-m="sync">${icon(`cloud`)} Refresh now</button>
        ${lic.on() ? `<button data-m="privacy">${icon(`info`)} What ${esc(CONFIG.APP_NAME)} sends</button>` : ``}
      </div>
      ${licDebugHtml()}

      <div class="label-sm">Account</div>
      <div class="menu">
        ${g ? `<button data-m="signout">${icon(`out`)} Sign out</button>`
          : `${googleConfigured() ? `<button data-m="google">${googleG()} Sign in with Google</button>` : ``}
             <button data-m="reset" class="danger">${icon(`trash`)} Clear demo data</button>`}
      </div>
      <div class="label-sm">About</div>
      <div class="menu"><button data-m="about">${icon(`info`)} About ${esc(CONFIG.APP_NAME)}</button></div>

      <p class="fine center">${lic.on() ? `${esc(CONFIG.APP_NAME)} never sees what’s in your inventory.` : `${esc(CONFIG.APP_NAME)} stores nothing on any server.`} ${g ? driveWhere(repo.backend) : ``}</p>
    </div>`;

  $(`#invite`)?.addEventListener(`submit`, async (e) => {
    e.preventDefault();
    const input = e.target.querySelector(`input`);
    const check = lic.inviteCheck();
    if (check.why && !check.enforced) lic.count(`lic.wouldShow.${check.why}`);
    if (!check.ok) { inviteBlockedSheet(check.why); return; }
    const btn = e.target.querySelector(`button`); btn.disabled = true;
    try {
      await repo.invite(input.value.trim()); toast(`Invited ${input.value.trim()}`); input.value = ``;
      lic.count(`invite.send`); lic.markAccessDirty(); lic.tick(true);
    }
    catch (err) { toast(`Couldn’t invite: ${err.message}`); }
    finally { btn.disabled = false; }
  });
  const peopleEl = $(`#people-lic`);
  if (peopleEl) renderPeople(peopleEl);
  if (r?.params?.get(`people`) === `1`) setTimeout(() => $(`#people`)?.scrollIntoView({ block: `start` }), 50);
  view.querySelectorAll(`[data-dbg]`).forEach((c) => c.addEventListener(`change`, async () => {
    lic.stub.setDebug({ [c.dataset.dbg]: c.type === `number` ? Number(c.value) : c.value });
    await lic.tick(true); render();
  }));
  $(`[data-aiauto]`, view)?.addEventListener(`change`, (e) => saveAiSettings({ auto: e.target.checked }));
  if (r?.params?.get(`ai`) === `1` && !aiReady()) setTimeout(() => aiConsent().then((ok) => ok && render()), 50);

  view.onclick = async (e) => {
    const who = e.target.closest(`[data-person]`);
    if (who) { personSheet(who.dataset.person); return; }
    const m = e.target.closest(`[data-m]`)?.dataset.m; if (!m) return;
    if (m === `aion` || m === `aikey`) { if (await aiConsent(m === `aikey`)) render(); return; }
    if (m === `aioff`) {
      if (await confirmSheet(`Turn off AI suggestions?`, `The API key is removed from this device. Items already added keep their details.`, `Turn off`, true)) { disableAi(); render(); toast(`AI suggestions off`); }
      return;
    }
    if (m === `about`) { aboutSheet(); return; }
    if (m === `privacy`) { privacySheet(); return; }
    if (m === `licnow`) { await lic.tick(true); render(); toast(`Checked`); return; }
    if (m === `licsent`) {
      const last = lic.stub?.lastUsage();
      sheet(`Last usage batch`, (el) => { el.innerHTML = last ? `<pre class="dbg-json">${esc(JSON.stringify(last.batch, null, 2))}</pre>` : `<p class="muted">Nothing sent yet. Batches go out every 6 hours or when the app is closed, after you allow usage counts.</p>`; });
      return;
    }
    if (m === `licreset` && await confirmSheet(`Reset the test server?`, `Forgets groups, sessions, keepers and usage on the in-browser stub.`, `Reset`, true)) {
      lic.stub.reset(); Object.keys(localStorage).filter((k) => k.startsWith(`lic.ent.`) || k.startsWith(`lic.reg.`)).forEach((k) => localStorage.removeItem(k));
      await lic.tick(true); render(); return;
    }
    if (m === `csv`) {
      lic.count(`export.csv`);
      const a = document.createElement(`a`);
      a.href = URL.createObjectURL(repo.exportCsv());
      a.download = `paran-inventory-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    }
    if (m === `sync`) { await repo.refresh(); toast(repo.status === `synced` ? `Up to date` : `Sync: ${repo.status}`); }
    if (m === `signout`) {
      if (repo.outbox.length && !(await confirmSheet(`Sign out?`, `${repo.outbox.length} change(s) haven’t reached Google yet and will be lost.`, `Sign out anyway`, true))) return;
      signOut(); [MODE_KEY, `stash.session`].forEach((k) => localStorage.removeItem(k)); location.hash = ``; location.reload();
    }
    if (m === `google`) { localStorage.removeItem(MODE_KEY); start(`google`, { interactive: true }); }
    if (m === `reset` && await confirmSheet(`Clear demo data?`, `Removes everything stored in this browser.`, `Clear`, true)) {
      localStorage.removeItem(`stash.cache.demo`); localStorage.removeItem(MODE_KEY); location.hash = ``; location.reload();
    }
  };
}

function aboutSheet() {
  sheet(`About ${CONFIG.APP_NAME}`, (el) => {
    el.innerHTML = `<div class="about">
      <div class="about-mark">${icon(`box`)}</div>
      <h3>Why “${esc(CONFIG.APP_NAME)}”</h3>
      <p>In Tamil homes, the <b>paran</b> (<span lang="ta">பரண்</span>) is the storage loft above the kitchen or hallway.
        Everything goes up there, and nobody remembers what’s in it.</p>
      <p>${esc(CONFIG.APP_NAME)} is that loft, except you can find things.</p>
      <h3>Your data stays yours</h3>
      <p>${repo.backend.kind === `google` ? `Everything lives in your own Google Drive.` : `In demo mode, everything stays in this browser.`} ${esc(CONFIG.APP_NAME)} ${lic.on() ? `never sees your inventory or photos; its only server checks your group’s plan.` : `has no server and never sees your inventory or photos.`}</p>
      <p class="fine center about-by">Made by AarvaKuzhu</p>
    </div>`;
  });
}

boot();
