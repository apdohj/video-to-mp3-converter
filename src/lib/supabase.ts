import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/*
 * Supabase client — initialized with the project URL and public anon key.
 *
 * NOTE: The anon key is a PUBLIC key meant to be embedded in client apps.
 * Security is enforced server-side with Row Level Security (RLS), never by
 * hiding this key.
 *
 * Project URL:    https://zadwcjowhlcualzxrysa.supabase.co
 * REST endpoint:  https://zadwcjowhlcualzxrysa.supabase.co/rest/v1/
 */
const SUPABASE_URL = "https://zadwcjowhlcualzxrysa.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InphZHdjam93aGxjdWFsenhyeXNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2NTczMjcsImV4cCI6MjEwMjIzMzMyN30.RmsztRLR_J3EA5FEehKVEITCREHUoxr4OrU3mS6MtDo";

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
