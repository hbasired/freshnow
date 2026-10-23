import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { DEMO_CEO_ID, appSessionFor, getServiceSql, isAppAccessToken, loadConfig, type AccessRole } from "@freshnow/core";

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
  /**
   * How the identity was established. "app": a phone sign-in (TASK-058) — such a viewer reaches only
   * the routes in APP_ROUTES, whatever their role (D210).
   */
  via: "supabase" | "demo" | "app";
  /** For "app": the phone the session lives on. */
  deviceId?: string;
}

/**
 * The only dashboard routes a phone sign-in may call (D210). A phone is easier to lose and to share
 * than a browser behind a password, so an app session never inherits the dashboard: each route is
 * opened to the app on its own, as the app's screens are built (TASK-063 onwards).
 */
export const APP_ROUTES: ReadonlySet<string> = new Set(["GET /dashboard/me"]);

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
  /** What the central error handler reads (server.ts), so a refusal thrown in a route stays a 401/403. */
  get statusCode(): 401 | 403 {
    return this.status;
  }
}

/**
 * Whether a request reached a route the sign-in hook guards. Decided on the route the router MATCHED,
 * never on the raw URL: the router decodes "%64" to "d" before matching, so "/%64ashboard/…" reached
 * every dashboard route while a guard on `req.url` let it through as ?viewer= or the CEO (TASK-058
 * review, critical). No matched route (a 404) is nothing to guard.
 */
export function isGuardedRoute(req: { routeOptions: { url?: string | undefined } }): boolean {
  const route = req.routeOptions.url ?? "";
  return route.startsWith("/dashboard") || route.startsWith("/employees");
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
  // A phone's token is opaque and only Postgres knows it; it never reaches the JWT code below, and a
  // JWT never reaches the session lookup. Neither path falls back to the other.
  if (isAppAccessToken(token)) return viewerFromAppToken(token);

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

/** A phone sign-in: the session must exist and be live — positively, on every request (device-auth.ts). */
async function viewerFromAppToken(token: string): Promise<Viewer> {
  const s = await appSessionFor(token);
  if (!s) throw new AuthError("Session is invalid or has expired — sign in again", 401);
  const [emp] = await getServiceSql()<
    { id: string; display_name: string; status: string; access_role: AccessRole; department: string | null }[]
  >`select id, display_name, status, access_role, department from employee where id = ${s.employeeId}`;
  if (!emp || emp.status !== "active") throw new AuthError("This account is not linked to an active employee", 403);
  return {
    employeeId: emp.id,
    isCeo: emp.id === DEMO_CEO_ID || emp.access_role === "ceo",
    displayName: emp.display_name,
    accessRole: emp.access_role,
    department: emp.department,
    via: "app",
    deviceId: s.deviceId,
  };
}

// The auth hook stores the resolved viewer on the request so route handlers read an
// identity the hook verified, rather than re-deriving one from the query string.
declare module "fastify" {
  interface FastifyRequest {
    /** How the hook established who this is — "app" requests are held to APP_ROUTES. */
    viewerVia?: Viewer["via"];
    viewerId?: string;
    viewerIsCeo?: boolean;
    viewerName?: string;
    viewerRole?: AccessRole;
    viewerDepartment?: string | null;
  }
}
