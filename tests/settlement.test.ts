import { describe, expect, it } from 'vitest'
import { COMMON, minTransfers, settle, type ExpenseIn, type Member } from '@/lib/settlement'

const B = 'bhawneet', G = 'gurneet'
const members: Member[] = [{ id: B, name: 'Bhawneet', earning: true }, { id: G, name: 'Gurneet', earning: true }]
const rs = (n: number) => Math.round(n * 100)
const exp = (id: string, amount: number, paidBy: string, parties: string[]): ExpenseIn => ({ id, amount, paidBy, split: { type: 'equal', parties } })
const find = (r: ReturnType<typeof settle>, from: string, to: string) => r.transfers.find(t => t.from === from && t.to === to)
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)

describe('the seven mandatory scenarios', () => {
  it('1. ₹30,000 furniture, Bhawneet pays, 50/50 → Gurneet owes Bhawneet ₹15,000', () => {
    const r = settle({ members, expenses: [exp('f', rs(30000), B, [B, G])] })
    expect(r.transfers).toEqual([{ from: G, to: B, amount: rs(15000), paid: 0, due: rs(15000), status: 'Pending' }])
  })

  it('2. ₹100 across Bhawneet, Gurneet and Common → 33.34 to the payer, 33.33 to the others, total ₹100.00', () => {
    const r = settle({ members, expenses: [exp('x', rs(100), B, [B, G, COMMON])] })
    expect(r.shares.x).toEqual({ [B]: 3334, [G]: 3333, [COMMON]: 3333 })
    expect(sum(r.shares.x!)).toBe(rs(100))
  })

  it('3. a ₹1,499 fixed bill is just an expense once posted (the posting itself is tested with the recurring engine)', () => {
    const r = settle({ members, expenses: [exp('bb', rs(1499), G, [B, G])] })
    expect(find(r, B, G)?.amount).toBe(74950)
  })

  it('4. grocery estimated ₹10,000, actual ₹12,450 → the balance recalculates on the actual', () => {
    const est = settle({ members, expenses: [exp('g', rs(10000), B, [B, G])] })
    const act = settle({ members, expenses: [exp('g', rs(12450), B, [B, G])] })
    expect(find(est, G, B)?.amount).toBe(rs(5000))
    expect(find(act, G, B)?.amount).toBe(rs(6225))
  })

  it('5. ₹8,000 electricity paid by the Common account → household spend, no debt between the members', () => {
    const r = settle({ members, expenses: [exp('e', rs(8000), COMMON, [COMMON])] })
    expect(r.potBorne).toBe(rs(8000))
    // nothing is owed between Bhawneet and Gurneet; with no income declared each owes the pot half of the shortfall
    expect(find(r, B, G)).toBeUndefined(); expect(find(r, G, B)).toBeUndefined()
    expect(r.transfers.map(t => [t.from, t.to, t.amount])).toEqual([[B, COMMON, rs(4000)], [G, COMMON, rs(4000)]])
    // …and once the household's income covers it, nobody owes anything
    const covered = settle({ members, expenses: [exp('e', rs(8000), COMMON, [COMMON])], commonIncome: rs(8000) })
    expect(covered.transfers).toEqual([])
  })

  it('6. Gurneet pays ₹6,000 of home maintenance allocated 100% to Common → shortfall 50/50 → Bhawneet owes Gurneet ₹3,000', () => {
    const r = settle({ members, expenses: [exp('m', rs(6000), G, [COMMON])] })
    expect(r.potSpend).toBe(rs(6000)); expect(r.shortfall).toBe(rs(6000))
    expect(r.topUps).toEqual({ [B]: rs(3000), [G]: rs(3000) })
    expect(r.transfers).toEqual([{ from: B, to: G, amount: rs(3000), paid: 0, due: rs(3000), status: 'Pending' }])
  })

  it('7. owes ₹15,000, pays ₹10,000 → ₹5,000 remains; pays ₹18,000 → ₹3,000 advance credit', () => {
    const e = [exp('f', rs(30000), B, [B, G])]
    const part = settle({ members, expenses: e, payments: [{ from: G, to: B, amount: rs(10000) }] })
    expect(part.transfers[0]).toMatchObject({ paid: rs(10000), due: rs(5000), status: 'Partially Settled' })
    expect(part.advances).toEqual([])
    const over = settle({ members, expenses: e, payments: [{ from: G, to: B, amount: rs(18000) }] })
    expect(over.transfers[0]).toMatchObject({ paid: rs(15000), due: 0, status: 'Settled' })
    expect(over.advances).toEqual([{ from: G, to: B, amount: rs(3000) }])
    expect(over.outstanding).toBe(0)
  })
})

