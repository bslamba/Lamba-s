// ============================================================
// lib/settlement.ts — the month's settlement, as pure functions over whole paise.
//
// Parties: the members (people) and the Household pot ('common').
//   · An expense a member paid is borne by its split. Each other member's share is owed to the payer;
//     the pot's share is something the pot owes the payer (a reimbursement).
//   · An expense the pot paid is already paid from shared funds: it never creates a debt between members.
//     (If its split names members, they owe the pot their share.)
//   · pot spend  = what the pot pays and bears + what it owes members
//     shortfall  = max(0, pot spend − declared common income − surplus carried in)
//     the shortfall is funded equally by the contributors (earning members; everyone if none earn)
//   · Every party ends with one balance; balances add up to exactly zero. minTransfers() turns them into the fewest payments.
//   · Live payments reduce what is owed — only up to what is owed; the rest is an advance credit, never a negative due.
// ============================================================
import { isPaise, type Paise } from './money'
import { allocate, SplitError, type SplitSpec } from './split'

export const COMMON = 'common'

export interface Member { id: string; name: string; earning: boolean }
export interface ExpenseIn { id: string; name?: string; amount: Paise; paidBy: string; split: SplitSpec }
export interface PaymentIn { id?: string; from: string; to: string; amount: Paise; status?: 'cleared' | 'failed' | 'reversed' }
export interface SettleInput {
  members: Member[]
  expenses: ExpenseIn[]
  commonIncome?: Paise          // declared for the month
  carryIn?: Paise               // surplus carried from the previous closed month
  payments?: PaymentIn[]        // settlement payments and advances already made (only 'cleared' / unset count)
}
export interface Transfer { from: string; to: string; amount: Paise; paid: Paise; due: Paise; status: 'Pending' | 'Partially Settled' | 'Settled' }
export interface Advance { from: string; to: string; amount: Paise }
export interface SettleResult {
  shares: Record<string, Record<string, Paise>>      // expense id → party → share
  potSpend: Paise; potBorne: Paise; potOwesMembers: Paise
  shortfall: Paise; surplus: Paise
  topUps: Record<string, Paise>                      // contributor → their part of the shortfall
  balances: Record<string, Paise>                    // party → net (> 0: is owed money, < 0: owes); sums to 0
  transfers: Transfer[]
  advances: Advance[]
  outstanding: Paise
}

/** The fewest payments that clear the balances. Deterministic: largest first, ties by id. */
export function minTransfers(bal: Record<string, Paise>): { from: string; to: string; amount: Paise }[] {
  const ids = Object.keys(bal).sort()
  const sum = ids.reduce((s, id) => s + (bal[id] as number), 0)
  if (sum !== 0) throw new Error(`Balances must add up to zero, not ${sum}.`)
  const cred = ids.filter(id => (bal[id] as number) > 0).map(id => ({ id, v: bal[id] as number })).sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1))
  const debt = ids.filter(id => (bal[id] as number) < 0).map(id => ({ id, v: -(bal[id] as number) })).sort((a, b) => b.v - a.v || (a.id < b.id ? -1 : 1))
  const out: { from: string; to: string; amount: Paise }[] = []
  let i = 0, j = 0
  while (i < debt.length && j < cred.length) {
    const d = debt[i]!, c = cred[j]!
    const pay = Math.min(d.v, c.v)
    if (pay > 0) out.push({ from: d.id, to: c.id, amount: pay })
    d.v -= pay; c.v -= pay
    if (d.v === 0) i++
    if (c.v === 0) j++
  }
  return out
}

