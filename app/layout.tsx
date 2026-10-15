import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Lamba Family — Expenses',
  description: 'Shared family expenses and monthly settlement.',
  robots: { index: false, follow: false },
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">{children}</body>
    </html>
  )
}
