-- Qaaraan Database — Neon (Postgres) Schema
-- Run this once in the Neon SQL editor (or it runs automatically via /api/data on first load)

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  monthly_due NUMERIC DEFAULT 0,
  opening_balance NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'active',
  accrued_months JSONB DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  type TEXT NOT NULL,          -- 'due' | 'payment' | 'writeoff'
  amount NUMERIC NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  account TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_member ON transactions(member_id);

CREATE TABLE IF NOT EXISTS disbursements (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  date TEXT NOT NULL,
  recipient TEXT,
  shared_with TEXT,
  memo TEXT,
  account TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'staff',
  permissions JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  opening_balance NUMERIC DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payables (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  due_date TEXT,
  description TEXT,
  status TEXT DEFAULT 'unpaid',
  created_date TEXT,
  paid_date TEXT,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL
);

-- Money the fund owes out TO a member (e.g. an approved loan/advance
-- request) is just a payable with member_id set instead of NULL — reuses
-- the same unpaid/paid + "pay it" -> disbursement flow. member_id is
-- ALTERed onto the existing table below (not just declared here) since
-- CREATE TABLE IF NOT EXISTS is a no-op against a table that already
-- exists in production.
ALTER TABLE payables ADD COLUMN IF NOT EXISTS member_id TEXT REFERENCES members(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS receivables (
  id TEXT PRIMARY KEY,
  member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  member_name TEXT,
  amount NUMERIC NOT NULL,
  due_date TEXT,
  description TEXT,
  status TEXT DEFAULT 'unpaid',
  created_date TEXT,
  paid_date TEXT,
  account TEXT
);

-- A member's requested amount that the fund owes them (payable) is
-- separate from what they might owe the fund beyond their regular
-- monthly dues (receivable) — see CLAUDE.md.

CREATE TABLE IF NOT EXISTS groups (
  group_name TEXT PRIMARY KEY,
  wakiil TEXT,
  member_names JSONB DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  requested_at TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT,
  action TEXT,
  details TEXT,
  status TEXT
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  label TEXT,
  requested_by TEXT,
  requested_at TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
