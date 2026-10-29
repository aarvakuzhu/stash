// Optional AI suggestions via Google Gemini, using the user's OWN API key.
// Off by default; requires explicit consent. The key stays on this device (never written to the Sheet).
// Photos go from the device straight to Google's Gemini API; Paran has no server in between.
import { lic } from './licensing.js';

const SETTINGS_KEY = `stash.ai`;
const USAGE_KEY = `stash.ai.usage`;
export const AI_MODELS = [`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`]; // first available wins
const API = `https://generativelanguage.googleapis.com/v1beta`;
const MIN_GAP_MS = 4100; // stay under 15 requests/minute
let lastCallAt = 0;

export class AiError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // kind: key | daily | busy | network | blocked | other
}

// ---------------- settings
export function aiSettings() {
  try { return { enabled: false, key: ``, auto: true, model: AI_MODELS[0], ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || `{}`) }; }
  catch { return { enabled: false, key: ``, auto: true, model: AI_MODELS[0] }; }
}
export function saveAiSettings(patch) {
  const s = { ...aiSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  return s;
}
export function disableAi() { localStorage.removeItem(SETTINGS_KEY); }
export const aiReady = () => { const s = aiSettings(); return s.enabled && Boolean(s.key); };

// ---------------- usage counter (this device only; resets at midnight Pacific, like Google's daily quota)
const pacificDay = () => new Intl.DateTimeFormat(`en-CA`, { timeZone: `America/Los_Angeles` }).format(new Date());
export function aiUsageToday() {
  try { const u = JSON.parse(localStorage.getItem(USAGE_KEY) || `{}`); return u.day === pacificDay() ? u.count : 0; }
  catch { return 0; }
}
function bumpUsage() {
  localStorage.setItem(USAGE_KEY, JSON.stringify({ day: pacificDay(), count: aiUsageToday() + 1 }));
  lic.count(`ai.suggest`);
}

// ---------------- key check (does not use generation quota)
export async function verifyKey(key) {
  for (const model of AI_MODELS) {
    let res;
    try { res = await fetch(`${API}/models/${model}`, { headers: { 'x-goog-api-key': key } }); }
    catch { throw new AiError(`network`, `Couldn’t reach Google. Check your connection.`); }
    if (res.ok) return model;
    if (res.status === 404) continue; // model not offered to this key; try the next
    throw await toError(res);
  }
  throw new AiError(`other`, `None of the supported Gemini models are available to this key.`);
}

// ---------------- analysis
const SCHEMA = {
  type: `OBJECT`,
  properties: {
    items: {
      type: `ARRAY`,
      items: {
        type: `OBJECT`,
        properties: {
          name: { type: `STRING` },
          purpose: { type: `STRING` },
          category: { type: `STRING` },
          tags: { type: `ARRAY`, items: { type: `STRING` } },
          qty: { type: `INTEGER` },
          notes: { type: `STRING` },
          size: { type: `STRING` },
          box_2d: { type: `ARRAY`, items: { type: `INTEGER` } },
        },
        required: [`name`, `purpose`, `category`, `tags`, `qty`],
      },
    },
  },
  required: [`items`],
};

function prompt({ categories = [], location = `` }) {
  return [
    `You help catalog belongings for a home inventory app. People use it later to find things and to remember what they are for.`,
    `Identify the distinct physical items in this photo that someone would want to find later.`,
    `Ignore walls, floors, shelves, furniture and the container holding the items, unless the container is the only thing shown.`,
    `If one main item fills most of the photo, return only that item. Return at most 15 items, most useful first.`,
    `For each item:`,
    `- name: short and specific, 2 to 6 words. Include brand or model only if clearly readable.`,
    `- purpose: one short sentence on what a person would use it for (for example "Seal pipe threads when fixing leaks"). No marketing language.`,
    `- category: one short word or two.${categories.length ? ` Prefer one of these existing categories if it fits: ${categories.slice(0, 40).join(`, `)}.` : ``}`,
    `- tags: 3 to 6 lowercase search words, including common synonyms someone might type.`,
    `- qty: how many identical units are visible (1 if unsure).`,
    `- notes: visible model numbers, sizes, capacities or expiry dates; otherwise empty.`,
    `- size: how big the item is, one of: ${SIZES.join(`, `)}. Judge from surrounding objects; empty if you can't tell.`,
    `- box_2d: bounding box as [ymin, xmin, ymax, xmax] normalized to 0-1000.`,
    location ? `Context: the user says these items are stored in "${location}".` : ``,
    `Do not guess at things you cannot see. If you cannot identify anything, return an empty items list.`,
  ].filter(Boolean).join(`\n`);
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ``;
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SIZES = [`Pocket`, `Hand-held`, `Shoebox`, `Carry-on`, `Large`, `Furniture`];

const DESCRIBE_SCHEMA = {
  type: `OBJECT`,
  properties: {
    name: { type: `STRING` }, purpose: { type: `STRING` }, category: { type: `STRING` },
    tags: { type: `ARRAY`, items: { type: `STRING` } }, size: { type: `STRING` },
    model: { type: `STRING` }, details: { type: `STRING` },
  },
  required: [`name`, `purpose`, `category`, `tags`, `size`, `model`, `details`],
};

/**
 * Several photos of ONE item (all sides, labels, next to other things). Combines what's visible across them.
 * `current` = details already known, so the answer builds on them instead of starting over.
 */
export async function describeItem(images, current = {}, { categories = [] } = {}) {
  const known = Object.entries({ name: current.name, purpose: current.purpose, category: current.category, size: current.size, notes: current.notes })
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(`; `);
  const text = [
    `These ${images.length} photo${images.length > 1 ? `s all show the same single item` : ` shows one item`} for a home inventory app: different sides, close-ups of labels, or the item next to other things.`,
    `Combine what you can see across all photos. Do not guess anything you cannot see.`,
    known ? `Details already recorded (keep their wording when they are right): ${known}.` : ``,
    `- name: short and specific, 2 to 6 words; include brand or model only if legible.`,
    `- purpose: one short sentence on what a person would use it for.`,
    `- category: one or two words.${categories.length ? ` Prefer one of: ${categories.slice(0, 40).join(`, `)}.` : ``}`,
    `- tags: 3 to 6 lowercase search words including common synonyms.`,
    `- size: one of ${SIZES.join(`, `)}, judged from hands, furniture, rulers or other familiar objects in any photo; empty if you can't tell.`,
    `- model: brand and model or part number exactly as printed on any label; empty if none is legible.`,
    `- details: up to 3 short specs as one line separated by " · " (capacity, voltage, dimensions, filter size, expiry); empty if none visible.`,
  ].filter(Boolean).join(`\n`);
  const o = await callGemini(images, text, DESCRIBE_SCHEMA);
  return {
    name: str(o.name, 80), purpose: str(o.purpose, 200), category: str(o.category, 40),
    tags: (Array.isArray(o.tags) ? o.tags : []).map((t) => str(t, 30).toLowerCase()).filter(Boolean).slice(0, 8).join(`, `),
    size: SIZES.find((z) => z.toLowerCase() === String(o.size || ``).trim().toLowerCase()) || ``,
    model: str(o.model, 80), details: str(o.details, 160),
  };
}

/** Returns a cleaned list of suggested items. `image` is a JPEG Blob (~1024px). */
export async function analyzePhoto(image, context = {}) {
  const parsed = await callGemini([image], prompt(context), SCHEMA);
  return clean(parsed.items || []);
}

const SCAN_SCHEMA = {
  type: `OBJECT`,
  properties: {
    items: {
      type: `ARRAY`,
      items: {
        type: `OBJECT`,
        properties: {
          name: { type: `STRING` }, purpose: { type: `STRING` }, category: { type: `STRING` },
          tags: { type: `ARRAY`, items: { type: `STRING` } }, qty: { type: `INTEGER` }, notes: { type: `STRING` },
          size: { type: `STRING` }, photo: { type: `INTEGER` },
          box_2d: { type: `ARRAY`, items: { type: `INTEGER` } },
        },
        required: [`name`, `purpose`, `category`, `tags`, `qty`, `photo`],
      },
    },
  },
  required: [`items`],
};

/**
 * Several overlapping photos taken while panning across a shelf or room. Returns one list of
 * physical items (each listed once) with the photo that shows it best: item.photo is a 0-based index.
 */
export async function scanPhotos(images, { categories = [], location = `` } = {}) {
  const n = images.length;
  const text = [
    `You help catalog belongings for a home inventory app. People use it later to find things and to remember what they are for.`,
    `These ${n} photos were taken one after another while panning a camera across ${location ? `"${location}"` : `a shelf, closet or room`}. Neighbouring photos overlap, so the same physical item often appears in more than one photo.`,
    `List every distinct physical item someone would want to find later, each physical item ONCE even if it appears in several photos.`,
    `Two similar items in the same spot of overlapping photos are the same item; identical items side by side are one entry with qty.`,
    `Ignore walls, floors, shelving, furniture, fixtures and the photographer. Include boxes or bins only as items themselves when their contents are not visible.`,
    `Return at most 40 items, most useful first.`,
    `For each item:`,
    `- photo: the number (1 to ${n}) of the photo where it is most clearly and completely visible.`,
    `- box_2d: its bounding box in THAT photo as [ymin, xmin, ymax, xmax] normalized to 0-1000.`,
    `- name: short and specific, 2 to 6 words. Include brand or model only if clearly readable.`,
    `- purpose: one short sentence on what a person would use it for. No marketing language.`,
    `- category: one short word or two.${categories.length ? ` Prefer one of these existing categories if it fits: ${categories.slice(0, 40).join(`, `)}.` : ``}`,
    `- tags: 3 to 6 lowercase search words, including common synonyms someone might type.`,
    `- qty: how many identical units are visible (1 if unsure).`,
    `- notes: visible model numbers, sizes or capacities; otherwise empty.`,
    `- size: one of: ${SIZES.join(`, `)}, judged from surrounding objects; empty if you can't tell.`,
    `Do not guess at things you cannot see. If you cannot identify anything, return an empty items list.`,
  ].join(`\n`);
  const parsed = await callGemini(images, text, SCAN_SCHEMA);
  const raw = parsed.items || [];
  return clean(raw, 40).map((it, i) => ({ ...it, photo: Math.max(0, Math.min(n - 1, (parseInt(it._photo, 10) || 1) - 1)) }));
}

async function callGemini(images, promptText, schema) {
  const s = aiSettings();
  if (!s.enabled || !s.key) throw new AiError(`key`, `AI suggestions are not set up.`);
  if (!navigator.onLine) throw new AiError(`network`, `You’re offline. Fill in the details yourself, or try again later.`);

  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const body = {
    contents: [{ parts: [{ text: promptText }, ...await Promise.all(images.map(async (img) => ({ inline_data: { mime_type: `image/jpeg`, data: await blobToBase64(img) } })))] }],
    generationConfig: { response_mime_type: `application/json`, response_schema: schema, temperature: 0.2 },
  };

  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${API}/models/${s.model}:generateContent`, {
        method: `POST`,
        headers: { 'x-goog-api-key': s.key, 'Content-Type': `application/json` },
        body: JSON.stringify(body),
      });
    } catch { throw new AiError(`network`, `Couldn’t reach Google. Check your connection.`); }
    if (res.status === 429 && attempt === 0) {
      const err = await toError(res.clone());
      if (err.kind === `busy`) { await sleep(err.retryMs || 15000); lastCallAt = Date.now(); continue; }
      throw err;
    }
    break;
  }
  if (!res.ok) throw await toError(res);
  bumpUsage();

  const data = await res.json();
  const cand = data.candidates?.[0];
  if (!cand) throw new AiError(`blocked`, `Gemini didn’t return a result for this photo.`);
  if (cand.finishReason && ![`STOP`, `MAX_TOKENS`].includes(cand.finishReason)) {
    throw new AiError(`blocked`, `Gemini declined to describe this photo.`);
  }
  const text = (cand.content?.parts || []).map((p) => p.text || ``).join(``);
  try { return JSON.parse(text); } catch { throw new AiError(`other`, `Gemini’s answer couldn’t be read. Try again.`); }
}

const str = (v, max) => String(v ?? ``).replace(/\s+/g, ` `).trim().slice(0, max);
function clean(items, max = 15) {
  return items.slice(0, max).map((it) => {
    const box = Array.isArray(it.box_2d) && it.box_2d.length === 4 && it.box_2d.every((n) => Number.isFinite(n))
      ? it.box_2d.map((n) => Math.max(0, Math.min(1000, n))) : null;
    return {
      name: str(it.name, 80),
      purpose: str(it.purpose, 200),
      category: str(it.category, 40),
      tags: (Array.isArray(it.tags) ? it.tags : []).map((t) => str(t, 30).toLowerCase()).filter(Boolean).slice(0, 8).join(`, `),
      qty: Math.max(1, Math.min(999, parseInt(it.qty, 10) || 1)),
      notes: str(it.notes, 200),
      size: SIZES.find((z) => z.toLowerCase() === String(it.size || ``).trim().toLowerCase()) || ``,
      box: box && box[2] > box[0] && box[3] > box[1] ? box : null,
      _photo: it.photo,
    };
  }).filter((it) => it.name);
}

async function toError(res) {
  let j = {};
  try { j = await res.json(); } catch { /* ignore */ }
  const msg = j.error?.message || `${res.status}`;
  const details = JSON.stringify(j.error?.details || []);
  if (res.status === 400 && /api key|API_KEY/i.test(msg + details)) return new AiError(`key`, `Google says this API key isn’t valid. Check it in More → AI suggestions.`);
  if (res.status === 401 || res.status === 403) return new AiError(`key`, `This API key isn’t allowed to use Gemini. Create a key at aistudio.google.com and try again.`);
  if (res.status === 429) {
    if (/PerDay|per day|daily/i.test(msg + details)) {
      lic.count(`ai.error.daily`);
      return new AiError(`daily`, `You’ve used today’s free AI allowance. It resets at 3 AM Eastern (midnight Pacific). You can still add items yourself.`);
    }
    const m = /"retryDelay":"(\d+)s"/.exec(details);
    const e = new AiError(`busy`, `Too many AI requests in a minute. Wait a moment and try again.`);
    e.retryMs = m ? Number(m[1]) * 1000 + 500 : 15000;
    return e;
  }
  if (res.status >= 500) return new AiError(`other`, `Gemini is having trouble right now. Try again shortly.`);
  return new AiError(`other`, `Gemini error: ${msg}`);
}
