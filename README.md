# Stash – Home Inventory (PWA)

Know what you have, where it is, and what it's for. A static web app (no server, no database) that keeps everything in **the user's own Google Drive**:

```
My Drive/
└── Stash – Home Inventory/
    ├── Stash Inventory        ← Google Sheet: Items, Locations, Members, Log tabs
    └── Photos/                ← full-size photos (≤1600px JPEG)
```

The app only asks for the `drive.file` scope, so it can see **only the files it created** (or the one sheet someone picks to join). It cannot read anything else in the user's Drive.

## Screens

- **Find** (landing page, cards): greeting and search; category chips appear while searching. Then three count cards (**Items** opens the full list, **Out** turns amber when something is late, **Places**), **Needs attention** cards with a one-tap action (*Got it back* / *Picked up* / *Found it*), **Places** as photo tiles (a collage of what's inside), **Out now** person cards and **Recently added** photo cards (both scroll sideways). Items without a photo get a soft coloured tile. Typing replaces the dashboard with results; Select is on the results and All items lists.
- **Places**: your places and what's in them. Opening a place shows items kept **directly** in it, then each place inside it as a row with its item count (and how many places are inside it). Tap a row to **expand or collapse** its items in place; tap the **›** at the right to open that place. **Expand all / Collapse all** toggles every row; the open/closed state is remembered per place on the device. **Add item here** and **Scan many** are the main actions; Bring items here, Share, Move, Rename, QR label and Remove place are in the ⋯ menu (containers also show a **QR label** button).
- **+**: add an item. Photo, name, what it's for, where; category, quantity, extra search words, dates and notes are under *More details*. The tab bar is hidden while you fill it in.
- **Out**: everything lent or reserved, grouped by person, overdue pick-ups first. A red badge on the tab counts late pick-ups.
- **More**: account, people the inventory is shared with, AI suggestions, export.
- **Item page**: where it is, then **Move** and **Lend or reserve** (or *Got it back* / *Picked up* / *Found it*). Edit is the pencil; *Mark as missing* and *Remove* are in ⋯. **Back** returns to wherever you came from.
- **First run**: a new inventory opens **Where do you keep things?** Tap Home, Storage unit, Car… and rooms like Garage or Kitchen to create them in one go. It's also under Places → *Quick-add rooms and places*.

## What's in v1

- **Quick capture:** photo (resized on the phone), name, what it's for, location, optional category/tags/qty/warranty/expiry/notes. "Save & add another" keeps the same location for bulk logging.
- **Location hierarchy:** Place → Room → Container, with any depth. Recently used spots appear first.
- **Search by purpose:** matches name, "what it's for", tags, category, location and notes, with prefix and typo tolerance and a few synonyms ("fix a leak" finds plumber's tape). Every word must match.
- **Moving things around (every move has Undo):**
  - *One item:* **Move** on the item screen.
  - *Several items:* tap **Select** above any list (or long-press a card), tick items, then **Move**.
  - *From the destination:* open a place and tap **Bring items here** to search and tick items from anywhere.
  - *A whole bin or shelf:* open it and tap **Move this spot**; everything inside goes with it.
  - The place picker has a search box ("box 3", "garage shelf") and can create a new spot on the spot.
- **Reserve:** **Lend or reserve** on an item has two modes. *Lend now* is one tap on a name. *Reserve* holds it for someone with an optional pick-up-by date (Today, Tomorrow, In 3 days, Next week, or any date). Reserved items show "Reserved · Ravi · pick up by Thu" (red once late), stay reserved if moved, and appear in the **Out** tab and the person's view. **Picked up** turns it into a lend; **Cancel** (with Undo) releases it. Lending something reserved for someone else asks first. The date is stored in a new `dueAt` column, added automatically to older sheets after `thumb`.
- **More photos per item:** up to 6 (the main photo + 5), from any angle: other sides, labels, the item next to something for size. Add several at once from the camera or library. Tap any photo to swipe through them full screen; extra photos can be removed there.
- **AI merges what it sees across all photos** (when AI is on): each time photos are added it looks at all of the item's photos together and fills in what's missing: what it's for, category, search words, **size**, and the **model/specs** read from labels (added to Notes). It never overwrites what you typed; on a saved item there's Undo.
- **Size:** optional one-tap size on every item (Pocket, Hand-held, Shoebox, Carry-on, Large, Furniture), filled in by AI when it can tell from the photos. Shown on the item page and searchable ("hand-held", "small", "large").
- **Photos open inside the app:** tap an item's photo for full screen. Full-size photos are cached on the phone (most recent 150), so they open instantly and offline. Photos another member added show the preview, with a link to their Drive for the original.
- **Item history:** each item's page ends with a **History** list, newest first (last 5, then *Show all*): added, moved (from → to), edited (what changed, e.g. "Name: Stud finder → Zircon stud finder · Qty: 1 → 2"), saved for (with pick-up-by date), picked up, lent, returned, missing/found, with date, time and who did it when it wasn't you.
- **Before / after in History, with Restore:** whenever details change, by a person or by AI from photos, the item's History shows each changed field as old (struck through) → new. **Restore** (or **Restore all**) opens Edit with the earlier text filled in and highlighted; tap **Save** to restore it, or Cancel to leave things as they are. Exact old/new values are kept in the Log's `changes` column.
- **AI refines only its own work:** on a saved item, new photos can update fields AI filled earlier (recorded when the item was added), and fill empty ones, but never change text someone typed or restored.
- **People you lend to:** "Lend" takes a free-text name and drops down matching people you've lent to before (typing "RAVI" reuses "Ravi", so one person stays one person). Tap a borrower's name (on an item, in the **Lent out** filter's "Who has your things" strip, or in **More → People you lend to**) to see what they have now with *Got it back* / *Got everything back*, and their full history of items borrowed and returned with dates. People are derived from the **Log** tab, so there's no separate list to maintain.
- **Duplicate check (on the phone, no AI):** saving a new item whose name matches an existing one (plurals, punctuation, small typos and word order ignored) asks first: *Open it*, *Same one, it's here now* (moves it), *I have another (+qty)*, or *Save as a new item*. Matches in the same place are flagged more readily. In the AI multi-item review, items already in the chosen place are labelled "Already here" and start unticked. Save locks after the first tap.
- **Status:** Move, Lend (who has it), Got it back, Can't find / Found it. Every change is appended to the **Log** tab.
- **QR labels:** print a label for any bin or shelf. Scanning it with the phone camera opens that place in the app.
- **Sharing with people:** the owner invites by email (edit access to the sheet, view access to photos). They sign in and picks "Join a shared inventory".
- **Offline:** the app shell is cached and data is cached on the device. Changes made offline queue up and sync when the connection returns.
- **Export:** CSV (opens in Excel), or just open the Google Sheet.
- **Scan a QR label in the app:** the QR button in the Find search bar (and **Scan label** on Places) opens the camera inside Paran, so iPhone doesn't hand the link to Safari. Scanning a box or shelf label offers **See what's inside**, **Put items away here** (pick existing items to move in), **Add a new item here** and **Scan many into it**. Any place picker (Move, bulk Move, Add form) also has a QR button: scan the label on the box and the item goes there. Labels from another inventory or non-Paran codes are rejected with a message. Decoding uses the browser's BarcodeDetector where available (Android Chrome), otherwise the bundled jsQR (Apache-2.0, `js/vendor`).
- **Share with anyone (a copy, no app needed):** the share button on an item sends its photo, what it's for and (optionally) where it's kept through the phone's share sheet (WhatsApp, Messages, email). On a place, the share button (or ⋯ → *Share what's here*) sends everything inside, grouped by spot, as a **List** (text) or a **Picture** with photos (up to 80 items), optionally with what each is for. In **Select** mode, **Share** (next to Move) sends just the chosen items, as one list or grouped by where they're kept. Lists (Select mode and places) can go out as **List** (text), **Picture** (one image with thumbnails) or **Photos** (each item's full main photo as separate images, up to 10, with the list as the message). Recipients get a one-time copy; nothing in the inventory is shared. Without a share sheet (desktop), the text is copied and the picture downloaded.
- **Scan many (bulk onboarding, AI):** on any place, tap **Scan many**, then pan the camera slowly across a shelf or room. Auto mode keeps the sharpest new view every 2 s (up to 8 photos); you can also tap the shutter, remove a photo from the strip, or choose photos if the camera isn't available. All photos go to Gemini in **one request**, which returns each physical item once with the photo that shows it best; Stash crops each item and opens the review list (untick, rename, *Put somewhere inside* per item, Tick all). A one-time note explains that wide shots show more of the home. History records these items as added by *AI scan*.
- **AI suggestions (optional, off by default):** each user turns it on in **More → AI suggestions**, agrees to a plain-language notice, and pastes their own Gemini API key from aistudio.google.com/apikey. The key is stored only on that device, never in the Sheet. A per-photo switch on the Add screen ("Suggest details from photos") controls whether a photo is analyzed.
  - One item in the photo: empty fields are filled and marked "AI suggested" until edited. Anything the user typed is never overwritten.
  - Several items (an open bin or shelf): a review sheet lists each with a cropped photo. Untick, rename, choose the location, then **Add selected**.
  - Model `gemini-3.5-flash-lite` (falls back to `gemini-3.1-flash-lite`). Calls are paced under 15 per minute; hitting the daily limit shows a clear message and the user carries on manually.
  - Free-tier note shown at opt-in: Google may use free-tier content to improve its products, so don't analyze IDs or private documents.
- **Demo mode:** try everything without Google; data stays in that browser.

## Run it locally

```bash
cd stash
python3 -m http.server 8080
# open http://localhost:8080  → "Try it without an account"
```

It has to be served over http(s), not opened as a file, because it uses ES modules and a service worker.

## Google Cloud setup (one time, about 10 minutes)

1. Go to <https://console.cloud.google.com/>, create a project (e.g. `stash-inventory`).
2. **APIs & Services → Library:** enable **Google Drive API**, **Google Sheets API**, and **Google Picker API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - User type **External**, app name "Stash", your email as support contact.
   - Data access → add scope `.../auth/drive.file` (plus `openid`, `email`, `profile`).
   - Audience → while in **Testing**, add each person's Gmail under **Test users** (up to 100). Users not on the list can't sign in until you publish the app.
4. **Credentials → Create credentials → OAuth client ID** → type **Web application**.
   - Authorized JavaScript origins: `http://localhost:8080` and your hosting origin, e.g. `https://aarvakuzhu.github.io`. Origins only, with no path and no trailing slash.
   - No redirect URIs are needed (the app uses the popup token flow).
   - Copy the **Client ID** into `CLIENT_ID` in `js/config.js`.
5. **Credentials → Create credentials → API key** → restrict it to **Google Picker API** and to your website origins (HTTP referrers). Put it in `API_KEY`.
6. **Project number** (Dashboard → Project info, digits only) → `APP_ID`. The Picker needs it so a joined sheet is granted to the app.

The Client ID and API key are not secrets in a browser app; they are protected by the origin restrictions above.

## Host on GitHub Pages

1. Create a repo (e.g. `aarvakuzhu/stash`) and push the contents of this folder to `main`.
2. Repo **Settings → Pages → Deploy from branch → main / (root)**.
3. The app is at `https://aarvakuzhu.github.io/stash/`. Make sure `https://aarvakuzhu.github.io` is in the OAuth client's JavaScript origins.
4. On the phone, open the URL, then **Share → Add to Home Screen** (iOS) or **Install app** (Android Chrome).

After changing files, bump `VERSION` in `sw.js`. Stash opens from the copy on the phone (no network wait). A new version downloads in the background as one complete set (each file requested as `file?v=VERSION`, so GitHub's CDN can't hand back a stale copy mid-deploy) and is applied straight away if the app was just opened, or via the **Reload** prompt. If the app ever fails to start (e.g. a broken update), a startup check shows **Try again** and **Repair and reload** within seconds; Repair re-downloads the app files and never touches the inventory.

## Licensing (off by default)

Paran can report usage counts and check a group's plan and seats with a licensing server. It is **off** unless `LICENSE_URL` is set in `js/config.js`; with it empty the app behaves exactly as before (no extra calls, no extra writes to the Sheet). The contract and rules live in the Licensing project (`licensing-interface.md`, `licensing-phases.md`).

- `LICENSE_URL: \`stub\`` runs an in-browser fake server for building and testing. **More → Licensing test** switches between *observe* and *enforce*, forces a state, and changes the free limit and grace length.
- `LICENSE_URL: \`https://…/v1\`` uses the real server. Put its public signing key(s) in `LICENSE_KEYS` so answers verify offline on first open.
- What it adds when on: a group id in the Sheet (`appProperties.licTenant` on the Sheet and folder, and a hidden **Meta** tab); a one-time notice of what is sent, with usage counts optional; **More → People** for the owner, listing everyone with access in Google Drive, when they last opened Paran, and **Remove**; a banner, an invite limit, **Choose who keeps access**, and a screen for members who are over the limit, all driven by the server's answer.
- In *observe* mode (the pilot) nothing is applied; the app only records what it would have shown.
- Never sent: item names, purposes, notes, tags, photos, place names, or emails (people are sent as SHA-256 hashes).
- `js/licensing.js` is the client; `js/licensing-stub.js` is the fake server.

## How sharing works (and its limits)

- The owner taps **More → Invite**. That shares the sheet (edit) and the root folder (view) with the email and adds a row to **Members**.
- The invited person opens Paran, signs in, and chooses **Join a shared inventory**. The Google Picker grants the app access to that one sheet.
- Each item stores a small thumbnail (≈20 KB) inside the sheet, so **everyone always sees every photo thumbnail**. The full-size photo opens in Drive.
- Photos a member adds go to a "Stash photos (shared inventory)" folder in *their* Drive. It is shared with everyone on the Members list at the time they join; people invited later see the thumbnail, and need the photo shared to open the full size.

## Data model (Google Sheet)

| Tab | Columns |
|---|---|
| Items | id, name, purpose, category, tags, locationId, qty, status (home/lent/reserved/missing), lentTo (person), photoId, photoUrl, warranty, expiry, notes, addedBy, addedAt, updatedAt, updatedBy, deleted, thumb, dueAt (pick-up-by date), size, photos (additional photos: Drive id, link, small preview) |
| Locations | id, name, parentId, kind (place/room/container), notes, createdBy, createdAt, deleted |
| Members | email, role, photoFolderId, invitedBy, joinedAt |
| Log | ts, itemId, action, detail, by, info (what changed / moved from / pick-up date), changes (exact before/after per field, or which fields AI suggested when added) |

Rules for editing the sheet by hand: it's fine to edit cell values and to sort or filter **in a filter view**. Don't delete rows or rename the header row, because the app matches rows by `id` and columns by header name. Removing an item in the app sets `deleted`; it never deletes rows.

## Known limits in v1

- **Sign-in:** a browser-only app can't hold a long-lived Google session (that needs a server). Stash keeps Google's one-hour pass across app restarts, always opens straight into your inventory from the phone's copy, and renews the pass on your first tap after it runs out, using your saved account, so you normally see at most a brief Google popup and no account picker. Edits made meanwhile wait in the queue; the pill shows **Tap to sync**.
- If two people edit the *same* item at the same moment, the last save wins.
- AI suggestions use each user's own Gemini quota; the "photos analyzed today" count is per device, while Google's limit is per key's project.
- Google accounts only.

## Files

```
index.html              app shell
manifest.webmanifest    install metadata
sw.js                   offline cache for the app files (never caches Google data calls)
css/app.css             styles, light + dark
js/config.js            ← your Client ID, API key, project number
js/google.js            sign-in, Drive, Sheets, Picker wrappers
js/store.js             data layer: cache, offline outbox, Google + demo backends
js/search.js            purpose-aware search
js/ai.js                optional Gemini suggestions (consent, key check, pacing, quota errors)
js/licensing.js         usage counts, group plan and seats (off unless LICENSE_URL is set)
js/licensing-stub.js    in-browser fake licensing server for testing
js/image.js             on-device photo resize + thumbnail
js/ui.js                sheets, toasts, icons
js/app.js               screens and routing
icons/                  app icons
```
