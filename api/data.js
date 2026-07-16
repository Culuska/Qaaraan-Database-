// Vercel serverless function backing GET/POST /api/data.
//
// The frontend (index.html) treats this endpoint as a single JSON-blob
// store: GET returns {value: <json string>}, POST accepts {value: <json
// string>} and expects the whole app state to be persisted. Underneath,
// this file stores that state in the real relational tables defined in
// ../schema.sql (one row per member/transaction/etc.), not as one blob
// row — so the data stays queryable in the Neon SQL editor. Every save
// replaces the full contents of every table inside one transaction; this
// is the simplest approach that guarantees the relational tables always
// match the blob the frontend just sent. Keep the DDL below in sync with
// schema.sql if either changes.

import { Pool } from '@neondatabase/serverless';

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

async function ensureSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    monthly_due NUMERIC DEFAULT 0,
    opening_balance NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'active',
    accrued_months JSONB DEFAULT '[]'
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
    account TEXT
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_transactions_member ON transactions(member_id)`);
  await client.query(`CREATE TABLE IF NOT EXISTS disbursements (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    date TEXT NOT NULL,
    recipient TEXT,
    shared_with TEXT,
    memo TEXT,
    account TEXT
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'staff',
    permissions JSONB DEFAULT '{}'
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    opening_balance NUMERIC DEFAULT 0
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS payables (
    id TEXT PRIMARY KEY,
    vendor TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    due_date TEXT,
    description TEXT,
    status TEXT DEFAULT 'unpaid',
    created_date TEXT,
    paid_date TEXT
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    details TEXT,
    status TEXT
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    label TEXT,
    requested_by TEXT,
    requested_at TEXT,
    status TEXT DEFAULT 'pending'
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
}

async function loadState(client) {
  const [members, transactions, disbursements, users, accounts, payables, activityLog, pendingActions, settingsRows] =
    await Promise.all([
      client.query('SELECT * FROM members'),
      client.query('SELECT * FROM transactions'),
      client.query('SELECT * FROM disbursements'),
      client.query('SELECT * FROM users'),
      client.query('SELECT * FROM accounts'),
      client.query('SELECT * FROM payables'),
      client.query('SELECT * FROM activity_log'),
      client.query('SELECT * FROM pending_actions'),
      client.query('SELECT * FROM app_settings'),
    ]);

  const txByMember = {};
  for (const t of transactions.rows) {
    (txByMember[t.member_id] ||= []).push({
      id: t.id, type: t.type, amount: Number(t.amount), date: t.date, note: t.note, account: t.account,
    });
  }

  const settings = {};
  for (const row of settingsRows.rows) settings[row.key] = row.value;

  return {
    members: members.rows.map(m => ({
      id: m.id,
      name: m.name,
      phone: m.phone,
      monthlyDue: Number(m.monthly_due),
      openingBalance: Number(m.opening_balance),
      status: m.status,
      accruedMonths: m.accrued_months || [],
      transactions: txByMember[m.id] || [],
    })),
    disbursements: disbursements.rows.map(d => ({
      id: d.id, category: d.category, amount: Number(d.amount), date: d.date,
      recipient: d.recipient, sharedWith: d.shared_with, memo: d.memo, account: d.account,
    })),
    users: users.rows.map(u => ({
      id: u.id, username: u.username, password: u.password, role: u.role, permissions: u.permissions || {},
    })),
    accounts: accounts.rows.map(a => ({ id: a.id, name: a.name, openingBalance: Number(a.opening_balance) })),
    payables: payables.rows.map(p => ({
      id: p.id, vendor: p.vendor, amount: Number(p.amount), dueDate: p.due_date,
      description: p.description, status: p.status, createdDate: p.created_date, paidDate: p.paid_date,
    })),
    activityLog: activityLog.rows.map(a => ({
      id: a.id, ts: a.ts, actor: a.actor, action: a.action, details: a.details, status: a.status,
    })),
    pendingActions: pendingActions.rows.map(p => ({
      id: p.id, type: p.type, payload: p.payload, label: p.label,
      requestedBy: p.requested_by, requestedAt: p.requested_at, status: p.status,
    })),
    settings,
  };
}

async function saveState(client, state) {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM transactions');
    await client.query('DELETE FROM members');
    await client.query('DELETE FROM disbursements');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM accounts');
    await client.query('DELETE FROM payables');
    await client.query('DELETE FROM activity_log');
    await client.query('DELETE FROM pending_actions');
    await client.query('DELETE FROM app_settings');

    for (const m of state.members || []) {
      await client.query(
        `INSERT INTO members (id,name,phone,monthly_due,opening_balance,status,accrued_months)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [m.id, m.name, m.phone || null, m.monthlyDue || 0, m.openingBalance || 0, m.status || 'active', JSON.stringify(m.accruedMonths || [])]
      );
      for (const t of m.transactions || []) {
        await client.query(
          `INSERT INTO transactions (id,member_id,type,amount,date,note,account)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [t.id, m.id, t.type, t.amount, t.date, t.note || null, t.account || null]
        );
      }
    }
    for (const d of state.disbursements || []) {
      await client.query(
        `INSERT INTO disbursements (id,category,amount,date,recipient,shared_with,memo,account)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [d.id, d.category, d.amount, d.date, d.recipient || null, d.sharedWith || null, d.memo || null, d.account || null]
      );
    }
    for (const u of state.users || []) {
      await client.query(
        `INSERT INTO users (id,username,password,role,permissions) VALUES ($1,$2,$3,$4,$5)`,
        [u.id, u.username, u.password, u.role || 'staff', JSON.stringify(u.permissions || {})]
      );
    }
    for (const a of state.accounts || []) {
      await client.query(
        `INSERT INTO accounts (id,name,opening_balance) VALUES ($1,$2,$3)`,
        [a.id, a.name, a.openingBalance || 0]
      );
    }
    for (const p of state.payables || []) {
      await client.query(
        `INSERT INTO payables (id,vendor,amount,due_date,description,status,created_date,paid_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.id, p.vendor, p.amount, p.dueDate || null, p.description || null, p.status || 'unpaid', p.createdDate || null, p.paidDate || null]
      );
    }
    for (const a of state.activityLog || []) {
      await client.query(
        `INSERT INTO activity_log (id,ts,actor,action,details,status) VALUES ($1,$2,$3,$4,$5,$6)`,
        [a.id, a.ts, a.actor || null, a.action || null, a.details || null, a.status || null]
      );
    }
    for (const p of state.pendingActions || []) {
      await client.query(
        `INSERT INTO pending_actions (id,type,payload,label,requested_by,requested_at,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, p.type, JSON.stringify(p.payload || {}), p.label || null, p.requestedBy || null, p.requestedAt || null, p.status || 'pending']
      );
    }
    for (const [key, value] of Object.entries(state.settings || {})) {
      await client.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2)`, [key, String(value)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

// Gates every request behind a shared secret (X-Api-Secret header) that must
// match the API_SECRET env var. Without this, the endpoint returns the full
// database — including every user's password — to anyone who requests it, no
// login required, since the frontend's login screen is a client-side-only
// gate that never talks to the server. Fails closed (500) if API_SECRET
// isn't configured, rather than silently running unauthenticated.
function checkAuth(req, res) {
  const apiSecret = process.env.API_SECRET;
  if (!apiSecret) {
    res.status(500).json({ error: 'Server not configured: API_SECRET is missing' });
    return false;
  }
  if (req.headers['x-api-secret'] !== apiSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const client = await getPool().connect();
  try {
    await ensureSchema(client);

    if (req.method === 'GET') {
      const state = await loadState(client);
      res.status(200).json({ value: JSON.stringify(state) });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (!body || typeof body.value !== 'string') {
        res.status(400).json({ error: 'Expected { value: <json string> }' });
        return;
      }
      const state = JSON.parse(body.value);
      await saveState(client, state);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
