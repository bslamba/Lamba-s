// The ONE place the database is reached from. Server-side only: it uses the secret key, which bypasses row level security,
// so every caller must check who is asking (see the auth step) before it reads or writes anything.
import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | undefined

export function db(): SupabaseClient {
  if (client) return client
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set (Vercel → Settings → Environment Variables).')
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return client
}
