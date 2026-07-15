# CLAUDE.md

Guidance for Claude Code (or any future session) working in this repo.

## What this is

Qaaraan is a Somali-language web app for managing a community savings fund
(monthly dues, member balances, community disbursements like weddings/funerals,
accounts payable, bank/cash accounts, and staff permissions). All UI text is
in Somali — **keep any new UI text in Somali.**

## Files

- `index.html` — the entire frontend. Vanilla JS, no framework, no build step,
  no bundler. One `<script>` block at the bottom of the file holds all app
  logic. CSS is inline in a `<style>` block. External deps loaded via CDN
  `<script>`/`<link>` tags: Tabler Icons, SheetJS (`xlsx`), jsPDF.
- `api/data.js` — **not present in this repo yet.** The frontend calls
  `GET /api/data` (expects `{ value: <JSON string> }`) and
  `POST /api/data` (body `{ value: <JSON string> }`) to load/save the entire
  app state as one blob. This file is a Vercel serverless function and needs
  to be added before the app can run against a real deployment — see "Known
  gaps" below.
- `schema.sql` — Postgres schema for Neon, defining **relational** tables
  (`members`, `transactions`, `disbursements`, `users`, `accounts`,
  `payables`, `activity_log`, `pending_actions`, `app_settings`). Also meant
  to auto-run via `api/data.js` on first request.
- `package.json` — single dependency: `@neondatabase/serverless`.
- `README.md` — Somali-language deploy walkthrough (GitHub → Vercel → Neon).

## ⚠️ Known gaps / open questions (read before doing DB work)

1. **`api/data.js` is missing.** It was referenced but never uploaded to this
   repo. Nobody should assume its contents — ask before writing a new one,
   since it talks to a live Neon database with real community financial data.
2. **Storage model mismatch.** `schema.sql` defines normalized relational
   tables (one row per member, per transaction, etc.), but `index.html`'s
   `loadDb()`/`saveDb()` currently treat `/api/data` as a single JSON-blob
   key/value store (`db = JSON.parse(json.value)`, saved back as one big
   JSON string). Whatever `api/data.js` actually does — serialize the blob
   into/out of the relational tables, or just store the blob in one row —
   determines whether the schema and the frontend actually agree with each
   other. **Don't assume one or the other; confirm against the real
   `api/data.js` before changing either the schema or the save/load logic.**
3. **PII baked into `index.html` source.** Near the top of the `<script>`
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

## Deploy chain

GitHub (push to `main`) → Vercel (auto-deploy) → Neon Postgres (via Vercel
Storage → Marketplace integration, sets `DATABASE_URL` env var
automatically). See `README.md` for the full Somali-language walkthrough.

## Current fiscal window

As of this writing, the app's dues cycle is July–December 2026
(`MONTHS_2026` / `MONTH_LABEL` in `index.html`), with an opening balance
date of 30 June 2026. This is hardcoded in a few places, not derived from
`new Date()` — if the fiscal year rolls over, these need manual updating.
