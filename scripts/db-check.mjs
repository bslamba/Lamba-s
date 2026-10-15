// Checks the live database after the migration has been run. Read-only. Needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and
// SUPABASE_SECRET_KEY in the environment (never in a file):   set -a; . ./.env.local; set +a; node scripts/db-check.mjs
const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: pub, SUPABASE_SECRET_KEY: secret } = process.env
if (!url || !pub || !secret) { console.error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY.'); process.exit(1) }
const TABLES = ['members', 'credentials', 'trusted_devices', 'otp_codes', 'categories', 'months', 'common_income', 'recurring_templates', 'expenses', 'expense_splits', 'recurring_postings', 'settlement_payments', 'approval_requests', 'ingest_keys', 'inbox_messages', 'mail_log', 'audit_logs', 'audit_reverts']
let bad = 0
const ok = (c, m) => { if (!c) bad++; console.log(c ? '✓' : '✗', m) }
const get = (key, t) => fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
for (const t of TABLES) {
  const s = await get(secret, t)
  ok(s.status === 200, `the server key can read ${t} (${s.status})`)
  const a = await get(pub, t)
  const body = a.status === 200 ? await a.json() : null
  ok(a.status === 401 || a.status === 403 || (a.status === 200 && Array.isArray(body) && body.length === 0), `the publishable key sees nothing in ${t} (${a.status})`)
}
const m = await (await get(secret, 'members')).json()
ok(Array.isArray(m), 'members readable')
if (bad) { console.error(`${bad} checks failed`); process.exit(1) }
console.log('database looks right')
