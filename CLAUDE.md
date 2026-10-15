# Lamba Family — Expenses (conventions for Claude Code)

A private web app for the Lamba family to record shared expenses and settle up monthly. Expense tracking and settlement ONLY — no bank accounts, cards, personal income, savings or balances. The one exception: a declared **common income** for the Household pot.

Full spec: `docs/SPEC.md`. Decisions that override it: `docs/DECISIONS.md`. Read both before changing money logic.

## Rules that must never be broken
- Money is **integer paise** everywhere. No floats in storage, maths or tests. Rupee text only at the screen edge (`lib/money.ts`).
- All settlement/split maths lives in `lib/split.ts` and `lib/settlement.ts` — pure, no UI or database imports. UI and API call them; never re-implement.
- Next.js here is v16 (breaking changes vs. older versions: `proxy.ts` not `middleware.ts`, async request APIs). Read `node_modules/next/dist/docs/` before writing Next-specific code.
- Secrets live in Vercel env vars only; `.env.example` lists names. Never log or return secrets, passwords, OTPs or ingest keys.
- Each step ends with tests passing: `npm run check` (typecheck + lint + vitest). Do not push red.
- Never touch the existing app (`bslamba/personal-site`, Vercel project `bhawneetlamba`, Supabase `family-vault`).

## Commands
`npm run dev` · `npm run check` · `npm run build`
