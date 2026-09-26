import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { onUnauthorized, setAccessToken } from "./api";

/**
 * Browser side of dashboard sign-in.
 *
 * The server says whether sign-in is required and hands over the Supabase URL and anon
 * key via `/app-config`, so the same build runs in demo mode (no Supabase configured) and
 * in production without being rebuilt. The anon key is public by design; the security is
 * in the server verifying the resulting JWT, not in hiding this value.
 */

export interface AppConfig {
  authRequired: boolean;
  /** Whether this build is serving synthetic demo data. Drives the DEMO badge. */
  isDemo: boolean;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /** The VAPID public key, or null when web push is not configured on this server. */
  vapidPublicKey: string | null;
}

export async function loadAppConfig(): Promise<AppConfig> {
  const res = await fetch("/app-config");
  if (!res.ok) throw new Error(`Could not load the dashboard configuration (${res.status})`);
  return (await res.json()) as AppConfig;
}

let client: SupabaseClient | null = null;

export function supabase(cfg: AppConfig): SupabaseClient {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error("Sign-in is required, but Supabase is not configured on the server.");
  }
  // Sessions persist in this browser and refresh themselves, so a dashboard left open on
  // a wall does not quietly lose its identity after the one-hour token lifetime.
  client ??= createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}

/** Hand the current access token to the API client; null clears it. */
export function applySession(s: Session | null): void {
  setAccessToken(s?.access_token ?? null);
}

export { onUnauthorized };
