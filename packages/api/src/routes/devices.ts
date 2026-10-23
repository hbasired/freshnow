import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DeviceAuthRefused,
  bindCredential,
  changePin,
  createEnrolment,
  devicePeople,
  enrolDevice,
  issueSetupCode,
  listDevices,
  refreshSession,
  revokeCredential,
  revokeDevice,
  signIn,
  signOut,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * Phones and phone sign-in over HTTP (TASK-058, D210). Logic and every check are in core
 * (device-auth.ts); this file only translates.
 *
 *   /device/*                 the phone's own calls. Outside /dashboard on purpose: the phone has no
 *                             Supabase session, it proves itself with its id and secret — in HEADERS,
 *                             never in a URL, where proxies and browsers write them down.
 *   /dashboard/devices…       the CEO's and Admins' (and a lead's) side: enrol a phone, see phones, set a
 *                             person up, switch a phone or a sign-in off. Under the dashboard's sign-in;
 *                             an app token is refused there (the auth hook opens only APP_ROUTES to it).
 *
 * Nothing secret is ever in a response twice: device secrets, person secrets and tokens are shown once,
 * and every response here says no-store.
 */

const DeviceHeaders = z.object({
  "x-device-id": z.string().uuid(),
  "x-device-secret": z.string().min(16).max(200),
});

function device(req: FastifyRequest): { deviceId: string; deviceSecret: string } {
  const h = DeviceHeaders.parse(req.headers);
  return { deviceId: h["x-device-id"], deviceSecret: h["x-device-secret"] };
}

const Pin = z.string().min(1).max(12);

function refuse(req: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply | null {
  if (!(err instanceof DeviceAuthRefused)) return null;
  const retry = typeof err.extra.retryAfterSeconds === "number" ? err.extra.retryAfterSeconds : null;
  if (retry !== null) reply.header("retry-after", String(retry));
  return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...err.extra, correlationId: req.correlationId } });
}

/** Run a core call, answer its refusal in the person's words, and keep tokens out of every cache. */
async function answer<T>(req: FastifyRequest, reply: FastifyReply, run: () => Promise<T>, status = 200): Promise<FastifyReply> {
  reply.header("cache-control", "no-store");
  try {
    const out = await run();
    return reply.code(status).send(out);
  } catch (err) {
    const r = refuse(req, reply, err);
    if (r) return r;
    throw err;
  }
}

export function registerDeviceRoutes(app: FastifyInstance): void {
  // ── The phone ──────────────────────────────────────────────────────────────
  app.post("/device/enrol", async (req, reply) => {
    const b = z
      .object({ code: z.string().min(10).max(64), platform: z.string().max(80).optional(), model: z.string().max(80).optional(), appVersion: z.string().max(40).optional() })
      .parse(req.body);
    return answer(req, reply, () =>
      enrolDevice({
        code: b.code,
        ...(b.platform ? { platform: b.platform } : {}),
        ...(b.model ? { model: b.model } : {}),
        ...(b.appVersion ? { appVersion: b.appVersion } : {}),
        correlationId: req.correlationId,
      }), 201);
  });

  // A POST, so the phone's secret never sits in a URL.
  app.post("/device/people", async (req, reply) => answer(req, reply, async () => ({ people: await devicePeople(device(req)) })));

  app.post("/device/credentials", async (req, reply) => {
    const b = z.object({ setupCode: z.string().min(5).max(40), pin: Pin }).parse(req.body);
    return answer(req, reply, () => bindCredential({ ...device(req), setupCode: b.setupCode, pin: b.pin, correlationId: req.correlationId }), 201);
  });

  app.post("/device/sign-in", async (req, reply) => {
    const b = z.object({ employeeId: z.string().uuid(), personSecret: z.string().min(16).max(200), pin: Pin }).parse(req.body);
    return answer(req, reply, () => signIn({ ...device(req), ...b, correlationId: req.correlationId }));
  });

  app.post("/device/refresh", async (req, reply) => {
    const b = z.object({ refreshToken: z.string().min(16).max(200) }).parse(req.body);
    return answer(req, reply, () => refreshSession({ ...device(req), refreshToken: b.refreshToken, correlationId: req.correlationId }));
  });

  app.post("/device/sign-out", async (req, reply) => {
    const b = z.object({ refreshToken: z.string().min(16).max(200) }).parse(req.body);
    return answer(req, reply, () => signOut({ ...device(req), refreshToken: b.refreshToken, correlationId: req.correlationId }));
  });

  app.post("/device/pin", async (req, reply) => {
    const b = z.object({ employeeId: z.string().uuid(), personSecret: z.string().min(16).max(200), pin: Pin, newPin: Pin }).parse(req.body);
    return answer(req, reply, () => changePin({ ...device(req), ...b, correlationId: req.correlationId }));
  });

  // ── The dashboard side ─────────────────────────────────────────────────────
  app.post("/dashboard/devices/enrolments", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const b = z
      .object({ kind: z.enum(["company", "personal"]), label: z.string().min(1).max(80), employeeId: z.string().uuid().optional() })
      .parse(req.body);
    return answer(
      req,
      reply,
      async () => {
        const e = await createEnrolment({ actor: viewer, kind: b.kind, label: b.label, employeeId: b.employeeId ?? null, correlationId: req.correlationId });
        // What the QR on the screen carries: the code, and where to take it. The app scans it once.
        return { ...e, qr: `freshnow-enrol:v1:${e.code}` };
      },
      201,
    );
  });

  app.get("/dashboard/devices", async (req, reply) => {
    const viewer = await resolveViewer(req);
    return answer(req, reply, async () => ({ devices: await listDevices({ actor: viewer }) }));
  });

  app.post("/dashboard/devices/:id/revoke", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    return answer(req, reply, () => revokeDevice({ actor: viewer, deviceId: id, ...(b.reason ? { reason: b.reason } : {}), correlationId: req.correlationId }));
  });

  app.post("/dashboard/people/:id/phone-setup-code", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (viewer.status !== "active") return forbid(req, reply, "Your account is not active");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return answer(req, reply, () => issueSetupCode({ actor: viewer, employeeId: id, correlationId: req.correlationId }), 201);
  });

  app.post("/dashboard/app-credentials/:id/revoke", async (req, reply) => {
    const viewer = await resolveViewer(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return answer(req, reply, () => revokeCredential({ actor: viewer, credentialId: id, correlationId: req.correlationId }));
  });
}
