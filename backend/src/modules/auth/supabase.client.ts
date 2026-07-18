/**
 * Supabase admin client adapter.
 *
 * Wraps @supabase/supabase-js with the SERVER-ONLY secret key (bypasses RLS).
 * Behind an accessor so the rest of the backend depends on this module, not the
 * SDK directly (Rules.md §2). The secret key is read from config (env / secret
 * manager) and never logged.
 *
 * Used for privileged server operations (Auth admin, Storage) in later phases.
 * It is created lazily and only when Supabase is configured.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../../config/index.js";

let client: SupabaseClient | undefined;

export function isSupabaseConfigured(): boolean {
  return Boolean(config.SUPABASE_URL && config.SUPABASE_SECRET_KEY);
}

/**
 * Returns the privileged Supabase client (service role / secret key).
 * Throws if Supabase is not configured — callers should guard with
 * {@link isSupabaseConfigured}.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) {
    throw new Error(
      "Supabase is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY missing).",
    );
  }
  if (!client) {
    client = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
