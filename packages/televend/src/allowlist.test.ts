import { describe, expect, it } from "vitest";
import { AUTH_ONLY, READ_ONLY, RULES, decide, type RuleKind } from "./allowlist.js";

const API = "https://api-cloud.televendcloud.com";
const WEB = "https://cloud-cloud-web-app.televendcloud.com";
const ROUTE = "https://cloud-route-service-tc.televendcloud.com";
const UAT = "https://uat-api.televendcloud.com/televend-api";
const TC = "tenants/5/companies/3334";

/**
 * Every write this project has seen in Televend's own sources — the developer-portal OpenAPI
 * specs and the web app's bundles (researched 2026-10-15). Each must be refused for every
 * caller, including the official streaming consumer. If Televend adds a write, add it here.
 */
const KNOWN_WRITES: ReadonlyArray<readonly [string, string, string]> = [
  ["PATCH", `${UAT}/importer/machines/api/v1/upsert`, "master-data upsert"],
  ["POST", `${UAT}/importer/machines/api/v1/delete`, "master-data delete"],
  ["POST", `${UAT}/importer/common/api/v1/update-external-id`, "update external id"],
  ["POST", `${UAT}/operational/ticket/api/v1`, "create service ticket"],
  ["PUT", `${UAT}/operational/order/api/v1/42`, "update warehouse order"],
  ["POST", `${UAT}/operational/price-change/api/v1/bulk/snapshot/upsert`, "bulk price change"],
  ["POST", `${UAT}/data-streaming/vends/api/v1/offsets/reset?resetType=EARLIEST`, "offset reset"],
  ["POST", `${API}/machinist/api/v1/${TC}/events/123/resolve`, "resolve an alarm"],
  ["PUT", `${API}/machinist/api/v1/${TC}/events/123/assign-user/7`, "assign an alarm"],
  ["POST", `${API}/machinist/api/v1/${TC}/events/123/remove-user/7`, "unassign an alarm"],
  ["POST", `${API}/machinist/api/v1/${TC}/machines/12/push/planogram`, "push planogram"],
  ["POST", `${API}/machinist/api/v1/${TC}/machines/12/push/prices`, "push prices"],
  ["POST", `${API}/cashtrack/v1/${TC}/collections/export/xlsx`, "cash export job"],
  ["PATCH", `${API}/cashtrack/v1/${TC}/collections/99`, "cash collection note"],
  ["POST", `${API}/cashtrack/v1/${TC}/conforms/17/pair`, "pair a cash conformity"],
  ["POST", `${API}/reportforge/${TC}/reports/v1/reports`, "create a report"],
  ["POST", `${ROUTE}/route_order/route_list`, "route order list (POST)"],
  ["POST", `${ROUTE}/route_order/consignment_stock`, "consignment stock"],
  ["POST", `${WEB}/companies/3334/invoices/send-to-xero`, "send invoices to Xero"],
  // GETs that START something on Televend's side (an export job that can e-mail its result):
  ["GET", `${WEB}/api/vend/v1/3334/export/xlsx`, "vends export job (GET with side effects)"],
  ["GET", `${WEB}/api/reports-center/v1/company/3334/export/csv`, "report export job (GET with side effects)"],
  ["DELETE", `${API}/machinist/api/v1/${TC}/machines/12`, "delete a machine"],
];

const ALL_KINDS = new Set<RuleKind>(["read", "auth", "offset-commit"]);