export function settle(input: SettleInput): SettleResult {
  const members = [...input.members].sort((a, b) => (a.id < b.id ? -1 : 1))
  const ids = new Set([...members.map(m => m.id), COMMON])
  if (ids.size !== members.length + 1) throw new SplitError('Member ids must be unique and not "common".')
  const income = input.commonIncome ?? 0, carryIn = input.carryIn ?? 0
  if (!isPaise(income) || income < 0 || !isPaise(carryIn) || carryIn < 0) throw new SplitError('Common income and carry-in must be whole paise, not negative.')

  const bal: Record<string, Paise> = Object.fromEntries([...ids].map(id => [id, 0]))
  const add = (id: string, v: Paise) => { bal[id] = (bal[id] as number) + v }
  const reimburse: Record<string, Paise> = {}, owedIn: Record<string, Paise> = {}
  const shares: SettleResult['shares'] = {}
  let potBorne = 0

  for (const e of input.expenses) {
    if (!ids.has(e.paidBy)) throw new SplitError(`Unknown payer “${e.paidBy}”.`)
    const sh = allocate(e.amount, e.split, e.paidBy)
    for (const q of Object.keys(sh)) if (!ids.has(q)) throw new SplitError(`Unknown person “${q}” in a split.`)
    shares[e.id] = sh
    for (const [q, v] of Object.entries(sh)) {
      if (e.paidBy === COMMON) {
        if (q === COMMON) potBorne += v
        else owedIn[q] = (owedIn[q] ?? 0) + v                              // a member marked on a pot bill owes the pot
      } else if (q !== e.paidBy) {
        if (q === COMMON) reimburse[e.paidBy] = (reimburse[e.paidBy] ?? 0) + v   // the pot owes the payer
        else { add(e.paidBy, v); add(q, -v) }                              // a member owes the payer
      }
    }
  }

  const potOwesMembers = Object.values(reimburse).reduce((s, v) => s + v, 0)
  const potSpend = potBorne + potOwesMembers
  const gap = potSpend - income - carryIn
  const shortfall = Math.max(0, gap), surplus = Math.max(0, -gap)

  const earners = members.filter(m => m.earning), contributors = (earners.length ? earners : members).map(m => m.id)
  const topUps: Record<string, Paise> = {}
  if (shortfall > 0 && contributors.length) Object.assign(topUps, allocate(shortfall, { type: 'equal', parties: contributors }))

  for (const m of members) {
    const potNet = (reimburse[m.id] ?? 0) - (owedIn[m.id] ?? 0) - (topUps[m.id] ?? 0)   // > 0: the pot pays them
    add(m.id, potNet); add(COMMON, -potNet)
  }

  // Payments reduce what each payment-direction owes — never more; the excess is an advance credit.
  const base = minTransfers(bal)
  const due = new Map(base.map(t => [`${t.from}>${t.to}`, t.amount]))
  const paidMap = new Map<string, Paise>()
  const advances: Advance[] = []
  for (const p of input.payments ?? []) {
    if (p.status && p.status !== 'cleared') continue
    if (!isPaise(p.amount) || p.amount <= 0 || !ids.has(p.from) || !ids.has(p.to) || p.from === p.to) throw new SplitError('A payment needs two different people and a positive whole-paise amount.')
    const k = `${p.from}>${p.to}`
    const owed = (due.get(k) ?? 0) - (paidMap.get(k) ?? 0)
    const use = Math.max(0, Math.min(p.amount, owed))
    if (use > 0) paidMap.set(k, (paidMap.get(k) ?? 0) + use)
    if (p.amount > use) {
      const extra = p.amount - use, same = advances.find(a => a.from === p.from && a.to === p.to)
      if (same) same.amount += extra; else advances.push({ from: p.from, to: p.to, amount: extra })
    }
  }
  const transfers: Transfer[] = base.map(t => {
    const paid = paidMap.get(`${t.from}>${t.to}`) ?? 0, d = t.amount - paid
    return { ...t, paid, due: d, status: d === 0 ? 'Settled' : paid > 0 ? 'Partially Settled' : 'Pending' }
  })
  return { shares, potSpend, potBorne, potOwesMembers, shortfall, surplus, topUps, balances: bal, transfers, advances, outstanding: transfers.reduce((s, t) => s + t.due, 0) }
}
