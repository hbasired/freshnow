import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

// Integration tests via Fastify's in-process inject() — the real handler path,
// the real error model, and the real database (throwaway freshnow_test DB).
const app = buildServer(false);

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("Core API skeleton", () => {
  it("GET /health reports ok and echoes a correlation id", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(res.headers["x-correlation-id"]).toBeTruthy();
  });

  it("echoes an inbound correlation id unchanged", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": "corr-abc-123" },
    });
    expect(res.headers["x-correlation-id"]).toBe("corr-abc-123");
  });

  it("unknown route returns the 404 error model", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("POST /employees/invite creates a code and writes an audit row", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/employees/invite",
      payload: { displayName: "Test Invitee" },
    });
    expect(res.statusCode).toBe(201);
    const code = res.json().code as string;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);

    const sql = getServiceSql();
    const invite = await sql`select code from invite_code where code = ${code}`;
    expect(invite.length).toBe(1);
    const audit =
      await sql`select 1 from audit_log where entity_id = ${code} and action = 'invite.created'`;
    expect(audit.length).toBe(1);

    // cleanup (service role can delete in the throwaway DB)
    await sql`delete from invite_code where code = ${code}`;
    await sql`delete from audit_log where entity_id = ${code}`;
  });

  it("POST /employees/invite rejects a missing displayName with a 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/employees/invite",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
