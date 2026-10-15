import { describe, expect, it } from 'vitest'
import { formatINR, parseRupees } from '@/lib/money'

describe('parseRupees', () => {
  it('reads clean rupee text into whole paise', () => {
    expect(parseRupees('1,499')).toBe(149900)
    expect(parseRupees('₹ 1,25,000.50')).toBe(12500050)
    expect(parseRupees('0.5')).toBe(50)
    expect(parseRupees('Rs. 30000')).toBe(3000000)
  })
  it('refuses anything that is not a clean amount', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '1e3', '1.2.3', '₹']) expect(parseRupees(bad)).toBeNull()
  })
})

describe('formatINR', () => {
  it('uses Indian grouping and drops .00', () => {
    expect(formatINR(0)).toBe('₹0')
    expect(formatINR(149900)).toBe('₹1,499')
    expect(formatINR(12500050)).toBe('₹1,25,000.50')
    expect(formatINR(10_000_000_000)).toBe('₹10,00,00,000')
    expect(formatINR(-5)).toBe('−₹0.05')
  })
})
