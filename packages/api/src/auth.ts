import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { DEMO_CEO_ID, getServiceSql, loadConfig, type AccessRole } from "@freshnow/core";

/**
 * Dashboard identity from a Supabase Auth JWT.
 *
 * Before this, the dashboard decided who you were from `?viewer=` — a query parameter
 * anyone could set to `ceo`. RLS then enforced whatever identity it was handed, correctly,
 * for an identity nobody had verified. This module is the missing half: the token is
 * verified against Supabase's published keys, its `sub` is mapped to an employee through
 * `employee.auth_user_id`, and only then does a request get an RLS context.
 *
 * Verification is local. Supabase signs with asymmetric keys and publishes the public half
 * at `/auth/v1/.well-known/jwks.json`, so a token is checked without a round trip to the
 * auth server on every request. `createRemoteJWKSet` caches the key set and refetches on
 * an unknown `kid`, which is what makes key rotation safe. A project still on the legacy
 * shared secret is supported through SUPABASE_JWT_SECRET.
 */

export interface Viewer {
  employeeId: string;
  isCeo: boolean;
  displayName: string;
  /** What they may do and where they sit — the RLS context needs both (migration 0009). */
  accessRole: AccessRole;
  department: string | null;
  /** How the identity was established — shown in logs, never trusted for access. */
  via: "supabase" | "demo";
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** True when a Supabase project is configured — the switch between real auth and demo mode. */
export function authEnabled(): boolean {
  return Boolean(loadConfig().SUPABASE_URL);
}

async function verify(token: string): Promise<JWTPayload> {
  const c = loadConfig();
  const issuer = `${c.SUPABASE_URL!.replace(/\/$/, "")}/auth/v1`;

  // Legacy projects sign with one shared HS256 secret. Newer ones sign asymmetrically.
  // Try the published keys first; fall back to the secret only if one is configured.
  try {
    jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    // Supabase's asymmetric keys are ES256 (the default) or RS256. Naming them means a
    // token cannot choose its own algorithm.
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: "authenticated",
      algorithms: ["ES256", "RS256"],
    });
    return payload;
  } catch (asymErr) {
    if (!c.SUPABASE_JWT_SECRET) throw asymErr;
    const { payload } = await jwtVerify(token, new TextEncoder().encode(c.SUPABASE_JWT_SECRET), {
      issuer,
      audience: "authenticated",
      algorithms: ["HS256"],
    });
    return payload;
  }
}

/**
 * Resolve the person behind a request.
 *
 * Throws 401 for a missing, malformed, expired or wrongly-signed token, and 403 for a valid
 * token whose account is not linked to an active employee — an authenticated stranger is
 * still a stranger to this company's data.
 */
export async function viewerFromToken(authHeader: string | undefined): Promise<Viewer> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) throw new AuthError("Sign in required", 401);

  let payload: JWTPayload;
  try {
    payload = await verify(token);
  } catch {
    // One message for every verification failure: telling a caller WHICH check failed
    // (expired vs. bad signature vs. wrong issuer) helps an attacker more than a user.
    throw new AuthError("Session is invalid or has expired — sign in again", 401);
  }

  const authUserId = typeof payload.sub === "string" ? payload.sub : null;
  if (!authUserId) throw new AuthError("Session is invalid or has expired — sign in again", 401);

  const sql = getServiceSql();
  const rows = await sql<
    { id: string; display_name: string; status: string; access_role: AccessRole; department: string | null }[]
  >`select id, display_name, status, access_role, department from employee where auth_user_id = ${authUserId}`;
  const emp = rows[0];
  if (!emp || emp.status !== "active") {
    throw new AuthError("This account is not linked to an active employee", 403);
  }

  return {
    employeeId: emp.id,
    // The CEO is the one employee row with that fixed id, exactly as the bot decides it.
    isCeo: emp.id === DEMO_CEO_ID || emp.access_role === "ceo",
    displayName: emp.display_name,
    accessRole: emp.access_role,
    department: emp.department,
    via: "supabase",
  };
}

// The auth hook stores the resolved viewer on the request so route handlers read an
// identity the hook verified, rather than re-deriving one from the query string.
declare module "fastify" {
  interface FastifyRequest {
    viewerId?: string;
    viewerIsCeo?: boolean;
    viewerName?: string;
    viewerRole?: AccessRole;
    viewerDepartment?: string | null;
  }
}
