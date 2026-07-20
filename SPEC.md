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
to that account (`accountBalance`). Admin-only "Wax ka beddel"/"Edit" button
on each account card (`openEditAccountModal()`, Accounts tab) lets the name
and opening balance be corrected later — logs a before/after diff.

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
- Otherwise → username/password login against `db.users`. Passwords are
  hashed (PBKDF2-SHA256, 150k iterations, random salt per user, via the
  browser's `crypto.subtle` — see `hashPassword()`/`verifyPassword()`,
  stored as `"<saltHex>:<hashHex>"`), not stored or compared in plaintext.
  `verifyPassword()` also accepts a legacy plaintext record (no `:`-hex
  pattern) by direct comparison, and `doLogin()` re-hashes and saves on a
  successful legacy match — so any accounts created before hashing was
  added self-migrate to hashed storage the next time each one logs in,
  with no manual migration step or forced reset needed.
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
    That password is hashed (see above) before being stored/saved — the
    admin only ever sees the plaintext value they just typed, locally.

## Security

- **`/api/data` and `/api/notify` require a shared secret.** Both
  serverless functions check an `X-Api-Secret` request header against the
  `API_SECRET` Vercel environment variable and reject with 401 if it's
  missing or wrong, and with 500 if `API_SECRET` isn't configured at all
  (fails closed, not open). The frontend sends this header on every call
  from a single `API_SECRET` constant near the top of `index.html`'s
  `<script>` block.
  - **Why this exists**: before this, both endpoints were fully public —
    `GET /api/data` returned the entire live database (every member's PII,
    every transaction, every user's password) to anyone who requested the
    URL, no login required, and `POST /api/data` could overwrite or wipe
    it the same way. The login screen only ever gated the client-side UI;
    it never talked to the server about who's allowed in. `/api/notify`
    had the same gap, letting anyone burn the Resend email quota.
  - **What this does and doesn't fix**: it stops opportunistic/automated
    access — a scanner or a stranger with the URL can no longer just `curl`
    the database. It does **not** stop a determined attacker: since
    `index.html` is a single static file with no build step, `API_SECRET`
    is necessarily embedded in public page source and readable by anyone
    who views it. A real fix requires moving login verification server-side
    (a login endpoint that issues a session token tied to an actual
    username/password check, instead of a single static secret everyone's
    browser holds) — not implemented, flagged here as the natural next step
    if a stronger guarantee is needed.
  - **Deploy requirement**: `API_SECRET` must be set in Vercel (Project →
    Settings → Environment Variables) with the exact same value baked into
    `index.html`'s `API_SECRET` constant, then redeployed. Until that env
    var is set, both endpoints return 500 to everyone, including the app
    itself (fails closed by design — see above).
- **Passwords are hashed**, not plaintext — see the Auth section above.
- **Backups still carry whatever's in `db.users[].password` at export
  time** — hashed for any account that's logged in since this change
  shipped, plaintext for any that hasn't yet (self-migrates on next
  login). Either way, treat backup files as sensitive.
- **PII is still baked into `index.html`'s source** (`SEED_MEMBERS`,
  `GROUPS`, `HISTORY_REPORTS`, `JOURNAL_DISBURSEMENTS` — see CLAUDE.md's
  Known gaps). This is a separate exposure from the API issue above and is
  not fixed by it.

## Permissions & approval flow

- `hasPerm(key)`: admins always pass; staff check `permissions[key]`.
- Mutating UI actions call `attemptAction(type, payload, permKey, label)`:
  - Permission missing → toast, no-op.
  - Admin → `applyAction()` runs immediately, logged as `"direct"`.
  - Staff → pushed to `db.pendingActions` as `"pending"`, admin resolves via
    the "Pending approvals" tab (`renderPending`), which calls the same
    `applyAction()` on approve.