describe("the Televend allow-list", () => {
  it.each(KNOWN_WRITES)("refuses %s %s (%s) for every kind of caller", (method, url) => {
    expect(decide(method, url, ALL_KINDS).allowed).toBe(false);
    expect(decide(method, url, READ_ONLY).allowed).toBe(false);
  });

  it.each([
    [`${API}/machinist/api/v1/${TC}/machines`],
    [`${API}/machinist/api/v1/${TC}/machines/2202635902`],
    [`${API}/machinist/api/v1/${TC}/vends?page=1&page_size=100&from_timestamp=2026-10-12T00%3A00%3A00%2B04%3A00`],
    [`${API}/machinist/api/v1/${TC}/vends/aggregates?from_timestamp=x`],
    [`${API}/machinist/api/v1/${TC}/events?resolved=false`],
    [`${API}/cashtrack/v1/${TC}/collections?page=1`],
    [`${API}/cashtrack/v1/${TC}/collections/77`],
    [`${API}/refillator/api/v1/refill-log-list/3334/details`],
    [`${API}/warden/televendcloud/access-control-list`],
    [`${WEB}/api/dashboard/v1/3334/stats/vends/today`],
    [`${WEB}/api/event/v1/3334/latest/`],
    [`${ROUTE}/user/get/user-details`],
    [`${UAT}/data-streaming/vends/api/v1/records`],
    [`${UAT}/importer/machines/api/v1?page=1&page_size=100`],
    [`${UAT}/operational/ticket/api/v1/abc-1`],
  ])("allows the read GET %s", (url) => {
    const d = decide("GET", url, READ_ONLY);
    expect(d.allowed).toBe(true);
  });

  it("keeps the token endpoint away from ordinary callers", () => {
    const token = "https://auth.televendcloud.com/auth/realms/televend/protocol/openid-connect/token";
    expect(decide("POST", token, READ_ONLY).allowed).toBe(false);
    expect(decide("POST", token, AUTH_ONLY).allowed).toBe(true);
    expect(decide("GET", token, AUTH_ONLY).allowed).toBe(false);
  });

  it("allows the official offset commit only to a caller that holds that permission", () => {
    const commit = `${UAT}/data-streaming/vends/api/v1/offsets`;
    expect(decide("POST", commit, READ_ONLY).allowed).toBe(false);
    expect(decide("POST", commit, new Set<RuleKind>(["offset-commit"])).allowed).toBe(true);
    expect(decide("POST", `${commit}?force=1`, new Set<RuleKind>(["offset-commit"])).allowed).toBe(false);
  });

  it.each([
    ["http (not https)", `http://api-cloud.televendcloud.com/machinist/api/v1/${TC}/vends`],
    ["a look-alike host", `https://api-cloud.televendcloud.com.evil.example/machinist/api/v1/${TC}/vends`],
    ["a host only in the path", `https://evil.example/api-cloud.televendcloud.com/machinist/api/v1/${TC}/vends`],
    ["credentials in the URL", `https://user:pw@api-cloud.televendcloud.com/machinist/api/v1/${TC}/vends`],
    ["a non-standard port", `https://api-cloud.televendcloud.com:8443/machinist/api/v1/${TC}/vends`],
    ["a fragment", `https://api-cloud.televendcloud.com/machinist/api/v1/${TC}/vends#x`],
    ["dot-dot walking out of a read path", `https://api-cloud.televendcloud.com/machinist/api/v1/${TC}/vends/../events/1/resolve`],
    ["encoded dot-dot", `https://api-cloud.televendcloud.com/machinist/api/v1/${TC}/vends/%2e%2e/events`],
    ["a doubled slash", `https://api-cloud.televendcloud.com/machinist/api/v1//${TC}/vends`],
    ["a backslash", `https://api-cloud.televendcloud.com/machinist/api/v1/${TC}/vends\\x`],
    ["an unknown path on a known host", `https://api-cloud.televendcloud.com/machinist/api/v1/${TC}/users`],
    ["a host that is not Televend", "https://example.com/machinist"],
    ["the Odoo technical centre", "https://technical-center.televendcloud.com/inventory-adjustments"],
    ["not a URL", "machinist/api/v1/vends"],
  ])("refuses %s", (_why, url) => {
    expect(decide("GET", url, ALL_KINDS).allowed).toBe(false);
  });

  it("has no rule that lets an ordinary read caller do anything but GET", () => {
    for (const rule of RULES) {
      if (rule.kind === "read") expect(rule.method).toBe("GET");
      else expect(rule.kind === "auth" || rule.kind === "offset-commit").toBe(true);
    }
  });

  it("has no read rule whose path mentions an export, a report or a push", () => {
    for (const rule of RULES.filter((x) => x.kind === "read")) {
      expect(rule.path.source).not.toMatch(/export|report|push|upsert|delete|resolve|assign|xero/i);
    }
  });
});
