import 'dotenv/config'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseAdmin: SupabaseClient = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

export { supabaseAdmin }
