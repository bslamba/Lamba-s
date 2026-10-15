# Database

Supabase project `lamba-family`. The app talks to it only from the server with the secret key; the publishable key can reach nothing
(row level security is on for every table and no policy lets anyone in).

## Setting it up (once)
1. Supabase dashboard → **SQL Editor** → New query → paste **`migrations/0001_init.sql`** → Run.
2. New query → paste **`seed.sql`** → Run (adds Bhawneet, Gurneet, the Household pot and the 18 categories; no passwords).
3. Check: `set -a; . ./.env.local; set +a; node scripts/db-check.mjs` (needs the three keys in the environment).

Migrations are numbered and never edited after they have been run; a change is a new file.

## What the database enforces by itself
- an expense's splits add up to its amount to the paisa (checked at commit);
- a month that is closed, or has a live settlement payment, takes no new, changed or removed expenses; a closed month's snapshot is never rewritten;
- no expense dated more than 36 months ahead;
- the audit log is append-only;
- a recurring bill posts once per month; a bank reference is filed once; one open approval request per expense; an inbox message is queued once per fingerprint;
- password hashes need ≥ 600,000 iterations; a requester can never be their own approver.

These are tested in `tests/db.test.ts` against an in-memory Postgres.
