// The schema, run for real on an in-memory Postgres (PGlite): constraints, triggers and the "public keys can touch nothing" rule.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const sql = (f: string) => readFileSync(path.join(__dirname, '..', 'db', f), 'utf8')
let db: PGlite

async function fails(q: string, match: RegExp) {
  let msg = ''
  try { await db.exec(q) } catch (e) { msg = String((e as Error).message) }
  try { await db.exec('rollback') } catch { /* nothing open */ }
  expect(msg).toMatch(match)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`)
  await db.exec(sql('migrations/0001_init.sql'))
  await db.exec(sql('seed.sql'))
  await db.exec(`grant usage on schema public to anon, authenticated, service_role; grant all on all tables in schema public to service_role; grant usage on all sequences in schema public to service_role;`)
})
afterAll(async () => { await db.close() })

const expense = (id: string, amt: number, date = '2026-10-05', paidBy = 'bhawneet') =>
  `insert into expenses (id, name, amount_paise, expense_date, paid_by, split_type) values ('${id}', 'x', ${amt}, '${date}', '${paidBy}', 'equal');`
const split = (id: string, who: string, share: number) => `insert into expense_splits values ('${id}', '${who}', ${share});`
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

describe('seed', () => {
  it('has the two members, the Household pot and the categories', async () => {
    const m = await db.query<{ id: string }>('select id from members order by id')
    expect(m.rows.map(r => r.id)).toEqual(['bhawneet', 'common', 'gurneet'])
    expect(((await db.query<{ n: number }>('select count(*)::int n from categories')).rows[0]!).n).toBe(18)
  })
  it('allows only one Household pot, and it cannot log in', async () => {
    await fails(`insert into members (id, kind, display_name) values ('pot2', 'common', 'Second');`, /duplicate key|members_one_common/)
    await fails(`insert into members (id, kind, display_name, email) values ('pot3', 'common', 'X', 'x@y.in');`, /common_is_not_a_login/)
  })
})

describe('money columns', () => {
  it('refuse zero, negative and absurd amounts and impossible dates', async () => {
    await fails(expense(U(90), 0), /amount_paise/)
    await fails(expense(U(91), -5), /amount_paise/)
    await fails(expense(U(92), 10_000_000_001), /amount_paise/)
    await fails(expense(U(93), 100, '2062-01-15'), /36 months ahead/)
    await fails(expense(U(94), 100, '2019-12-31'), /expense_date/)
  })
})

describe('splits add up to the amount (checked at commit)', () => {
  it('accepts exact splits in any insert order', async () => {
    await db.exec(`begin; ${expense(U(2), 10000)} ${split(U(2), 'gurneet', 5000)} ${split(U(2), 'bhawneet', 5000)} commit;`)
    const r = await db.query<{ n: number }>(`select count(*)::int n from expense_splits where expense_id = '${U(2)}'`)
    expect(r.rows[0]!.n).toBe(2)
  })
  it('rejects a split that is a paisa short', async () => {
    await fails(`begin; ${expense(U(3), 10000)} ${split(U(3), 'gurneet', 5000)} ${split(U(3), 'bhawneet', 4999)} commit;`, /add up to 9999 paise but the amount is 10000/)
    expect(((await db.query<{ n: number }>(`select count(*)::int n from expenses where id = '${U(3)}'`)).rows[0]!).n).toBe(0)
  })
  it('rejects an expense with no splits at all, and changing the amount without the splits', async () => {
    await fails(`begin; ${expense(U(4), 10000)} commit;`, /add up to 0 paise/)
    await fails(`begin; update expenses set amount_paise = 12000 where id = '${U(2)}'; commit;`, /add up to 10000 paise but the amount is 12000/)
  })
})

describe('locked months', () => {
  it('a recorded settlement payment locks the month; failing the payment frees it', async () => {
    await db.exec(`insert into months (month_key) values ('2026-10') on conflict do nothing;`)
    await db.exec(`insert into settlement_payments (id, month_key, from_entity, to_entity, amount_paise, paid_on) values ('${U(50)}', '2026-10', 'gurneet', 'bhawneet', 100, '2026-10-20');`)
    await fails(`begin; ${expense(U(5), 4000)} ${split(U(5), 'bhawneet', 4000)} commit;`, /closed or settled/)
    await fails(`delete from expenses where id = '${U(2)}'`, /closed or settled/)
    await fails(`delete from expense_splits where expense_id = '${U(2)}' and entity_id = 'gurneet'`, /closed or settled/)
    await db.exec(`update settlement_payments set status = 'failed' where id = '${U(50)}'`)
    await db.exec(`begin; ${expense(U(5), 4000)} ${split(U(5), 'bhawneet', 4000)} commit;`)
  })
  it('a closed month takes nothing, and its snapshot cannot be rewritten', async () => {
    await db.exec(`insert into months (month_key, status, snapshot, closed_at) values ('2026-09', 'closed', '{"items":[]}', now());`)
    await fails(`begin; ${expense(U(6), 100, '2026-09-10')} ${split(U(6), 'bhawneet', 100)} commit;`, /closed or settled/)
    await fails(`update months set snapshot = '{"items":[1]}' where month_key = '2026-09'`, /closed month is a record/)
    await db.exec(`update months set status = 'open', snapshot = null, closed_at = null where month_key = '2026-09'`)   // reopening is allowed
  })
  it('a month cannot be marked closed without a snapshot', async () => {
    await fails(`insert into months (month_key, status) values ('2026-08', 'closed');`, /closed_has_snapshot/)
  })
})

describe('once-only guarantees', () => {
  it('a recurring bill posts at most once per month', async () => {
    await db.exec(`insert into recurring_templates (id, name, kind, amount_paise, due_day, paid_by, split_type, splits, start_month) values ('${U(60)}', 'Broadband', 'fixed', 149900, 5, 'gurneet', 'equal', '["bhawneet","gurneet"]', '2026-10');`)
    await db.exec(`insert into recurring_postings (template_id, month_key) values ('${U(60)}', '2026-10');`)
    await fails(`insert into recurring_postings (template_id, month_key) values ('${U(60)}', '2026-10');`, /duplicate key|recurring_postings_pkey/)
  })
  it('a bank reference is filed at most once', async () => {
    await db.exec(`begin; insert into expenses (id, name, amount_paise, expense_date, paid_by, split_type, ref) values ('${U(7)}', 'Zomato', 79800, '2026-10-13', 'bhawneet', 'equal', 'UTR123'); ${split(U(7), 'bhawneet', 79800)} commit;`)
    await fails(`begin; insert into expenses (id, name, amount_paise, expense_date, paid_by, split_type, ref) values ('${U(8)}', 'Zomato again', 79800, '2026-10-13', 'bhawneet', 'equal', 'UTR123'); ${split(U(8), 'bhawneet', 79800)} commit;`, /duplicate key|expenses_ref_once/)
  })
  it('only one open approval request per expense', async () => {
    const ins = (id: string) => `insert into approval_requests (id, type, expense_id, payload, requested_by, approvers) values ('${id}', 'expense.edit', '${U(7)}', '{}', 'bhawneet', '{gurneet}');`
    await db.exec(ins(U(70)))
    await fails(ins(U(71)), /duplicate key|one_open_request/)
    await db.exec(`update approval_requests set status = 'declined' where id = '${U(70)}'`)
    await db.exec(ins(U(71)))
  })
  it('an inbox message is queued once per fingerprint, whatever its status', async () => {
    const ins = `insert into inbox_messages (member_id, source, snippet, parsed, fp) values ('gurneet', 'email', 'Rs 100 debited', '{}', 'fp1');`
    await db.exec(ins)
    await db.exec(`update inbox_messages set status = 'done' where fp = 'fp1'`)
    await fails(ins, /duplicate key|inbox_messages_member_id_fp_key/)
  })
})

describe('approval rules', () => {
  it('the requester cannot be their own approver; a returned request needs a note', async () => {
    await fails(`insert into approval_requests (type, payload, requested_by, approvers) values ('expense.add', '{}', 'bhawneet', '{bhawneet,gurneet}');`, /approvers_not_requester/)
    await fails(`update approval_requests set status = 'returned' where id = '${U(71)}'`, /returned_has_note/)
    await db.exec(`update approval_requests set status = 'returned', return_note = 'What was this for?' where id = '${U(71)}'`)
  })
})

describe('audit log', () => {
  it('can be appended to, never changed or deleted', async () => {
    await db.exec(`insert into audit_logs (actor, event, what) values ('bhawneet', 'apply', 'Add · Zomato');`)
    await fails(`update audit_logs set what = 'edited'`, /append-only/)
    await fails(`delete from audit_logs`, /append-only/)
    await fails(`truncate audit_logs`, /append-only|cannot truncate/)
  })
})

describe('credentials', () => {
  it('refuse a weak hash work factor', async () => {
    await fails(`insert into credentials (member_id, hash, salt, iterations) values ('bhawneet', 'h', 's', 100000);`, /iterations/)
    await db.exec(`insert into credentials (member_id, hash, salt, iterations) values ('bhawneet', 'h', 's', 600000);`)
  })
})

describe('the public (publishable-key) roles touch nothing', () => {
  it('anon and authenticated are denied on every table; row level security is on everywhere', async () => {
    const tables = (await db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public'`)).rows.map(r => r.tablename)
    expect(tables.length).toBeGreaterThan(15)
    for (const role of ['anon', 'authenticated']) {
      for (const t of tables) {
        await db.exec(`set role ${role}`)
        let denied = false
        try { await db.query(`select * from ${t} limit 1`) } catch { denied = true }
        await db.exec('reset role')
        expect(denied, `${role} could read ${t}`).toBe(true)
      }
    }
    const rls = await db.query<{ relname: string }>(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)
    expect(rls.rows).toEqual([])
  })
  it('the service role (the app’s server) can use them', async () => {
    await db.exec('set role service_role')
    const r = await db.query<{ n: number }>('select count(*)::int n from members')
    await db.exec('reset role')
    expect(r.rows[0]!.n).toBe(3)
  })
})
