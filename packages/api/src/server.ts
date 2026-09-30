import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { MAX_FILE_BYTES } from "@freshnow/core";
import { ZodError } from "zod";
import { registerHealthRoute } from "./routes/health.js";
import { registerEmployeeRoutes } from "./routes/employees.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerWorkRoutes } from "./routes/work.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerInboundRoutes } from "./routes/inbound.js";
import { registerAuthProxyRoutes } from "./routes/auth-proxy.js";
import { registerComplianceRoutes } from "./routes/compliance.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Build the Core API. Everything here is channel-agnostic: the bot, dashboard,
 * and future adapters call the same routes. Pass `logger: false` in tests.
 */
export function buildServer(logger = true): FastifyInstance {
  const app = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
  });

  // Browser uploads of work documents. One file per request, capped at the same size the
  // bot accepts, so the same safety gate sees the same worst case from both channels.
  void app.register(multipart, { limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 5 } });

  // Correlation id: accept an inbound one or mint it; echo on the response so a
  // run can be followed across the bot, API, worker, and audit_log.
  app.decorateRequest("correlationId", "");
  app.addHook("onRequest", async (req, reply) => {
    const incoming = req.headers["x-correlation-id"];
    req.correlationId =
      typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    reply.header("x-correlation-id", req.correlationId);
  });

  // One consistent error shape. Zod validation failures become 400s.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "validation_error",
          message: "Invalid request",
          issues: err.issues,
          correlationId: req.correlationId,
        },
      });
    }
    // Fastify 5 types the handler error as `unknown`; read the fields we need.
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return reply.status(status).send({
      error: {
        code: status >= 500 ? "internal_error" : "request_error",
        message: status >= 500 ? "Internal error" : (e.message ?? "Request error"),
        correlationId: req.correlationId,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: "not_found", message: "Not found", correlationId: req.correlationId },
    });
  });

  registerHealthRoute(app);
  registerEmployeeRoutes(app);
  // Dashboard first: it installs the auth hooks that guard /dashboard* and /employees*,
  // and the write routes below live under that prefix so they inherit them.
  registerDashboardRoutes(app);
  registerWorkRoutes(app);
  registerDocumentRoutes(app);
  registerTaskRoutes(app);
  registerAlertRoutes(app);
  registerComplianceRoutes(app);
  registerProjectRoutes(app);
  registerEventRoutes(app);
  // Outside /dashboard/* on purpose: a mail edge is a machine and cannot hold a JWT. It
  // carries its own shared-secret guard plus SPF/DKIM/DMARC checks — see routes/inbound.ts.
  registerInboundRoutes(app);
  // Sign-in on the same origin as the page, for a local Supabase — see routes/auth-proxy.ts.
  registerAuthProxyRoutes(app);
  return app;
}
