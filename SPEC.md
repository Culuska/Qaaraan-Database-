# SPEC.md

Functional specification of the Qaaraan app, as implemented in `index.html`.
This describes current behavior (source of truth: the code) — treat it as a
map for orientation, not an aspirational design doc. If code and this file
disagree, the code wins; update this file when behavior changes.

## Domain model

**Member** (`db.members[]`)
- `id`, `name`, `phone`, `monthlyDue`, `openingBalance`, `status` (`active`/`inactive`),
  `accruedMonths` (list of `"YYYY-MM"` already accrued as a due), `transactions[]`.
- Balance = `openingBalance` + sum(`due`) − sum(`payment`) − sum(`writeoff`)
  (`computeBalance`).

**Transaction** (`member.transactions[]`)
- `type`: `due` (monthly qoondo accrual), `payment`, or `writeoff` (bad-debt
  cafinaad).
- `due` transactions are auto-generated once per month per active member with
  `monthlyDue > 0` by `syncAccruals()`, called on every `loadDb()`.

**Disbursement** (`db.disbursements[]`)
- Community expense: `category` (`Xalane / Diya`, `Dhiig nool`, `Diya wadaag`,
  `Guno`, or an imported `Cafinaad (Balance sheet)` category), `amount`,
  `date`, `recipient`, `sharedWith` (only for `Diya wadaag`), `memo`
  (required), `account`.

**Account** (`db.accounts[]`) — bank/cash buckets (e.g. "Salaam Bank"). Balance
= `openingBalance` + payments tagged to that account − disbursements tagged
to that account (`accountBalance`).

**Payable** (`db.payables[]`) — accounts-payable bills owed to vendors.
`status`: `unpaid`/`paid`. Paying a bill (`openPayBillModal`) creates a
matching `disbursement` and flips status to `paid`.

**User** (`db.users[]`) — `role` (`admin`/`staff`), `permissions` object.

**Pending action** (`db.pendingActions[]`) — queued staff request awaiting
admin approval/rejection.

**Activity log** (`db.activityLog[]`) — append-only audit trail of every
mutation, direct or approved/rejected/pending.

## Auth

- No accounts yet → first-run "setup" screen creates the first user as
  `admin` (`renderSetupScreen`).
- Otherwise → username/password login against `db.users` (plaintext
  comparison, no hashing — see Known gaps in CLAUDE.md, this is a
  pre-existing condition worth revisiting).
- `?member=<id>` query param bypasses auth entirely and renders a read-only
  public balance view for that one member (`renderPublicMemberView`) —
  intended for the WhatsApp-shared link flow (see below).
- **Persistent session**: successful login/setup writes the username to
  `localStorage` (`qaaraan-session`, via `saveSession()`); `renderAuthGate()`
  checks it before falling back to the login screen, so refreshing the page
  doesn't force a re-login. Per-browser, not server-side — logging out
  (`doLogout()`) clears it.
- **Lockout**: each `db.users[]` entry tracks `failedAttempts` and
  `lockedAt`. `LOCKOUT_THRESHOLD` (4) wrong-password attempts in a row locks
  the account for `LOCKOUT_MINUTES` (15), even against the *correct*
  password, until the cooldown elapses or an admin manually unlocks it
  (Manage Users → "Fur" button next to a locked user). This is real,
  server-side-persisted lockout (survives across browsers/devices, since
  `db.users` syncs through Neon) — not just a client-side counter.
  - In-app notification: a red-bordered alert card on the Guddoon dashboard
    naming every currently-locked account (visible to admins the moment
    they next open the app), a "Dir WhatsApp" quick-send link on that card,
    plus a red-tagged `activityLog` entry (`status:"locked"`).
  - Real email notification: `notifyAdmin()` also fires a best-effort POST
    to `/api/notify` (see "Admin email & WhatsApp notifications" below) the
    moment the lockout happens.
