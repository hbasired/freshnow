/**
 * The allow-list: the ONLY requests this connector may ever send to Televend.
 *
 * Why an allow-list and not "just only call GET": the user's instruction for TASK-055 was that
 * nothing may be able to change anything in Televend, because a wrong edit would corrupt the
 * fills and cash balances the whole operation runs on. A method check alone is not enough —
 * Televend's own web app has GET endpoints with side effects (e.g. `GET /api/vend/v1/{company}/
 * export/{format}` STARTS an export job and can e-mail the result). So every request must match
 * an exact host + method + path pattern written here, in code, where widening it takes a code
 * change, a review and a test — never a config value.
 *
 * Where the paths come from (researched 2026-10-15, nothing guessed):
 *   - bridge rules: the GET calls Televend's own Angular web app makes (app version 4.8.3,
 *     bundles under app-*.televendcloud.com), read from its public JS;
 *   - official rules: Televend's developer portal OpenAPI specs (devportal.televendcloud.com),
 *     where reads are GET and the only write we accept is the Data-Streaming offset commit,
 *     which moves OUR read position and changes no business data.
 *
 * Writes seen in those same sources and deliberately absent here (tests prove each is refused):
 * importer upsert/delete/update-external-id, event resolve/assign/remove-user, planogram and
 * price push, cash-collection export and note PATCH, report creation, route-order POSTs,
 * offset reset.
 */

export type RuleKind =
  /** A plain read. The only kind ordinary callers can use. */
  | "read"
  /** The Keycloak token endpoint — usable only by the auth module, never by a source. */
  | "auth"
  /** Official Data-Streaming offset commit — off unless explicitly enabled. */
  | "offset-commit";

/** Extra headers a rule needs. Callers never pass headers themselves. */
export type HeaderSet = "none" | "tenant" | "warden";

export interface Rule {
  readonly id: string;
  readonly host: string;
  readonly method: "GET" | "POST";
  readonly path: RegExp;
  readonly kind: RuleKind;
  readonly headers: HeaderSet;
}

export const HOSTS = {
  /** Televend Cloud's API gateway used by the web app (machinist, cashtrack, warden, refillator). */
  cloudApi: "api-cloud.televendcloud.com",
  /** The web app's older FastAPI backend (dashboard stats, administration lists). */
  webApi: "cloud-cloud-web-app.televendcloud.com",
  /** Route service — only the signed-in user's own details are read. */
  routeApi: "cloud-route-service-tc.televendcloud.com",
  /** Keycloak for the web app (realm `televend`). */
  auth: "auth.televendcloud.com",
  /** Official API — UAT gateway and Keycloak, as documented on the developer portal. */
  officialUatApi: "uat-api.televendcloud.com",
  officialUatAuth: "uat-auth.televendcloud.com",
  /** Official API production gateway. UNVERIFIED: inferred from DNS; Televend IT confirms at onboarding. */
  officialApi: "api.televendcloud.com",
} as const;

const T = String.raw`tenants/\d+/companies/\d+`;
const ID = String.raw`\d+`;
const SLUG = String.raw`[a-z0-9-]+`;

const r = (
  id: string,
  host: string,
  method: Rule["method"],
  path: string,
  kind: RuleKind = "read",
  headers: HeaderSet = "none",
): Rule => ({ id, host, method, path: new RegExp(`^${path}$`), kind, headers });

