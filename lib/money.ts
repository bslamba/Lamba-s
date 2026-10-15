// Money is whole paise (integers) everywhere. Rupee text exists only at the screen edge.
export type Paise = number

export const MAX_PAISE = 10_000_000_000   // ₹10 crore — a typo guard, not an accounting limit

export const isPaise = (n: unknown): n is Paise => typeof n === 'number' && Number.isSafeInteger(n)

/** "1,499.50", "₹ 1,25,000", "30000" → paise. Null when it is not a clean amount (more than 2 decimals, letters, negative…). */
export function parseRupees(input: string): Paise | null {
  const t = (input ?? '').replace(/[₹\s,]/g, '').replace(/^rs\.?/i, '')
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return null
  const whole = Number(m[1]), frac = Number((m[2] ?? '').padEnd(2, '0') || '0')
  const p = whole * 100 + frac
  return isPaise(p) ? p : null
}

/** 12345678 → "₹1,23,456.78"; whole rupees drop the ".00". Indian digit grouping. */
export function formatINR(paise: Paise): string {
  const neg = paise < 0, a = Math.abs(paise)
  const rupees = Math.trunc(a / 100), rem = a % 100
  const s = String(rupees)
  const grouped = s.length <= 3 ? s : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3)
  return `${neg ? '−' : ''}₹${grouped}${rem ? '.' + String(rem).padStart(2, '0') : ''}`
}
