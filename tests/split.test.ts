import { describe, expect, it } from 'vitest'
import { allocate, orderParties, SplitError } from '@/lib/split'

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

describe('allocate — equal', () => {
  it('₹100 three ways: payer gets the odd paisa (33.34 / 33.33 / 33.33)', () => {
    const r = allocate(10000, { type: 'equal', parties: ['bhawneet', 'gurneet', 'common'] }, 'bhawneet')
    expect(r).toEqual({ bhawneet: 3334, common: 3333, gurneet: 3333 })
    expect(sum(r)).toBe(10000)
  })
  it('gives the extra paise in the fixed order: payer, then by id', () => {
    const r = allocate(10002, { type: 'equal', parties: ['c', 'a', 'b', 'd'] }, 'c')    // 2500.5 each → 2 extra paise
    expect(r).toEqual({ c: 2501, a: 2501, b: 2500, d: 2500 })
  })
  it('works when the payer is not one of the sharers', () => {
    const r = allocate(10000, { type: 'equal', parties: ['b', 'a', 'c'] }, 'zed')
    expect(r).toEqual({ a: 3334, b: 3333, c: 3333 })
  })
  it('refuses an empty or non-positive split', () => {
    expect(() => allocate(100, { type: 'equal', parties: [] })).toThrow(SplitError)
    expect(() => allocate(0, { type: 'equal', parties: ['a'] })).toThrow(SplitError)
    expect(() => allocate(1.5, { type: 'equal', parties: ['a'] })).toThrow(SplitError)
  })
})

describe('allocate — percent', () => {
  it('splits 2/3 – 1/3 exactly', () => {
    expect(allocate(3000000, { type: 'percent', percents: { a: 66.67, b: 33.33 } }, 'a')).toEqual({ a: 2000100, b: 999900 })
  })
  it('always adds up, whatever the percentages', () => {
    for (const amt of [1, 7, 99, 10001, 123456789]) {
      const r = allocate(amt, { type: 'percent', percents: { a: 33.33, b: 33.33, c: 33.34 } }, 'b')
      expect(sum(r)).toBe(amt)
    }
  })
  it('scales percentages that do not add to 100 instead of losing money', () => {
    expect(sum(allocate(1000, { type: 'percent', percents: { a: 50, b: 40 } }))).toBe(1000)
  })
  it('drops a person with 0%', () => {
    expect(allocate(1000, { type: 'percent', percents: { a: 100, b: 0 } })).toEqual({ a: 1000 })
  })
})

describe('allocate — exact', () => {
  it('accepts shares that add up and refuses ones that do not', () => {
    expect(allocate(1000, { type: 'exact', paise: { a: 600, b: 400 } })).toEqual({ a: 600, b: 400 })
    expect(() => allocate(1000, { type: 'exact', paise: { a: 600, b: 399 } })).toThrow(SplitError)
    expect(() => allocate(1000, { type: 'exact', paise: { a: 1100, b: -100 } })).toThrow(SplitError)
  })
})

describe('orderParties', () => {
  it('payer first then ids; duplicates removed', () => {
    expect(orderParties(['b', 'a', 'c', 'a'], 'c')).toEqual(['c', 'a', 'b'])
    expect(orderParties(['b', 'a'], 'x')).toEqual(['a', 'b'])
  })
})
