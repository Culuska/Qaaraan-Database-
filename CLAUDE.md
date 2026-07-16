# CLAUDE.md

Guidance for Claude Code (or any future session) working in this repo.

## What this is

Qaaraan is a Somali-language web app for managing a community savings fund
(monthly dues, member balances, community disbursements like weddings/funerals,
accounts payable, bank/cash accounts, and staff permissions). Somali is the
default language, with an EN/SO toggle (see "Internationalization" below) —
**keep any new UI text in both languages, using the `t()` helper.**

## Files

- `index.html` — the entire frontend. Vanilla JS, no framework, no build step,
  no bundler. One `<script>` block at the bottom of the file holds all app
  logic. CSS is inline in a `<style>` block. External deps loaded via CDN
  `<script>`/`<link>` tags: Tabler Icons, SheetJS (`xlsx`), jsPDF.
- `api/data.js` — Vercel serverless function. Implements `GET /api/data`
  (returns `{ value: <JSON string> }`) and `POST /api/data` (accepts
  `{ value: <JSON string> }`), matching the blob contract `index.html`
  expects. Underneath, it stores the state in the real relational tables
  from `schema.sql` via `@neondatabase/serverless`'s `Pool` — every save
  wraps a full delete-and-reinsert of every table in one transaction, so the
  tables always exactly mirror the last blob the frontend sent. It also
  runs the schema DDL (`CREATE TABLE IF NOT EXISTS ...`) on every request.
  **The DDL is inlined in this file and duplicated from `schema.sql` — if
  you change one, change the other.**
- `schema.sql` — Postgres schema for Neon, defining **relational** tables
  (`members`, `transactions`, `disbursements`, `users`, `accounts`,
  `payables`, `activity_log`, `pending_actions`, `app_settings`). Kept as a
  reference / for running manually in the Neon SQL editor; `api/data.js`
  has its own copy of the same DDL that actually executes at runtime.
- `package.json` — single dependency: `@neondatabase/serverless`.
- `README.md` — Somali-language deploy walkthrough (GitHub → Vercel → Neon).

## ⚠️ Known gaps / open questions (read before doing DB work)

1. **`api/data.js`'s save is a full snapshot replace, not incremental
   upserts.** Every `saveDb()` call from the frontend deletes and
   re-inserts every row in every table inside one transaction. This is
   correct and simple at this data scale (~100 members), but it means two
   concurrent saves (e.g. two staff members submitting at once) could race
   — last write wins, potentially dropping the other's change. Fine for now
   given the app has no concurrent-editing UI signal either way; revisit if
   this becomes a real usage pattern.
2. **PII baked into `index.html` source.** Near the top of the `<script>`
   block, four constants (`SEED_MEMBERS`, `GROUPS`, `HISTORY_REPORTS`,
   `JOURNAL_DISBURSEMENTS`) hold real member names, phone numbers, and
   historical financial transactions, hardcoded as JS literals directly in
   the HTML file. Because `index.html` is static frontend code, **this data
   ships to every browser that loads the page — before login, before the
   auth gate renders.** `renderAuthGate()` only hides the app *UI*; it
   doesn't prevent the HTML/JS (and therefore the embedded seed data) from
   being downloaded. If the Vercel deployment is publicly reachable, this is
   a real privacy exposure for real people. Flag this to the project owner;
   don't silently ship more data into these constants, and don't remove them
   without discussing the migration path (they're used as one-time seed/
   import data — see `fixLegacyHistoryImport`, `addMissingSeedMembers`,
   `importCreditMemosAsDisbursements`, `importJournalDisbursements`).

## Conventions to preserve

- **Destructive actions need typed/step confirmation.** Reuse the existing
  `openModal()` / `closeModal()` pattern (see member delete: a two-step modal
  where the second step requires typing the member's serial number). Don't
  invent a new confirmation UI.
- **Permissions model:** `currentUserObj.role` is `"admin"` or `"staff"`.
  Staff have a `permissions` object with boolean keys from `PERM_KEYS`
  (`addCustomer`, `collectPayment`, `delete`, `deactivate`, `viewReports`).
  Check permissions with `hasPerm(key)` / `isAdmin()`.
- **Non-admin mutations go through `attemptAction(type, payload, permKey, label)`**
  in `index.html`, not directly through `applyAction()`. Admins apply
  immediately; staff get queued into `db.pendingActions` for admin
  approval/rejection (see the "Pending approvals" tab). Any new mutating
  feature (new customer, payment, write-off, delete, status change,
  disbursement) should go through this same `attemptAction` path, not bypass
  it — otherwise staff actions apply without approval.
- **Every mutation logs to `db.activityLog`** via `logActivity(action, details, status)`.
  Keep doing this for new mutations so the Activity log tab stays complete.
- **Money formatting** goes through `money(n)`; dates through `todayStr()` /
  `MONTH_LABEL`. Reuse these rather than reformatting inline.
- **No build step.** Don't introduce a bundler, package manager for the
  frontend, or framework — this is deliberately a single static HTML file.

## Internationalization

The app defaults to Somali with an EN/SO toggle. Preference is stored in
`localStorage` (`qaaraan-lang`), per-browser — switching calls `setLang()`,
which does a full `location.reload()` rather than live-patching the DOM.
- **Dynamic content** (anything rendered by JS template literals) uses the
  `t(somaliText, englishText)` helper, e.g. `` `<h1>${t("Xubnaha","Members")}</h1>` ``.
  Watch out for local variables/loop params named `t` shadowing this global
  function (several places rename the loop var, e.g. `for (const tx of
  m.transactions)` instead of `t`, or call `window.t(...)` explicitly where
  renaming isn't practical).
- **Static HTML** (markup that exists in the page from load, not rebuilt by a
  render function) uses `data-t-en="English text"` (or `data-t-en-ph=` for
  placeholders); the Somali text is the element's literal content, used
  as-is when `currentLang === "so"`. `applyStaticTranslations()` runs once
  in `init()` and swaps in the English text when needed.
- **What's intentionally left Somali-only, regardless of toggle:**
  - `logActivity()` action/details strings — persisted audit-log data, not
    live UI. Historical entries can't retroactively change language anyway.
  - The outbound WhatsApp message body built by `buildBalanceMessage()` —
    it's addressed to the *member*, not the admin using the toggle, so it
    stays Somali even when the admin's own UI is in English. Only the modal
    chrome around it (labels, buttons) respects the toggle.
  - Disbursement category names (`Xalane / Diya`, `Dhiig nool`, `Diya
    wadaag`, `Guno`) — these are specific community-fund terms without a
    clean one-word English equivalent; mistranslating them risks changing
    their meaning. Generic labels around them (buttons, filters) do
    translate.
- New user-facing strings should follow the same pattern rather than being
  added Somali-only.

## Deploy chain

GitHub (push to `main`) → Vercel (auto-deploy) → Neon Postgres (via Vercel
Storage → Marketplace integration, sets `DATABASE_URL` env var
automatically). See `README.md` for the full Somali-language walkthrough.

**`API_SECRET` is also required** (Vercel → Project → Settings →
Environment Variables) — `api/data.js` and `api/notify.js` fail closed
(500) without it. Its value must exactly match the `API_SECRET` constant
near the top of `index.html`'s `<script>` block; see SPEC.md's Security
section for why this exists and its limits.

## Current fiscal window

As of this writing, the app's dues cycle is July–December 2026
(`MONTHS_2026` / `MONTH_LABEL` in `index.html`), with an opening balance
date of 30 June 2026. This is hardcoded in a few places, not derived from
`new Date()` — if the fiscal year rolls over, these need manual updating.
