// Splitting an amount between people, in whole paise, so the parts ALWAYS add up to the amount exactly.
//
// One rule for every kind of split — largest remainder:
//   1. each person gets floor(amount × weight / totalWeight);
//   2. the leftover paise go one each to the people with the largest fractional remainders;
//   3. ties are broken in a fixed order: the payer first, then everyone else by id.
// For an equal split every remainder ties, so "1 paisa each to the first R people (payer first)" falls out of the rule.
import { isPaise, type Paise } from './money'

export type SplitSpec =
  | { type: 'equal'; parties: string[] }
  | { type: 'percent'; percents: Record<string, number> }     // up to 2 decimals each; need not sum to exactly 100 (scaled), must be > 0
  | { type: 'exact'; paise: Record<string, Paise> }           // must add up to the amount

export class SplitError extends Error { constructor(m: string) { super(m); this.name = 'SplitError' } }

/** Payer first (if present), then the rest by id — the deterministic tie-break order. */
export function orderParties(parties: string[], payer?: string): string[] {
  const rest = [...new Set(parties)].filter(p => p !== payer).sort()
  return payer && parties.includes(payer) ? [payer, ...rest] : rest
}

function largestRemainder(amount: Paise, weights: Record<string, number>, order: string[]): Record<string, Paise> {
  const ids = order.filter(id => (weights[id] ?? 0) > 0)
  const total = ids.reduce((s, id) => s + (weights[id] as number), 0)
  if (ids.length === 0 || total <= 0) throw new SplitError('Nobody to split it between.')
  const out: Record<string, Paise> = {}
  const rems: { id: string; r: number; i: number }[] = []
  let given = 0
  ids.forEach((id, i) => {
    const num = amount * (weights[id] as number)          // integer × integer; amount ≤ 1e12 and weights ≤ 1e6 keep this under 2^53
    const base = Math.floor(num / total)
    out[id] = base; given += base
    rems.push({ id, r: num - base * total, i })
  })
  let left = amount - given
  for (const x of [...rems].sort((a, b) => b.r - a.r || a.i - b.i)) { if (left <= 0) break; out[x.id] = (out[x.id] as number) + 1; left-- }
  return out
}

/** The shares of `amount` (paise) among the parties of `spec`. Throws SplitError on anything that cannot be split exactly. */
export function allocate(amount: Paise, spec: SplitSpec, payer?: string): Record<string, Paise> {
  if (!isPaise(amount) || amount <= 0) throw new SplitError('The amount must be a whole number of paise above zero.')
  if (spec.type === 'equal') {
    if (spec.parties.length === 0) throw new SplitError('Pick who shares it.')
    const order = orderParties(spec.parties, payer)
    return largestRemainder(amount, Object.fromEntries(order.map(id => [id, 1])), order)
  }
  if (spec.type === 'percent') {
    const ids = Object.keys(spec.percents)
    const bps: Record<string, number> = {}
    for (const id of ids) {
      const p = spec.percents[id] as number
      if (!Number.isFinite(p) || p < 0) throw new SplitError('A share cannot be negative.')
      bps[id] = Math.round(p * 100)                        // basis points: exact integers
    }
    return largestRemainder(amount, bps, orderParties(ids, payer))
  }
  const ids = Object.keys(spec.paise)
  let sum = 0
  for (const id of ids) {
    const v = spec.paise[id] as number
    if (!isPaise(v) || v < 0) throw new SplitError('Each share must be a whole number of paise, not negative.')
    sum += v
  }
  if (sum !== amount) throw new SplitError(`The shares add up to ${sum} paise but the amount is ${amount}.`)
  return Object.fromEntries(ids.filter(id => (spec.paise[id] as number) > 0).map(id => [id, spec.paise[id] as number]))
}