- **Forgot password**: the login screen has a "Ma illowday password-kaaga?"
  link (`openForgotPasswordModal()`). Typing a username and submitting pushes
  a record to `db.passwordResetRequests[]` (`{id, username, requestedAt,
  status:"pending"}`) and a `"pending"`-status `activityLog` entry — only if
  that username actually exists in `db.users`, but the toast shown to the
  requester is the same generic "if that username exists..." message either
  way, so the login screen can't be used to enumerate valid usernames.
  - Same notification pattern as lockout: an amber alert card ("Codsiyo
    password cusub") on the admin dashboard lists every username with a
    pending request (with its own "Dir WhatsApp" link), Manage Users shows
    a "codsi password"/"password requested" badge next to that user's row,
    and `notifyAdmin()` fires a real email via `/api/notify` the moment a
    valid request is submitted.
  - Every user row in Manage Users also has an always-visible "Beddel
    Password"/"Reset Password" button (not just users with a pending
    request — an admin can reset anyone's password proactively), wired to
    `openResetPasswordModal(u)`. The admin types a new plaintext password
    (min 4 chars); saving it clears `failedAttempts`/`lockedAt` (so a reset
    also lifts a lockout), marks any matching pending
    `passwordResetRequests` entry `"resolved"` (clearing the badge), and
    logs the activity. A follow-up modal then displays the new password
    back to the admin with an explicit instruction to relay it to the user
    manually (WhatsApp/phone/in-person) — there's no automated delivery.

## Permissions & approval flow

- `hasPerm(key)`: admins always pass; staff check `permissions[key]`.
- Mutating UI actions call `attemptAction(type, payload, permKey, label)`:
  - Permission missing → toast, no-op.
  - Admin → `applyAction()` runs immediately, logged as `"direct"`.
  - Staff → pushed to `db.pendingActions` as `"pending"`, admin resolves via
    the "Pending approvals" tab (`renderPending`), which calls the same
    `applyAction()` on approve.
- `applyAction` currently handles: `addCustomer`, `payment`, `writeoff`,
  `delete`, `statusChange`, `disbursement`.

## Views / tabs

Tabs shown depend on permissions (`renderTabs`):
- **Xubnaha (Members)** — always visible. List (full or grouped-by-`GROUPS`)
  + detail panel. Search + active/inactive filter. Row click selects a
  member; mobile has a dedicated back button / slide layout.
- **Kharashaadka Bulshada (Disbursements)** — always visible. Log community
  expenses, filter by category, breakdowns by month and by recipient, PDF/
  Excel export.
- **Xasuusin Bille (Reminders)** — visible with `collectPayment` permission.
  Lists members with positive balance, one-click WhatsApp reminder.
- **Accounts** — visible with `viewReports`. Bank/cash balances.
- **Xisaabaadka Guud (Financial)** — visible with `viewReports`. AR, AP,
  expenses, bad debt, net position; accounts-payable bill list.
- **Pending approvals** — admin only.
- **Activity log** — admin only.

## Member detail panel

- Balance boxes: opening balance, total paid, total written off, current
  balance, months outstanding (`balance / monthlyDue`).
- Admin-only "months comparison" bar: months paid vs. total months owed,
  factoring in historical settled amounts from `HISTORY_REPORTS` (see
  `monthsComparison`).
- Disbursement breakdown for this member if any disbursement's `recipient`
  fuzzy-matches their name (substring match, not an ID reference).
- Payment form (needs `collectPayment`), write-off ("Cafi deynta", needs
  `collectPayment`), deactivate/activate toggle (needs `deactivate`), delete
  member (needs `delete`), transaction list with per-row delete (two-step
  confirm: yes/no, then type the member's serial number).
- "Balance summary" modal: three sub-views — current summary, admin-only
  month-by-month aging (`computeMonthlyAging` — FIFO allocation of payments
  against opening balance then monthly dues, oldest first), and a
  date-ranged historical ledger from `HISTORY_REPORTS` with PDF/Excel export.
- "Dir WhatsApp" — builds a Somali-language balance summary message
  (`buildBalanceMessage`) and opens `wa.me` with it prefilled. If
  `db.settings.baseUrl` is set (App Settings, admin-only), includes a
  `?member=<id>` deep link to the public read-only view.

## Reports / exports

- Per-group and per-member PDF/Excel exports (jsPDF, SheetJS) — group roster
  with balances, member transaction history.
- Disbursement exports: full, or filtered by category.
- **General Ledger** (`buildJournalEntries()` in `index.html`) — not a real
  ledger table in the database. Computed live from `db.members[].transactions`,
  `db.disbursements`, `db.payables`, and `db.accounts` opening balances into a
  derived double-entry journal: every due/payment/write-off/expense becomes a
  debit+credit pair across virtual accounts (`Accounts Receivable — Members`,
  `Dues Revenue`, `Bad Debt Expense`, `Accounts Payable`, `Expense: <category>`)
  and real bank/cash accounts. Three views share this journal: a chronological
  **Journal**, a **Ledger by account** (pick one account, see a running
  balance), and a **Trial Balance** (confirms total debits = total credits).
  PDF/Excel export matches the existing export patterns.
  - **Bills go through Accounts Payable as two linked entries**, not one:
    when a payable is created, `Dr Expense: <category> / Cr Accounts Payable`
    (dated `createdDate`) — this is what makes unpaid bills show up as a real
    liability even before they're paid. When `openPayBillModal()` pays it,
    the resulting disbursement carries a `payableId` back-reference, and the
    journal posts a second entry `Dr Accounts Payable / Cr <bank account>`
    (dated `paidDate`) to clear the liability. An unpaid bill's category is
    unknown until payment, so it posts to a generic `Uncategorized Expense
    (AP)` bucket until then; disbursements with a `payableId` are skipped in
    the regular disbursement loop so they aren't double-counted. Regular
    disbursements (no linked payable — Guno/Diya/Dhiig nool paid directly)
    keep the simpler single `Dr Expense / Cr Bank` entry, since there's no
    AP step for those.
  - **This makes the Ledger accrual-basis for billed expenses**, while
    `renderFinancialSummary()`'s "Total expenses" card on the Financials tab
    stays cash-basis (`db.disbursements.reduce(...)`, unpaid payables
    excluded) — the two numbers can legitimately differ by the total of
    unpaid bills. Not a bug; flag it if asked to reconcile the two views.

## Quick payment receipt

`openQuickReceiptModal()` (sidebar → "Rasiidka Lacag-bixinta") is a fast-entry
flow for processing many in-person dues payments in a row: type a name, pick
from a live-filtered list of active members, confirm the amount (prefilled
from `monthlyDue`)/date/account, submit. Posts through the same
`attemptAction("payment", ...)` path as the per-member payment form — same
permission gating and pending-approval behavior — then loops back to the
search step with a running session tally (count + total) instead of closing,
so an admin/staff can process a queue of people without re-opening the modal
each time. `playPip()` (a short Web Audio API beep, no external asset) fires
on every successful payment record, both here and in the per-member payment
form, as an audible confirmation.

## Backup & restore

Settings (admin-only) has a "Backup & Restore" section:
- **Download Backup** (`downloadBackup()`) — client-side `Blob` download of
  the entire `db` object as `qaaraan_backup_<date>.json`, wrapped in
  `{__qaaraan_backup: true, exportedAt, data}`. No server involvement beyond
  logging the action. Contains everything, including user records with
  **plaintext passwords** (a pre-existing condition of `db.users` — see
  CLAUDE.md's known gaps) — the UI warns admins to store the file securely,
  but doesn't (and can't, client-side) prevent misuse of a downloaded copy.
- **Restore from Backup** (`openBackupRestoreModal()` → `showRestoreConfirm()`)
  — file picker reads and parses the JSON, sanity-checks it has a `members`
  array, shows a preview (counts + backup date) before doing anything, then
  requires typing the literal word `RESTORE` to confirm — same
  typed-confirmation tier as deleting a member or an account with financial
  history. On confirm, `db` is fully replaced (with the same fallback
  defaults `loadDb()` applies for missing sub-arrays), saved, and the page
  reloads. This is a full overwrite, not a merge — there's no partial/
  selective restore.

## Admin email & WhatsApp notifications

- `db.settings.adminEmail` (default `cusmanhersi@gmail.com`) and
  `db.settings.adminPhone` (default `+252615200615`) are set on first load
  and editable in App Settings (admin-only).
- **Email**: `notifyAdmin(subject, html, attachment?)` (`index.html`) POSTs
  to `api/notify.js`, a Vercel serverless function that sends through
  [Resend](https://resend.com) using a `RESEND_API_KEY` environment
  variable. If that env var isn't set, `/api/notify` responds
  `{skipped:true}` instead of erroring, so the app works with or without
  email configured — same best-effort philosophy as the rest of the app's
  notifications. Fires automatically on: account lockout, a valid
  password-reset request. Fires on demand from: "Email Backup" in App
  Settings (`emailBackupToAdmin()`), which attaches the full `db` as a
  base64 JSON attachment — **same caveat as Download Backup: it contains
  plaintext user passwords, so the admin inbox needs to stay secure.**
  Resend's sandbox sender (`onboarding@resend.dev`) only delivers to the
  Resend account's own verified address; verify a custom domain in Resend
  and change the `from` in `api/notify.js` if other recipients are ever
  needed.
- **WhatsApp**: `waLinkForAdmin(message)` builds a `wa.me/<adminPhone>`
  deep link with the message prefilled. Used by "Dir WhatsApp" links on
  the lockout and password-reset dashboard alert cards. This is
  manual-send only (opens WhatsApp, admin still taps send) — there's no
  WhatsApp Business API integration, so nothing goes out automatically
  through this channel.

## Deletion / destructive-action confirmation pattern

Every hard-delete (member, transaction) uses a two-step modal: confirm
intent, then re-type an identifying value (e.g. the member's list serial
number) to proceed. Soft-delete (deactivate) and write-off use single-step
confirm-and-required-memo modals. New destructive features should match
whichever tier of friction fits their risk (irreversible data loss → two-step
typed confirmation; reversible or already-logged → single confirm).

## Data seeding / one-time imports

On every `loadDb()`, several idempotent migration functions run against the
hardcoded constants (`SEED_MEMBERS`, `GROUPS`, `HISTORY_REPORTS`,
`JOURNAL_DISBURSEMENTS`) to backfill members, credit memos, and journal
disbursements that predate the live app (`fixLegacyHistoryImport`,
`removeNonGroupLegacyMembers`, `addMissingSeedMembers`,
`importCreditMemosAsDisbursements`, `importJournalDisbursements`,
`backfillDisbursementAccounts`). These are historical/one-time in intent,
not meant to be extended with new hardcoded people going forward — new
members should be added through the "Add new customer" flow instead.