- `applyAction` currently handles: `addCustomer`, `payment`, `writeoff`,
  `delete`, `statusChange`, `editMember`, `disbursement`.

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
- **Edit member** ("Wax ka beddel", needs `addCustomer` — same permission as
  adding a new member, since editing basic profile fields is the same tier
  of everyday member-management work): `openEditMemberModal(m)` lets
  name/phone/`monthlyDue` be changed via a single-step Save (no destructive
  confirmation needed — nothing is deleted, it's trivially re-editable).
  Goes through the normal `attemptAction("editMember", ..., "addCustomer",
  ...)` path, so staff edits queue for admin approval like any other
  mutation. Changing `monthlyDue` is **not retroactive** — it doesn't touch
  already-recorded `due` transactions, only the amount `syncAccruals()`
  uses for months accrued from then on. The activity log entry records a
  `before → after` diff of all three fields.
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
- **Unified Reports picker** (sidebar → "Warbixinno"/"Reports", visible with
  `viewReports`) — `openReportsModal()` offers three entry points that all
  funnel into the same PDF/Excel choice step (`openReportFormatChoice()`):
  - **Personal** (`openReportPersonPicker()`) — live search-as-you-type
    member picker, then exports that member's current live data (balance
    boxes + full `transactions[]` history with a running balance) via
    `exportMemberLiveReportPdf()`/`exportMemberLiveReportExcel()`. This is
    a different, newer export than the existing historical-ledger export
    reachable from a member's "Balance summary" modal (which exports
    `HISTORY_REPORTS`, the pre-2026 imported ledger, not live transactions)
    — the two aren't meant to be the same thing.
  - **Group** (`openReportGroupPicker()`) — pick a `GROUPS` entry, reuses
    the existing `exportGroupPdf()`/`exportGroupExcel()`.
  - **Full** (`openReportsModal()`'s third option) — reuses the existing
    `exportFullListPdf()`/`exportFullListExcel()` across all `db.members`.
  - If a PDF/Excel generator throws (e.g. the export library failed to
    load), the format-choice modal catches it, shows a toast, and still
    closes — it doesn't hang open on failure.
- **Monthly Forecast** (sidebar → "Saadaasha Billaha"/"Monthly Forecast",
  visible with `viewReports`) — despite the name, this is an actuals
  breakdown for a chosen month, not a predictive forecast:
  `openForecastModal()` shows a month picker (defaults to the current
  month if it falls in `MONTHS_2026`, else the first fiscal month) and,
  via `computeMonthForecast(mk)`, the total collected and total expenses
  for that month, plus how many active-with-`monthlyDue` members paid vs.
  didn't (a member "paid" a month if they have any `payment` transaction
  dated in it — not tied to the amount covering that month's due), with a
  scrollable list of who hasn't paid yet. Switching the month re-renders
  the modal in place.
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

## Import file (Excel/CSV)

Settings (admin-only) has an **Import file** section (`handleImportFile()`),
surfaced as a "Choose file to import" button (`btnChooseImportFile`) that
triggers a hidden file input — not a bare `<input type="file">`, so it reads
as a clickable action rather than a stray form control. It reads every sheet
via SheetJS (`XLSX`) and uses the first one that actually has rows (some
exports, QuickBooks included, put a blank cover sheet first), then
**auto-detects the file kind by its columns**, routing to one of two
importers:
- a `Type` + `Amount` file (without `Balance Total`) → **transactions import**
  (`runTransactionsImport()`), see below;
- otherwise → **balance import** (`runBalanceImport()`), described here.

Both share one matcher, `matchMemberForImport(rawName, rawPhone)`: normalized
phone first (last 9 digits, so leading `0`/country code don't matter), then
exact normalized name, then a UNIQUE short-trailing-difference name (≤2 chars,
for typos like `"…Abd"` vs `"…Abdi"`) — never bridging genuinely different
people.

### Balance import (`runBalanceImport` / `showImportBalancesPreview`)

For pushing a corrected set of member balances (e.g. a hand-edited copy of a
`full_report` export) back into the app:
- Auto-detects `Customer` / `Main Phone` / `Balance Total` columns by fuzzy
  header name.
- Matches each row to a member via the shared matcher (phone first,
  so leading `0`/country code don't matter), then normalized name as a
  fallback. A member already matched by an earlier row is not matched again —
  the duplicate row is reported as unmatched (`"member matched twice"`)
  rather than silently applied, which matters because the real data contains
  at least one pair of near-duplicate people sharing a phone number.
- Shows a full **preview** before any write: counts (matched / will-change /
  unchanged / unmatched), every member whose balance would change with
  `current → target` and the signed delta, and every unmatched row with the
  reason. Applying requires typing the literal word `IMPORT` (same
  typed-confirmation tier as Restore).
- **Apply mechanism**: for each changed member, `openingBalance` is nudged by
  `(target − currentBalance)` so `computeBalance()` ends up exactly equal to
  the file's figure — **no transaction history is deleted**, and each change
  plus a summary is written to the activity log. Unmatched members are left
  completely untouched.
- Because balances are computed against live `db` data, the preview's
  "will change" set reflects the real diff at import time — an admin should
  read it before confirming rather than assuming the whole file applies.

### Transactions import (`runTransactionsImport` / `showTransactionsImportPreview`)

For rebuilding members' full ledgers from a QuickBooks-style transaction
export (columns `Name`, `Type`, `Date`, `Num`, `Account`, `Amount`,
`Balance`):
- Rows are grouped by member; a **blank `Name` continues the previous member**
  (QuickBooks groups rows under one name header, then leaves it blank).
- `Type` is mapped to an internal type by keyword (`mapImportTxType`):
  invoice/due/charge/bill → `due`; payment/receipt/deposit/paid → `payment`;
  credit/write-off/bad-debt/discount → `writeoff`. Amount is stored as
  `Math.abs()` with the sign implied by the mapped type, so the file's own
  `+/−` sign convention can't flip a value the wrong way.
- **Two independent safety gates, both required to enable Apply:**
  1. **Unknown-type gate** — any `Type` value the keyword map doesn't
     recognize is collected and shown; while any exist, Apply is disabled
     entirely (nothing gets silently miscategorized).
  2. **Balance self-check** — for each member the summed transactions are
     compared against that member's **last stated `Balance`** in the file; a
     member whose computed total doesn't reproduce the file's running balance
     is flagged `mismatch` and **excluded** from the applied set. This makes a
     wrong mapping visible instead of corrupting data.
- Applying (typed `IMPORT`) **replaces** each ok member's `transactions[]`
  with the imported set, sets `openingBalance = 0` (history now starts from
  the file's first row, not a 30-June cutover), and seeds `accruedMonths`
  with the months that already have a `due` so `syncAccruals()` won't
  double-add them. Imported payments are left untagged to a bank account
  (`account` unset) so a bulk history import doesn't unexpectedly swing
  account balances. This is destructive to existing history for matched
  members — the preview carries a bold warning to take a Backup first.
- If an `Account` column is present, rows not tagged to something matching
  `/receivable/i` are silently skipped rather than imported as a member
  transaction — keeps rows for other ledgers (bank, expense categories) out
  of member history if a future export ever mixes them in. All real data
  seen so far has been `Accounts Receivable` only.
- **Lessons from testing against a real QuickBooks "Customer Balance
  Summary" export** (132 members, 2783 rows) — these were real bugs, not
  hypothetical edge cases:
  - The member name can sit in a **column with no header text at all** (a
    leftover from an indented/grouped report layout — the name is a
    group-header value, not a same-row field). `findKey` can't find it by
    text, so `runTransactionsImport` falls back to
    `findImportNameColumnFallback()`: the first column that holds text on
    rows where `Type`/`Amount` are blank (group-header rows), excluding
    `"Total ..."` subtotal lines.
  - `"General Journal"` is a real QuickBooks `Type` value (manual
    adjustments, often marked `BAD DEBT` in the `Num` column) with no fixed
    due/payment/writeoff meaning. `mapImportTxType` infers it from the
    amount's sign: negative → `writeoff`, positive → `due`, rather than
    treating it as unknown and blocking the whole import.
  - Currency-formatted cells are read as **display text**, not raw numbers
    (`raw:false` is required so date cells come through as formatted text).
    `parseImportAmount()` strips `$`/commas and reads `(200.00)` as `-200`.
    Critically, **accounting number formats render an exact zero as a lone
    dash** (`"$ - "`) instead of `"0.00"` — a non-empty, digit-less cell is
    read as `0`, not treated as unparseable, so a member whose balance lands
    on exactly $0 doesn't lose their final balance to a silent parse
    failure.

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
`backfillDisbursementAccounts`, `fixCreditMemoAccountTagging`,
`fixSalaamBankOpeningBalance`, `fixSalaamBankOpeningBalance730`). These are
historical/one-time in intent,
not meant to be extended with new hardcoded people going forward — new
members should be added through the "Add new customer" flow instead.
- **`fixCreditMemoAccountTagging`**: `importCreditMemosAsDisbursements`
  imports historical bad-debt write-offs (`HISTORY_REPORTS` entries with
  `type:"writeoff"`) as `db.disbursements` with `category:"Cafinaad
  (Balance sheet)"`. A write-off isn't real cash leaving a bank account —
  it's a receivables adjustment (same principle the General Ledger already
  applies: bad debt posts to its own virtual account, never to a real bank
  account) — so this un-tags any such entry from an `account`, every load,
  idempotently. `backfillDisbursementAccounts` explicitly skips this
  category too, so the two functions don't fight each other on repeat
  loads.
- **`fixSalaamBankOpeningBalance`**: a one-time correction for the
  `acc_salaam` account's `openingBalance`, which was seeded at `0` — so the
  historical dues actually collected before live tracking started were
  never reflected in any account balance, while historical disbursements
  were (via the imports above), making the account look far more negative
  than reality. Only fires while `openingBalance` is still exactly `0`
  (so it won't override a value an admin has since set via Edit Account);
  sets it to the sum of every `type:"payment"` entry across
  `HISTORY_REPORTS`. This is a best-effort reconstruction from the
  embedded historical ledger, not a guarantee of matching a real bank
  statement to the penny — an admin should verify and use Edit Account to
  correct it if needed.
- **`fixSalaamBankOpeningBalance730`**: the auto-derived guess above turned
  out wrong — the real 30 June 2026 opening balance, per the admin's actual
  records, is `$730`. This corrects it once, but only while the value is
  still whatever this code previously set it to (`0` or the old `$20,621`
  derivation), so a manual Edit Account change is never overridden. This is
  the kind of one-off numeric correction that should normally just go
  through Edit Account directly rather than a new hardcoded migration function
  — it's here because the fix needed to reach an already-deployed database,
  the same reasoning as every other function in this section.
