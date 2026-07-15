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