export const RULES: readonly Rule[] = [
  // ── Bridge: the web app's own reads ─────────────────────────────────────────
  r("machines.list", HOSTS.cloudApi, "GET", `/machinist/api/v1/${T}/machines`),
  r("machines.detail", HOSTS.cloudApi, "GET", `/machinist/api/v1/${T}/machines/${ID}`),
  r("vends.list", HOSTS.cloudApi, "GET", `/machinist/api/v1/${T}/vends`),
  r("vends.aggregates", HOSTS.cloudApi, "GET", `/machinist/api/v1/${T}/vends/aggregates`),
  r("vends.filter-options", HOSTS.cloudApi, "GET", `/machinist/api/v1/${T}/vends/filter-options`),
  r("events.list", HOSTS.cloudApi, "GET", `/machinist/api/v1/${T}/events`),
  r("collections.list", HOSTS.cloudApi, "GET", `/cashtrack/v1/${T}/collections`),
  r("collections.detail", HOSTS.cloudApi, "GET", `/cashtrack/v1/${T}/collections/${ID}`),
  r("collections.changelog", HOSTS.cloudApi, "GET", `/cashtrack/v1/${T}/collections/${ID}/changelog`),
  r("conforms.daily", HOSTS.cloudApi, "GET", `/cashtrack/v1/${T}/conforms/stats/daily`),
  r("cashlog", HOSTS.cloudApi, "GET", `/cashtrack/v1/${T}/cashlog`),
  r("denominations", HOSTS.cloudApi, "GET", `/cashtrack/v1/${T}/denominations`),
  r("planogram.columns", HOSTS.cloudApi, "GET", `/planograms/v1/${T}/machines/${ID}/columns`),
  r("refills.statistic", HOSTS.cloudApi, "GET", String.raw`/refillator/api/v1/refill-log-list/[A-Za-z0-9_-]+/statistic`, "read", "tenant"),
  r("refills.details", HOSTS.cloudApi, "GET", String.raw`/refillator/api/v1/refill-log-list/[A-Za-z0-9_-]+/details`, "read", "tenant"),
  r("acl", HOSTS.cloudApi, "GET", "/warden/televendcloud/access-control-list", "read", "warden"),
  // The web app's FastAPI host answers "Header: x-tenant-id is missing." without the tenant
  // header (probe, 2026-10-15) — every rule on it sends the tenant headers.
  r(
    "dashboard.stats",
    HOSTS.webApi,
    "GET",
    String.raw`/api/dashboard/v1/\d+/stats/(?:vends/today|vends/lastweek-perdate-w-trends|vends/lastweek-paymethod-w-trends|vends/lastweek-products-top10-w-trends|alarms/today|machine/status-now|machine/signal-strength-now)`,
    "read",
    "tenant",
  ),
  r("events.latest", HOSTS.webApi, "GET", String.raw`/api/event/v1/\d+/latest/?`, "read", "tenant"),
  r("admin.machines", HOSTS.webApi, "GET", String.raw`/api/administration/machines/v1/\d+/machines`, "read", "tenant"),
  r("admin.event-codes", HOSTS.webApi, "GET", String.raw`/api/administration/events/v1/\d+/event_codes`, "read", "tenant"),
  r("locations", HOSTS.webApi, "GET", String.raw`/api/company/\d+/locations`, "read", "tenant"),
  r("warehouses", HOSTS.webApi, "GET", String.raw`/api/warehouses/v1/\d+/warehouses`, "read", "tenant"),
  r("transactions", HOSTS.webApi, "GET", String.raw`/api/transactions/v1/\d+/transactions`, "read", "tenant"),
  r("cashflow.latest", HOSTS.webApi, "GET", String.raw`/api/cashflow-collection/v1/\d+/latest/?`, "read", "tenant"),
  r("cashbags.history", HOSTS.webApi, "GET", String.raw`/api/cash-bag-tracking/v2/\d+/cash-bag-history-list`, "read", "tenant"),
  r("user.details", HOSTS.routeApi, "GET", "/user/get/user-details"),

  // ── Web-app sign-in (auth module only) ─────────────────────────────────────
  r("auth.token", HOSTS.auth, "POST", "/auth/realms/televend/protocol/openid-connect/token", "auth"),

  // ── Official API (documented on the developer portal) ──────────────────────
  ...[HOSTS.officialUatApi, HOSTS.officialApi].flatMap((host) => [
    r(`official.stream.read@${host}`, host, "GET", `/televend-api/data-streaming/${SLUG}/api/v1/(?:records|offsets)`),
    r(`official.stream.commit@${host}`, host, "POST", `/televend-api/data-streaming/${SLUG}/api/v1/offsets`, "offset-commit"),
    r(`official.importer.read@${host}`, host, "GET", `/televend-api/importer/${SLUG}/api/v1`),
    r(`official.operational.read@${host}`, host, "GET", String.raw`/televend-api/operational/(?:product|order|ticket)/api/v1(?:/[A-Za-z0-9_-]+)?`),
  ]),
  r("official.auth.uat", HOSTS.officialUatAuth, "POST", String.raw`/auth/realms/[A-Za-z0-9_-]+/protocol/openid-connect/token`, "auth"),
];

export type Decision =
  | { readonly allowed: true; readonly rule: Rule; readonly url: URL }
  | { readonly allowed: false; readonly reason: string };

/**
 * May this request leave the process? Pure and synchronous, so it can be tested exhaustively
 * and called in front of every single `fetch`.
 *
 * `kinds` says which rule kinds the CALLER may use: sources get `read` only; the auth module
 * gets `auth`; the official streaming consumer gets `offset-commit` only when enabled.
 */
export function decide(method: string, rawUrl: string, kinds: ReadonlySet<RuleKind>): Decision {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "POST") return { allowed: false, reason: `method ${m} is never sent` };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "not an absolute URL" };
  }
  if (url.protocol !== "https:") return { allowed: false, reason: "only https is allowed" };
  if (url.username || url.password) return { allowed: false, reason: "credentials in the URL" };
  if (url.port && url.port !== "443") return { allowed: false, reason: "non-standard port" };
  if (url.hash) return { allowed: false, reason: "fragment in the URL" };

  // The URL parser quietly resolves `..`, `%2e%2e` and duplicate slashes. If the path we
  // would send differs from the path the caller wrote, something is trying to walk out of an
  // allowed prefix — refuse rather than send the normalised form.
  const writtenPath = rawUrl.replace(/^[a-z]+:\/\/[^/?#]+/i, "").split(/[?#]/, 1)[0] ?? "";
  if (writtenPath !== url.pathname) return { allowed: false, reason: "path is not in canonical form" };
  if (/%2e|%2f|%5c|\\|\/\//i.test(url.pathname)) return { allowed: false, reason: "encoded or doubled path separators" };

  const host = url.hostname.toLowerCase();
  const rule = RULES.find((x) => x.host === host && x.method === m && x.path.test(url.pathname));
  if (!rule) return { allowed: false, reason: "not on the allow-list" };
  if (!kinds.has(rule.kind)) return { allowed: false, reason: `rule ${rule.id} (${rule.kind}) is not available to this caller` };
  if (m === "POST" && url.search) return { allowed: false, reason: "query string on a POST" };
  return { allowed: true, rule, url };
}

export const READ_ONLY: ReadonlySet<RuleKind> = new Set<RuleKind>(["read"]);
export const AUTH_ONLY: ReadonlySet<RuleKind> = new Set<RuleKind>(["auth"]);
