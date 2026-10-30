// Fill these in from Google Cloud Console (see README.md, "Google Cloud setup").
// Leave CLIENT_ID empty to run in demo mode only (data stays in this browser).
export const CONFIG = {
  CLIENT_ID: `329365162340-knfv8v5juqt0nmlnruakbsp12o9nvk61.apps.googleusercontent.com`,       // OAuth 2.0 Client ID (Web application), ends with .apps.googleusercontent.com
  API_KEY: `AIzaSyCcaHYDWy1h3BFsIB0u5AA84EtDEWMr1k0`,         // API key restricted to the Google Picker API (only needed to join a shared inventory)
  APP_ID: `329365162340`,          // Google Cloud project NUMBER (digits only), used by the Picker

  APP_NAME: `Paran`,
  // Names used when creating a NEW inventory. Existing ones are found by their Drive tag
  // (appProperties.stash), never by name, so inventories created as "Stash" keep working unchanged.
  ROOT_FOLDER_NAME: `Paran Inventory`,
  SHEET_NAME: `Paran Inventory`,
  LEGACY_SHEET_NAME: `Stash Inventory`, // early pilot inventories; still offered when joining

  // Licensing (usage counts, group plan and seats). Empty = off: the app behaves exactly as before.
  // `stub` = an in-browser fake server for testing (More → Licensing test). Otherwise the server's base URL, e.g.
  // `https://license.example.com/v1`. Contract: Licensing project, licensing-interface.md.
  LICENSE_URL: ``,
  LICENSE_APP_ID: `paran`,
  LICENSE_KEYS: [], // the server's public signing key(s) as JWK, so entitlements verify on first open, offline
  // How long the owner's sharing keeps working when the plan can't be checked (server blocked or unreachable, or
  // identity never confirmed). null = no limit (the pilot). Once a group has been in enforce mode it's always 7 days.
  LICENSE_FAIL_OPEN_DAYS: null,
};

export const SCOPES = [
  `https://www.googleapis.com/auth/drive.file`, // only files this app creates or the user picks
  `openid`,
  `email`,
  `profile`,
].join(` `);
