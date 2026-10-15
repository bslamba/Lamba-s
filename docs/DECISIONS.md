# Decisions that override or extend docs/SPEC.md

Made during the review of the master prompt (Oct 2026).

1. **Hosting:** own repo (`bslamba/lamba-s`), own Vercel project at `lambafamily.vercel.app` in the same Vercel team, own Supabase project (`yroketznnludzypwfdww`). Nothing is shared with the existing finance app or its database.
2. **Members** are rows, not an enum: two members now (Bhawneet, Gurneet) plus the Household pot (`common`). UI is built for two; adding a person later needs no redesign.
3. **Settlement is three-party.** Balances exist for each member AND the Household pot; `minTransfers` produces member↔member and member↔Household payments. A bilateral-only net is wrong whenever declared common income covers the spend (the pot itself then owes the member who paid).
   - With no income declared, scenario 6 still reads "Bhawneet owes Gurneet ₹3,000" (the two pot payments collapse into one member payment).
   - Pot-paid bills with no income leave a shortfall: each contributor owes the pot half. Nothing is ever owed *between members* for a pot-paid bill.
4. **Remainder rule:** one largest-remainder rule for every split (equal, percent, exact-validated); ties broken payer first, then by id. The shortfall's odd paisa goes to the first contributor by id.
5. **Build order changed:** scaffold + settlement maths + the 7 scenario tests first, then schema/RLS, auth, expenses, recurring bills, approvals, inbox, UI slices, cron/storage.
6. **Security upgrades over the spec:** PBKDF2-SHA256 ≥ 600,000 iterations (not 100,000); a signed trusted-device cookie for new-device OTP (not User-Agent + IP prefix); webhook keys are `keyId.secret` (lookup by id, constant-time hash compare).
7. **Approvals:** shared expenses need the other member's approval, so a fluctuating bill's actual counts in the month only once approved (scenario 4 is about the maths, not about skipping approval). Fixed bills auto-posted from an approved template need no per-month approval. Expense status has no SETTLED value — settlement is per month and pair, derived.
