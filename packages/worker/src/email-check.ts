import "dotenv/config";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { emailAllowlist, inboxConfig } from "@freshnow/core";

/**
 * `pnpm email:check` — can this machine log in to the mail server? Sends nothing, reads nothing
 * but the folder's message count. `pnpm email:check --send` also sends one test email to each
 * address on EMAIL_ALLOWLIST (and only those).
 *
 * The usual Gmail failures, and what they mean:
 *   535 / "Username and Password not accepted" → not an App Password, or 2-Step Verification off
 *   "Invalid credentials (Failure)" over IMAP   → the same, for reading
 *   ENOTFOUND / ETIMEDOUT                       → no internet, or a firewall blocks 465 / 993
 */

const send = process.argv.includes("--send");
let failed = false;

async function checkSmtp(): Promise<void> {
  const host = process.env.SMTP_HOST;
  const from = process.env.EMAIL_FROM;
  if (!host || !from) {
    console.log("– sending: SMTP_HOST / EMAIL_FROM not set");
    return;
  }
  const port = Number(process.env.SMTP_PORT ?? 587);
  const t = createTransport({
    host,
    port,
    secure: port === 465,
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } } : {}),
    connectionTimeout: 15_000,
  });
  try {
    await t.verify();
    console.log(`✓ sending: logged in to ${host}:${port} as ${process.env.SMTP_USER ?? "(no login)"}`);
    if (send) {
      const allow = emailAllowlist();
      if (!allow) {
        console.log("– test email not sent: EMAIL_ALLOWLIST is not set (the check only ever writes to allowed addresses)");
        return;
      }
      for (const to of allow) {
        await t.sendMail({ from, to, subject: "FreshNow test email", text: "This is a test from pnpm email:check --send. If you can read it, sending works.\n\n— FreshNow Operations" });
        console.log(`✓ test email sent to ${to}`);
      }
    }
  } catch (err) {
    failed = true;
    console.log(`✗ sending: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkImap(): Promise<void> {
  const cfg = inboxConfig();
  if (!cfg) {
    console.log("– reading: EMAIL_IMAP_* / EMAIL_INBOX_ADDRESS not set — replies will not be read");
    return;
  }
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass }, logger: false, connectionTimeout: 15_000 });
  try {
    await c.connect();
    const status = await c.status(cfg.mailbox, { messages: true });
    console.log(`✓ reading: logged in to ${cfg.host} as ${cfg.user}; ${cfg.mailbox} holds ${status ? (status.messages ?? "?") : "?"} message(s). Only mail to ${cfg.inboxAddress} will be read.`);
    await c.logout();
  } catch (err) {
    failed = true;
    // The server's own words ("[AUTHENTICATIONFAILED] Invalid credentials") say far more than
    // the library's "Command failed".
    const why = (err as { responseText?: string }).responseText ?? (err instanceof Error ? err.message : String(err));
    console.log(`✗ reading: ${why}`);
    c.close();
  }
}

await checkSmtp();
await checkImap();
process.exitCode = failed ? 1 : 0;