describe('the Household pot', () => {
  it('income that covers the spend: no shortfall, and the pot itself owes the member who paid', () => {
    const r = settle({ members, expenses: [exp('m', rs(6000), G, [COMMON])], commonIncome: rs(60000) })
    expect(r.shortfall).toBe(0); expect(r.surplus).toBe(rs(54000))
    expect(r.transfers).toEqual([{ from: COMMON, to: G, amount: rs(6000), paid: 0, due: rs(6000), status: 'Pending' }])
  })

  it('income ₹60,000 · pot pays ₹50,000 itself · Gurneet pays ₹20,000 the pot bears → spend ₹70,000, shortfall ₹10,000, ₹5,000 each', () => {
    const r = settle({ members, commonIncome: rs(60000), expenses: [exp('bills', rs(50000), COMMON, [COMMON]), exp('groc', rs(20000), G, [COMMON])] })
    expect(r.potSpend).toBe(rs(70000)); expect(r.shortfall).toBe(rs(10000))
    expect(r.topUps).toEqual({ [B]: rs(5000), [G]: rs(5000) })
    // Gurneet is owed ₹20,000 less her own ₹5,000 = ₹15,000: ₹5,000 from Bhawneet and ₹10,000 from the pot's own funds
    expect(r.balances[G]).toBe(rs(15000)); expect(r.balances[B]).toBe(-rs(5000)); expect(r.balances[COMMON]).toBe(-rs(10000))
    expect(r.outstanding).toBe(rs(15000))
  })

  it('a surplus is never a debt: income above spend leaves a surplus to carry', () => {
    const r = settle({ members, commonIncome: rs(80000), expenses: [exp('bills', rs(70000), COMMON, [COMMON])] })
    expect(r.shortfall).toBe(0); expect(r.surplus).toBe(rs(10000)); expect(r.transfers).toEqual([])
  })

  it('a carried-in surplus pays this month’s bills before anyone tops up', () => {
    const r = settle({ members, carryIn: rs(4000), expenses: [exp('bills', rs(10000), COMMON, [COMMON])] })
    expect(r.shortfall).toBe(rs(6000)); expect(r.topUps).toEqual({ [B]: rs(3000), [G]: rs(3000) })
  })

  it('odd paise in the shortfall go to the first contributor and still add up', () => {
    const r = settle({ members, expenses: [exp('x', 10001, COMMON, [COMMON])] })
    expect(r.topUps).toEqual({ [B]: 5001, [G]: 5000 }); expect(sum(r.topUps)).toBe(10001)
  })

  it('if nobody is marked as earning, everyone funds the shortfall', () => {
    const none = members.map(m => ({ ...m, earning: false }))
    const r = settle({ members: none, expenses: [exp('x', 10000, COMMON, [COMMON])] })
    expect(r.topUps).toEqual({ [B]: 5000, [G]: 5000 })
  })

  it('a hand-split pot bill: the members marked on it owe the pot', () => {
    const r = settle({ members, commonIncome: rs(1000), expenses: [{ id: 'h', amount: rs(1000), paidBy: COMMON, split: { type: 'exact', paise: { [B]: rs(400), [COMMON]: rs(600) } } }] })
    expect(r.balances[B]).toBeLessThan(0)
    expect(sum(r.balances)).toBe(0)
  })
})

describe('mixed month', () => {
  it('members’ debts net in both directions', () => {
    const r = settle({ members, expenses: [exp('a', rs(20000), B, [B, G]), exp('b', rs(8000), G, [B, G])] })   // G owes 10,000, B owes 4,000
    expect(r.transfers).toEqual([{ from: G, to: B, amount: rs(6000), paid: 0, due: rs(6000), status: 'Pending' }])
  })
  it('a failed or reversed payment counts for nothing', () => {
    const r = settle({ members, expenses: [exp('f', rs(30000), B, [B, G])], payments: [{ from: G, to: B, amount: rs(5000), status: 'failed' }, { from: G, to: B, amount: rs(2000), status: 'reversed' }] })
    expect(r.transfers[0]).toMatchObject({ paid: 0, due: rs(15000) })
  })
  it('refuses unknown people and impossible payments', () => {
    expect(() => settle({ members, expenses: [exp('x', 100, 'ghost', [B])] })).toThrow()
    expect(() => settle({ members, expenses: [], payments: [{ from: G, to: G, amount: 100 }] })).toThrow()
    expect(() => settle({ members, expenses: [], payments: [{ from: G, to: B, amount: 0 }] })).toThrow()
  })
})

describe('minTransfers', () => {
  it('collapses a chain A→B→C into A→C', () => {
    expect(minTransfers({ a: -500, b: 0, c: 500 })).toEqual([{ from: 'a', to: 'c', amount: 500 }])
  })
  it('refuses balances that do not add to zero', () => {
    expect(() => minTransfers({ a: -1, b: 2 })).toThrow()
  })
})

describe('invariants (randomised)', () => {
  // A small deterministic generator, so a failure is reproducible.
  let seed = 12345
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!

  it('shares add up to each amount, balances to zero, and paying every transfer clears every balance', () => {
    const people = [B, G, 'papa', 'mom']
    const ms: Member[] = people.map((id, i) => ({ id, name: id, earning: i < 2 }))
    const all = [...people, COMMON]
    for (let round = 0; round < 300; round++) {
      const expenses: ExpenseIn[] = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => {
        const parties = all.filter(() => rnd() < 0.5); if (parties.length === 0) parties.push(pick(all))
        return exp('e' + i, 1 + Math.floor(rnd() * 5_000_00), pick(all), parties)
      })
      const income = rnd() < 0.5 ? Math.floor(rnd() * 20_000_00) : 0
      const r = settle({ members: ms, expenses, commonIncome: income })
      for (const e of expenses) expect(sum(r.shares[e.id]!)).toBe(e.amount)
      expect(sum(r.balances)).toBe(0)
      const net: Record<string, number> = Object.fromEntries(all.map(id => [id, 0]))
      for (const t of r.transfers) { net[t.from] = net[t.from]! + t.amount; net[t.to] = net[t.to]! - t.amount }
      for (const id of all) expect(net[id]! + r.balances[id]!).toBe(0)
      expect(r.shortfall === 0 || r.surplus === 0).toBe(true)
    }
  })
})
