import {
  Bot,
  type Context,
  InlineKeyboard,
  session,
  type SessionFlavor,
} from "grammy";
import { sequentialize } from "@grammyjs/runner";
import {
  acknowledgeBlocker,
  mayAcknowledgeBlocker,
  botRole,
  canAssignTo,
  listAssignable,
  listOpenBlockersFor,
  answerQuestion,
  assignTask,
  checkRateLimit,
  attachNoteAndProcess,
  consentKeyboard,
  consentNotice,
  ConsentNoticeChangedError,
  createInvite,
  currentNoticeHash,
  createTask,
  decodeTextFile,
  describeAttachment,
  documentSemaphore,
  extractPdfText,
  explainInjection,
  explainVerdict,
  DEMO_CEO_ID,
  formatDocumentPlan,
  formatEodReport,
  formatOwnWork,
  isObviousQuestion,
  loadMessageContext,
  ensureCeoLinked,
  generateAllEodReports,
  generateEodReport,
  getServiceSql,
  hasCurrentConsent,
  inspectFile,
  listEmployees,
  listOpenTasks,
  logAudit,
  markVoiceFailed,
  MAX_ATTACHMENTS,
  markVoiceTranscribed,
  noticeTag,
  planDocumentTasks,
  PROFILE_STEPS,
  profilePrompt,
  recordConsent,
  recordTaskUpdate,
  redeemInvite,
  resolveRole,
  resolveMessage,
  saveAttachments,
  saveVoiceAsset,
  safeFileName,
  summariseOwnWork,
  transcribeAudio,
  updateProfileField,
  validateInvite,
  withdrawConsent,
  type DocumentPlan,
  type ExtractedDocument,
  type SafetyReport,
  type IncomingFile,
  type ResolvedMessage,
  type ProfileStep,
  type Role,
  type ViewerOrg,
} from "@freshnow/core";
import { isStepStale, looksLikeName } from "./guards.js";
import { postgresSessionStorage } from "./session-store.js";

interface LinkedEmployee {
  id: string;
  display_name: string;
  status: string;
  language: string | null;
  access_role: "ceo" | "manager" | "lead" | "employee";
  department: string | null;
}

/**
 * Conversation state. Persisted in Postgres (see session-store.ts) — with in-memory
 * sessions every process restart silently dropped half-finished registrations and
 * pending invite codes, which made both flows look broken to the user (gotcha G25).
 */
type Step =
  | { kind: "idle" }
  | { kind: "awaiting_code" }
  | { kind: "awaiting_consent"; code: string }
  | { kind: "profile"; employeeId: string; index: number }
  | { kind: "blocker_note"; taskUpdateId: string; correlationId: string }
  // Detail added right after a Done/Pending tap. Carries the SAME task_update id, so
  // the note lands ON that task instead of becoming an orphan update.
  | { kind: "task_note"; taskUpdateId: string; correlationId: string; taskTitle: string }
  | { kind: "new_task" }
  | { kind: "invite_name" }
  | { kind: "assign_title"; toEmployeeId: string; toName: string }
  // The CEO described work but named nobody — we hold the extracted title and ask WHO,
  // rather than guessing or dropping it.
  | { kind: "assign_pending"; title: string }
  // The employee reported something that fits none of their tasks and they have more
  // than one open — we hold the words and ask WHICH, rather than filing it loose.
  | { kind: "which_task"; text: string }
  // A document was read and turned into a proposed set of routed tasks. Nothing exists
  // in the database yet: the CEO confirms with a tap before a single assignment is made.
  | { kind: "confirm_doc_tasks"; plan: PlanForConfirm }
  // The answer to a pending question does not plausibly answer it. We hold both
  // readings and ask, rather than picking one.
  | { kind: "ambiguous"; text: string; pending: string }
  // Asked "anything to add?" just before their end-of-day report is written.
  | { kind: "eod_addendum" };

/** The proposal held between "I read your document" and the CEO's tap. */
interface PlanForConfirm {
  fileName: string;
  /** Ids into `pendingFiles`, so the file can still be forwarded if asked for. */
  sendFile: boolean;
  /** False when the safety gate flagged the file — the forward option is then withheld. */
  mayForward: boolean;
  tasks: { title: string; detail: string | null; assigneeId: string | null; assigneeName: string | null }[];
}

interface SessionData {
  step: Step;
  /**
   * Files sent just before the instruction that explains them. Telegram delivers a
   * document and its explanatory message as two separate updates, so a file with no
   * caption is held here until the next message says what it is for.
   */
  pendingFiles?: IncomingFile[];
  /**
   * When the current step was set, as epoch ms.
   *
   * Without this a half-finished question stays live forever: an unanswered `/invite`
   * from the previous evening swallowed the next morning's message and turned an
   * assignment into an invite code named after the whole sentence (gotcha G31).
   */
  stepAt?: number;
}

export type FreshCtx = Context &
  SessionFlavor<SessionData> & {
    /** Set when a stale half-finished question was dropped before this update. */
    expiredStep?: string;
    role?: Role;
    employee?: LinkedEmployee | null;
    /**
     * The same permission context the API builds for a signed-in dashboard user. Present
     * whenever `employee` is; it is what `canAssignTo`, `listAssignable` and the
     * RLS-scoped blocker list are asked about — never `role`, which only picks a menu.
     */
    viewer?: ViewerOrg | null;
  };

export interface BotDeps {
  token: string;
  ceoUserId?: bigint;
}

/** Commands that work before the updated notice is agreed to — none of them takes anyone's words. */
const CONSENT_FREE_COMMANDS = new Set(["/withdraw", "/help", "/whoami", "/cancel"]);

function mainMenu(role: Role): InlineKeyboard {
  if (role === "ceo") {
    return new InlineKeyboard()
      .text("🚨 Open blockers", "menu:blockers")
      .row()
      .text("📌 Assign a task", "menu:assign")
      .row()
      .text("➕ Create invite code", "menu:invite")
      .row()
      .text("📋 Log my own tasks", "menu:log");
  }
  if (role === "manager") {
    // A manager's day is their own work plus their team's problems. No invites (the CEO
    // adds people) and no documents-to-plans (that path assigns to anyone it reads).
    return new InlineKeyboard()
      .text("🚨 My team's blockers", "menu:blockers")
      .row()
      .text("📌 Assign a task to my team", "menu:assign")
      .row()
      .text("📋 Log daily tasks", "menu:log")
      .row()
      .text("➕ Add a task", "menu:addtask")
      .row()
      .text("👤 Update my details", "menu:register");
  }
  return new InlineKeyboard()
    .text("📋 Log daily tasks", "menu:log")
    .row()
    .text("➕ Add a task", "menu:addtask")
    .row()
    .text("👤 Update my details", "menu:register");
}

export function createBot(deps: BotDeps): Bot<FreshCtx> {
  const bot = new Bot<FreshCtx>(deps.token);

  // Updates from the SAME chat are processed in order; different chats run in parallel.
  //
  // This must be the FIRST middleware, ahead of session loading, and it is what makes
  // concurrency safe here: conversation state lives in one `bot_session` row per chat.
  // Without it, two messages from one person could both read the same step, both act on
  // it, and the later write would erase the earlier — losing a half-finished
  // registration, or creating one document's tasks twice.
  bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

  // Every inbound update is logged before anything else touches it.
  //
  // "I sent it and nothing happened" was impossible to diagnose: there was no record of
  // whether the message had even reached this process. This runs FIRST — ahead of session
  // loading — so an update is visible even when a later middleware fails outright.
  bot.use(async (ctx, next) => {
    const t0 = Date.now();
    const m = ctx.message;
    const kind = m?.document
      ? `document(${m.document.file_name ?? "?"})`
      : m?.photo
        ? "photo"
        : m?.voice
          ? "voice"
          : ctx.callbackQuery
            ? `callback(${ctx.callbackQuery.data ?? "?"})`
            : m?.text
              ? "text"
              : "other";
    const preview = (m?.text ?? m?.caption ?? "").slice(0, 70);
    console.log(`[bot] <- ${kind} from ${ctx.from?.id}${preview ? ` "${preview}"` : ""}`);
    try {
      await next();
      console.log(`[bot] -> done in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error(`[bot] !! handler threw after ${Date.now() - t0}ms:`, err);
      throw err; // bot.catch still owns telling the user
    }
  });

  // Session state lives in Postgres, not memory, so a restart never loses a
  // half-finished conversation.
  bot.use(
    session<SessionData, FreshCtx>({
      initial: () => ({ step: { kind: "idle" } }),
      storage: postgresSessionStorage<SessionData>(),
    }),
  );

  // A half-finished question does not stay live forever.
  //
  // An unanswered `/invite` from the previous evening swallowed the next morning's
  // message: the bot was still waiting for a name, so "Assign the tasks to hemanth based
  // on the attached pdf document." became the name on an invite code (gotcha G31). Past
  // the TTL the person has plainly moved on, so the next message is new intent — and we
  // say so, rather than silently dropping what they were doing.
  bot.use(async (ctx, next) => {
    const kind = ctx.session.step?.kind;
    if (kind && kind !== "idle") {
      if (isStepStale(kind, ctx.session.stepAt)) {
        ctx.session.step = { kind: "idle" };
        ctx.session.stepAt = undefined;
        ctx.expiredStep = kind;
        // An expired document plan must also release the file. Otherwise the next
        // message re-plans the same document, hours later, unprompted.
        if (kind === "confirm_doc_tasks") ctx.session.pendingFiles = undefined;
      }
    }
    await next();
    // Stamp the step whenever a handler changed it, so the TTL measures the age of the
    // question actually being asked.
    const now = ctx.session.step?.kind;
    if (now !== kind) ctx.session.stepAt = now === "idle" ? undefined : Date.now();
  });

  // Auth: resolve Telegram user → role (deterministic, never a model call) and the
  // linked employee row. Telegram ids exceed int32, so they are carried as bigint.
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid != null) {
      const configCeo = deps.ceoUserId != null && resolveRole(BigInt(uid), deps.ceoUserId) === "ceo";
      const sql = getServiceSql();
      const rows = await sql<LinkedEmployee[]>`
        select id, display_name, status, language, access_role, department
        from employee where telegram_user_id = ${uid}`;
      const emp = rows[0] ?? null;
      ctx.employee = emp;
      // The configured Telegram id is the anchor; the row's access_role is what the
      // dashboard's People tab sets. Both are read, so a manager made on the dashboard is
      // a manager here, and the CEO is the CEO before their row even exists.
      ctx.role = botRole(configCeo, emp?.access_role);
      ctx.viewer = emp
        ? {
            employeeId: emp.id,
            isCeo: ctx.role === "ceo",
            accessRole: ctx.role === "ceo" ? "ceo" : emp.access_role,
            department: emp.department,
            displayName: emp.display_name,
            status: emp.status,
          }
        : null;
    }
    await next();
  });

  // Consent before anything else (PDPL — see core/src/consent.ts).
  //
  // A linked person who has not agreed to the notice AS IT READS TODAY gets the notice and an
  // "I agree" button, and nothing they sent is processed: taking their words would send them
  // to the AI services the notice names, which is exactly what they have not yet agreed to.
  // The reply says so plainly — the message is not silently dropped. This runs on every
  // update, so a notice that changes (a new AI provider, a new retention period) is put to
  // each person the next time they use the bot, and the worker also asks them unprompted.
  //
  // Still reachable without consent: withdrawing, help, who-am-I, cancel, and the consent
  // buttons themselves. People who are not linked yet are onboarded below, where the same
  // notice is shown before an invite code is redeemed.
  bot.use(async (ctx, next) => {
    const emp = ctx.employee;
    if (!emp || emp.status !== "active") return next();
    const command = ctx.message?.text?.startsWith("/") ? ctx.message.text.split(/[\s@]/)[0] : undefined;
    if (command && CONSENT_FREE_COMMANDS.has(command)) return next();
    if (ctx.callbackQuery?.data?.startsWith("consent:")) return next();
    if (await hasCurrentConsent(emp.id)) return next();

    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Please read the updated notice first." });
    const anything = ctx.message != null && command !== "/start";
    await ctx.reply(
      "📄 Before we carry on: FreshNow's privacy notice has changed. Please read it and tap “✅ I agree”." +
        (anything ? "\n\nI have not recorded the message you just sent — send it again after you agree." : "") +
        "\n\n" +
        consentNotice("en"),
      { reply_markup: consentKeyboard() },
    );
  });

  // The tag in the button ties the tap to the words it was sent under. A tap on an older
  // message, after the notice changed again, must not record agreement to text the person
  // never saw — they get the current notice instead.
  bot.callbackQuery(/^consent:renew:([0-9a-f]{16})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.employee) return void (await ctx.reply("You are not linked to an employee record — send /start."));
    if (ctx.match![1] !== noticeTag()) {
      await ctx.reply(
        "The notice has changed again since that message. Here is the current one:\n\n" + consentNotice("en"),
        { reply_markup: consentKeyboard() },
      );
      return;
    }
    // A second tap on the same button (or on the worker's copy after agreeing in the app) is
    // not a second agreement; one record per agreement keeps the history readable.
    if (await hasCurrentConsent(ctx.employee.id)) {
      return void (await ctx.reply("✅ Already recorded — you can carry on.", { reply_markup: mainMenu(ctx.role ?? "employee") }));
    }
    try {
      await recordConsent({ employeeId: ctx.employee.id, noticeHash: currentNoticeHash(), via: "telegram" });
    } catch (err) {
      if (!(err instanceof ConsentNoticeChangedError)) throw err;
      await ctx.reply("The notice changed a moment ago. Here is the current one:\n\n" + consentNotice("en"), {
        reply_markup: consentKeyboard(),
      });
      return;
    }
    await ctx.reply("✅ Thank you — recorded. You can carry on.", { reply_markup: mainMenu(ctx.role ?? "employee") });
  });

  bot.callbackQuery("consent:later", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Okay. Until you agree I can't take your updates, and nothing about you is sent to Telegram or the AI service. " +
        "Send /start to read the notice again, or /withdraw to stop using the system.",
    );
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    ctx.session.step = { kind: "idle" };
    const uid = ctx.from?.id;

    await logAudit({
      actor: `telegram:${uid ?? "unknown"}`,
      action: "bot.start",
      detail: { telegramUserId: uid ?? null, role: ctx.role ?? null, linked: ctx.employee != null },
    });

    // The CEO is identified by config, not self-declaration. Bind their account to
    // the CEO employee row so routed alerts have somewhere to land.
    if (ctx.role === "ceo" && uid != null && ctx.employee == null) {
      const ok = await ensureCeoLinked(uid);
      if (ok) {
        const sql = getServiceSql();
        const rows = await sql<LinkedEmployee[]>`
          select id, display_name, status, language, access_role, department from employee where id = ${DEMO_CEO_ID}`;
        ctx.employee = rows[0] ?? null;
        if (ctx.employee) {
          ctx.viewer = {
            employeeId: ctx.employee.id,
            isCeo: true,
            accessRole: "ceo",
            department: ctx.employee.department,
            displayName: ctx.employee.display_name,
            status: ctx.employee.status,
          };
        }
      }
    }

    if (ctx.employee) {
      const who = ctx.role === "ceo" ? "CEO" : ctx.role === "manager" ? "manager" : "employee";
      await ctx.reply(
        `Welcome back, ${ctx.employee.display_name}.\nYou are signed in as *${who}*.\n\nPick an option below, or send /help.`,
        { parse_mode: "Markdown", reply_markup: mainMenu(ctx.role ?? "employee") },
      );
      return;
    }

    await ctx.reply(
      "👋 *Welcome to FreshNow Ops*\n\n" +
        "This is where you report your daily work.\n\n" +
        "*To join — 3 steps:*\n" +
        "1️⃣ Ask the CEO for your invite code\n" +
        "2️⃣ Tap the button below\n" +
        "3️⃣ Send the code, then answer 4 short questions about your job\n\n" +
        `_Your Telegram id: ${uid}_`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔑 I have an invite code", "menu:redeem"),
      },
    );
  });

  bot.command("help", async (ctx) => {
    const text =
      ctx.role === "ceo"
        ? "*CEO commands*\n\n" +
          "/start — your menu\n" +
          "/invite Ahmed Khan — create an invite code\n" +
          "/blockers — open problems, with one-tap Acknowledge\n" +
          "/assign — give a task to an employee\n" +
          "/cancel — stop what you were doing\n\n" +
          "You are alerted automatically whenever anyone reports a blocker."
        : ctx.role === "manager"
          ? "*Manager commands*\n\n" +
            "/start — your menu\n" +
            "/blockers — open problems raised by your team, with one-tap Acknowledge\n" +
            "/assign — give a task to someone who reports to you\n" +
            "/log — report your own day\n" +
            "/cancel — stop what you were doing\n\n" +
            "You can assign to your direct reports" +
            (ctx.viewer?.accessRole === "lead" ? " and to anyone in your department" : "") +
            ". The CEO sets who reports to whom on the dashboard.\n\n" +
            "*To report your day:* /start → 📋 Log daily tasks."
          : "*How to use this bot*\n\n" +
          "/start — your menu\n" +
          "/cancel — stop what you were doing\n" +
          "/withdraw — withdraw your consent\n\n" +
          "*To report your day:* /start → 📋 Log daily tasks.\n" +
          "For each task tap ✅ Done, ⏳ Pending or 🚫 Blocker.\n\n" +
          "If you tap 🚫 Blocker I will ask what is wrong. " +
          "Answer in English, Hindi or Malayalam — you can type it or send a voice note.";
    await ctx.reply(text, { parse_mode: "Markdown" });
  });

  bot.command("cancel", async (ctx) => {
    ctx.session.step = { kind: "idle" };
    // Release any held file too — otherwise "cancel" leaves a document that quietly
    // re-arms the document flow on the very next message.
    const hadFiles = (ctx.session.pendingFiles ?? []).length;
    ctx.session.pendingFiles = undefined;
    await ctx.reply(hadFiles ? `Okay, cancelled — and I dropped ${hadFiles} held file(s).` : "Okay, cancelled.", {
      reply_markup: mainMenu(ctx.role ?? "employee"),
    });
  });

  bot.command("skip", async (ctx) => {
    const was = ctx.session.step.kind;
    ctx.session.step = { kind: "idle" };

    // /skip during the end-of-day question means "file it as it stands", not "cancel" —
    // dropping the whole report here would be the wrong reading of one word.
    if (was === "eod_addendum" && ctx.employee) {
      await ctx.reply("📊 Writing it up…");
      const mine = await generateEodReport(ctx.employee.id);
      await ctx.reply(formatEodReport(mine), { parse_mode: "Markdown" });
      return;
    }

    await ctx.reply("No problem — the status is already saved.", {
      reply_markup: mainMenu(ctx.role ?? "employee"),
    });
  });

  // End-of-day report. The CEO gets everyone; an employee gets only their own.
  bot.command("eod", async (ctx) => {
    if (!ctx.employee) return void (await ctx.reply("Please register first — send /start."));
    await ctx.reply("📊 Building the end-of-day report…");
    try {
      if (ctx.role === "ceo") {
        const reports = await generateAllEodReports();
        const active = reports.filter((r) => r.reportsMade > 0);
        const silent = reports.filter((r) => r.reportsMade === 0);
        await ctx.reply(
          `📊 *End of day — ${reports[0]?.reportDate ?? "today"}*\n\n` +
            `${active.length} of ${reports.length} people reported.\n` +
            `Total: ✅ ${reports.reduce((a, r) => a + r.completed, 0)} completed · ` +
            `⏳ ${reports.reduce((a, r) => a + r.pending, 0)} pending · ` +
            `🚫 ${reports.reduce((a, r) => a + r.blockers, 0)} blocker(s)`,
          { parse_mode: "Markdown" },
        );
        for (const r of active) await ctx.reply(formatEodReport(r), { parse_mode: "Markdown" });
        if (silent.length > 0) {
          await ctx.reply(`🔕 No report today from: ${silent.map((r) => r.displayName).join(", ")}`);
        }
        return;
      }
      // Ask before writing it. Plenty of what matters at end of day exists only in
      // someone's head — "the part arrives Sunday, so Monday is blocked" — and is lost
      // the moment the report is filed without it.
      ctx.session.step = { kind: "eod_addendum" };
      await ctx.reply(
        "Anything to add before I write your end-of-day report?\n\n" +
          "Send it now — or tap /skip to file it as it stands.",
      );
    } catch (err) {
      await ctx.reply(
        "Could not build the report just now. The underlying data is unaffected — try again, " +
          "or open the dashboard.",
      );
      console.error("[bot] /eod failed:", err);
    }
  });

  bot.command("whoami", async (ctx) => {
    await ctx.reply(
      `Telegram id: ${ctx.from?.id}\nRole: ${ctx.role ?? "unknown"}\n` +
        `Linked: ${ctx.employee ? ctx.employee.display_name : "no"}`,
    );
  });

  bot.command("withdraw", async (ctx) => {
    if (!ctx.employee) return void (await ctx.reply("You are not linked to an employee record."));
    await withdrawConsent(ctx.employee.id);
    await ctx.reply(
      "Your consent has been withdrawn and your account is disabled.\n" +
        "Existing records are kept as the operational record, but you will not be prompted again.",
    );
  });

  // ── Onboarding: redeem invite → consent → self-filled profile ─────────────
  bot.callbackQuery("menu:redeem", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.step = { kind: "awaiting_code" };
    await ctx.reply(
      "Please type your invite code and send it.\n\n" +
        "It is 8 letters and numbers, like `K7M2QXAB`.\n" +
        "_(the CEO gives you this code)_",
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("consent:decline", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.step = { kind: "idle" };
    await ctx.reply("No problem — nothing has been recorded. Send /start if you change your mind.");
  });

  bot.callbackQuery("consent:agree", async (ctx) => {
    await ctx.answerCallbackQuery();
    const step = ctx.session.step;
    if (step.kind !== "awaiting_consent") {
      return void (await ctx.reply("That consent request expired. Send /start to begin again."));
    }
    const uid = ctx.from?.id;
    if (uid == null) return;

    const res = await redeemInvite(step.code, uid, "en");
    if (!res.ok) {
      ctx.session.step = { kind: "idle" };
      return void (await ctx.reply(
        `Could not use that code (${res.reason}). Please ask the CEO for a new one.`,
      ));
    }

    ctx.session.step = { kind: "profile", employeeId: res.employeeId!, index: 0 };
    await ctx.reply(
      `✅ Thank you, ${res.displayName}. You are now registered.\n\n` +
        "Now 4 quick questions about your job — you know it better than anyone.",
    );
    await ctx.reply(profilePrompt(PROFILE_STEPS[0]!));
  });

  bot.callbackQuery(/^lang:(en|hi|ml)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = ctx.match![1]!;
    if (!ctx.employee) return;
    await updateProfileField(ctx.employee.id, "language", lang);
    ctx.session.step = { kind: "idle" };
    const msg =
      lang === "hi"
        ? "भाषा हिंदी पर सेट है। ✅"
        : lang === "ml"
          ? "ഭാഷ മലയാളം ആയി സജ്ജമാക്കി. ✅"
          : "Language set to English. ✅";
    await ctx.reply(msg, { reply_markup: mainMenu(ctx.role ?? "employee") });
  });

  bot.callbackQuery("menu:register", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.employee) return void (await ctx.reply("Please enter an invite code first — send /start."));
    ctx.session.step = { kind: "profile", employeeId: ctx.employee.id, index: 0 };
    await ctx.reply(profilePrompt(PROFILE_STEPS[0]!));
  });

  // ── Daily task logging ────────────────────────────────────────────────────
  bot.callbackQuery("menu:log", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showLogBoard(ctx);
  });

  // The same board, reachable as a command. Menu-diving to report your day is a barrier
  // for exactly the people who most need to report it — /log goes straight there.
  bot.command(["log", "status", "mytasks"], async (ctx) => {
    await showLogBoard(ctx);
  });

  bot.callbackQuery("menu:addtask", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.employee) return void (await ctx.reply("Please enter an invite code first — send /start."));
    ctx.session.step = { kind: "new_task" };
    await ctx.reply("What is the task? Send me a short title.");
  });

  bot.callbackQuery(/^log:([0-9a-f-]{36}):(done|pending|blocker)$/, async (ctx) => {
    const taskId = ctx.match![1]!;
    const status = ctx.match![2] as "done" | "pending" | "blocker";
    if (!ctx.employee) {
      return void (await ctx.answerCallbackQuery({ text: "Not registered yet." }));
    }
    await ctx.answerCallbackQuery();

    // The button tap IS the status — deterministic, recorded immediately.
    const rec = await recordTaskUpdate({
      taskId,
      employeeId: ctx.employee.id,
      status,
      telegramMessageId: ctx.callbackQuery.message?.message_id ?? null,
    });

    // ALWAYS name the task in the confirmation.
    //
    // Telegram posts this reply at the bottom of the chat, far from the card that was
    // tapped. With several task cards stacked, "Recorded as done. Anything to add about
    // this task?" gives the person no way to tell WHICH one they just hit — and on
    // 2026-09-09 that put a note about the demo platform onto "Assign tasks from PDF",
    // then left the CEO looking at a task the employee believed was finished (G40).
    const rows = await getServiceSql()<{ title: string }[]>`
      select title from task where id = ${taskId}`;
    const title = rows[0]?.title ?? "the task";

    if (status !== "blocker") {
      // Offer to add detail, carrying the SAME task_update id so anything they add is
      // attached to this task rather than becoming a standalone update.
      ctx.session.step = {
        kind: "task_note",
        taskUpdateId: rec.taskUpdateId,
        correlationId: rec.correlationId,
        taskTitle: title,
      };
      return void (await ctx.reply(
        (status === "done" ? "✅ Recorded as *done*" : "⏳ Recorded as *pending*") +
          `: "${title}"\n\nAnything to add about it? Send it now — or tap /skip.`,
        { parse_mode: "Markdown" },
      ));
    }

    ctx.session.step = {
      kind: "blocker_note",
      taskUpdateId: rec.taskUpdateId,
      correlationId: rec.correlationId,
    };
    await ctx.reply(
      `🚫 Recorded as *blocked*: "${title}"\n\nWhat is stopping it?\n` +
        "_Type it or send a voice note — English, Hindi or Malayalam._",
      { parse_mode: "Markdown" },
    );
  });

  // ── CEO actions ───────────────────────────────────────────────────────────
  bot.callbackQuery("menu:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.role !== "ceo") return void (await ctx.reply("Only the CEO can create invites."));
    ctx.session.step = { kind: "invite_name" };
    await ctx.reply(
      "Type the new person's name and send it.\n\n_Shortcut: you can also send_ `/invite Ahmed Khan`",
      { parse_mode: "Markdown" },
    );
  });

  bot.command("invite", async (ctx) => {
    if (ctx.role !== "ceo") return void (await ctx.reply("Only the CEO can create invites."));
    const name = typeof ctx.match === "string" ? ctx.match.trim() : "";
    if (!name) {
      ctx.session.step = { kind: "invite_name" };
      return void (await ctx.reply("Type the new person's name and send it."));
    }
    await issueInvite(ctx, name);
  });

  bot.callbackQuery("menu:blockers", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.role === "employee") return void (await ctx.reply("Only the CEO or a manager sees the blocker queue."));
    await showBlockers(ctx);
  });

  bot.command("blockers", async (ctx) => {
    if (ctx.role === "employee") return void (await ctx.reply("Only the CEO or a manager sees the blocker queue."));
    await showBlockers(ctx);
  });

  bot.callbackQuery(/^ack:([0-9a-f-]{36})$/, async (ctx) => {
    // Acknowledging suppresses escalation, so it is restricted: the CEO, the person the
    // blocker was routed to, or someone who manages the person who raised it — the same
    // rule the dashboard applies (core `mayAcknowledgeBlocker`). Callback data is
    // guessable (a blocker id), so without the check any registered employee could
    // silence an alert about their own blocker and it would never reach anyone.
    const blockerId = ctx.match![1]!;
    if (!ctx.employee || !(await mayAcknowledgeBlocker(ctx.employee.id, blockerId))) {
      return void (await ctx.answerCallbackQuery({
        text: "Only the CEO, the assigned resolver or the raiser's manager can acknowledge this.",
        show_alert: true,
      }));
    }
    await ctx.answerCallbackQuery({ text: "Acknowledged" });
    // Record WHO acknowledged, not just that someone did.
    await acknowledgeBlocker(blockerId, undefined, { by: ctx.employee?.id });
    await ctx.reply("✅ Blocker acknowledged — it will no longer escalate.");
  });

  bot.callbackQuery("menu:assign", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.role === "employee") return void (await ctx.reply("Only the CEO or a manager can assign tasks."));
    await showDirectory(ctx);
  });

  bot.command("assign", async (ctx) => {
    if (ctx.role === "employee") return void (await ctx.reply("Only the CEO or a manager can assign tasks."));
    await showDirectory(ctx);
  });

  bot.callbackQuery(/^assignto:([0-9a-f-]{36})$/, async (ctx) => {
    const toId = ctx.match![1]!;
    // Callback data is guessable (an employee id), so the directory having listed this
    // person is not enough: the write rule is asked again, here and once more at the
    // moment of the write. `canAssignTo` is the same predicate the dashboard applies.
    if (!ctx.viewer || !(await canAssignTo(ctx.viewer, toId)) || toId === ctx.viewer.employeeId) {
      return void (await ctx.answerCallbackQuery({ text: "You can only assign to people who report to you.", show_alert: true }));
    }
    await ctx.answerCallbackQuery();
    const sql = getServiceSql();
    const rows = await sql<{ display_name: string }[]>`
      select display_name from employee where id = ${toId}`;
    const toName = rows[0]?.display_name ?? "employee";

    // If we already extracted the task and were only missing the person, finish now
    // instead of asking them to type it a second time.
    const step = ctx.session.step;
    if (step.kind === "assign_pending" && ctx.employee) {
      ctx.session.step = { kind: "idle" };
      const res = await assignTask({
        assignedBy: ctx.employee.id,
        assignedTo: toId,
        title: step.title,
        attachments: ctx.session.pendingFiles,
      });
      ctx.session.pendingFiles = undefined;
      await ctx.reply(
        `📌 Assigned to ${toName}: "${step.title}"\n` +
          (res.attachments ? `📎 ${res.attachments} file(s) sent with it.\n` : "") +
          (res.delivered ? "They have been notified." : "They are not on Telegram yet, so it is queued."),
      );
      return;
    }

    ctx.session.step = { kind: "assign_title", toEmployeeId: toId, toName };
    await ctx.reply(`What should ${toName} do? Send the task description.`);
  });

  // The CEO sent a document with no caption and chose to have it read.
  bot.callbackQuery("doc:read", async (ctx) => {
    await ctx.answerCallbackQuery();
    await planFromDocument(ctx, "Assign the work in this document to the right people.");
  });

  bot.callbackQuery("doc:wait", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("👍 Holding the file. Tell me what it is for.");
  });

  // ── Confirming a plan read out of a document ──────────────────────────────
  // Each task becomes its OWN assignment and its OWN message, so every job has a status
  // thread the employee can report against — which "here is a PDF" never had.
  bot.callbackQuery("docplan:go", async (ctx) => {
    await ctx.answerCallbackQuery();
    const step = ctx.session.step;
    if (step.kind !== "confirm_doc_tasks" || !ctx.employee || !ctx.viewer) return;
    const { plan } = step;
    ctx.session.step = { kind: "idle" };
    const viewer = ctx.viewer;

    const files = plan.sendFile ? ctx.session.pendingFiles : undefined;
    ctx.session.pendingFiles = undefined;

    const done: string[] = [];
    const refused: string[] = [];
    for (const t of plan.tasks) {
      if (!t.assigneeId) continue;
      // The write rule, at the write. The CEO passes always; anyone else reaching this
      // callback with a crafted session does not.
      if (!(await canAssignTo(viewer, t.assigneeId))) {
        refused.push(`• ${t.title} → ${t.assigneeName} (not yours to assign)`);
        continue;
      }
      const res = await assignTask({
        assignedBy: ctx.employee.id,
        assignedTo: t.assigneeId,
        title: t.title,
        note: t.detail,
        // The file rides along only on the first task, so one document does not arrive
        // six times.
        attachments: done.length === 0 ? files : undefined,
      });
      done.push(`• ${t.title} → ${t.assigneeName}${res.delivered ? "" : " _(queued)_"}`);
    }

    // Say what was NOT created as plainly as what was. A silent skip is how somebody ends
    // up believing a job was handed out when it never was.
    const skipped = plan.tasks.filter((t) => !t.assigneeId);
    if (refused.length > 0) await ctx.reply(`Not assigned:\n${refused.join("\n")}`);
    await ctx.reply(
      `✅ Created ${done.length} task(s) from *${plan.fileName}*:\n\n${done.join("\n")}\n\n` +
        (skipped.length
          ? `⚠️ *Not created — still nobody assigned:*\n` +
            skipped.map((t) => `• ${t.title}`).join("\n") +
            `\n\nSend the file again, or tell me who should do them.\n\n`
          : "") +
        (plan.sendFile ? "📎 The file was sent with the first one." : "_The file was not forwarded._"),
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("docplan:file", async (ctx) => {
    const step = ctx.session.step;
    if (step.kind !== "confirm_doc_tasks") return void (await ctx.answerCallbackQuery());
    step.plan.sendFile = !step.plan.sendFile;
    ctx.session.step = step;
    await ctx.answerCallbackQuery(step.plan.sendFile ? "File will be sent" : "File will not be sent");
    await ctx.editMessageReplyMarkup({
      reply_markup: docPlanKeyboard(step.plan),
    });
  });

  // Naming an owner for the tasks the document did not name. The alternative — leaving
  // them unassignable — would make one unrecognised name block the whole document.
  bot.callbackQuery("docplan:who", async (ctx) => {
    await ctx.answerCallbackQuery();
    const step = ctx.session.step;
    if (step.kind !== "confirm_doc_tasks") return;
    const orphan = step.plan.tasks.filter((t) => !t.assigneeId);
    const people = (await listEmployees()).filter((p) => p.id !== ctx.employee?.id);
    const kb = new InlineKeyboard();
    for (const p of people.slice(0, 10)) {
      kb.text(p.display_name.slice(0, 40), `docwho:${p.id}`).row();
    }
    await ctx.reply(
      `Who should do these ${orphan.length}?\n\n` + orphan.map((t) => `• ${t.title}`).join("\n"),
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^docwho:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const step = ctx.session.step;
    if (step.kind !== "confirm_doc_tasks") return;
    const id = ctx.match![1]!;
    const person = (await listEmployees()).find((p) => p.id === id);
    if (!person) return void (await ctx.reply("I do not recognise that person any more."));

    for (const t of step.plan.tasks) {
      if (!t.assigneeId) {
        t.assigneeId = person.id;
        t.assigneeName = person.display_name;
      }
    }
    ctx.session.step = step;
    await ctx.reply(
      `👤 The rest go to *${person.display_name}*. ${step.plan.tasks.length} task(s) ready.`,
      { parse_mode: "Markdown", reply_markup: docPlanKeyboard(step.plan) },
    );
  });

  bot.callbackQuery("docplan:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.step = { kind: "idle" };
    ctx.session.pendingFiles = undefined;
    await ctx.reply("❌ Dropped it. Nothing was created and nobody was messaged.");
  });

  // Resolving "did you mean the question I asked, or this new thing?".
  bot.callbackQuery("amb:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    const step = ctx.session.step;
    if (step.kind !== "ambiguous") return;
    ctx.session.step = { kind: "idle" };
    await issueInvite(ctx, step.text);
  });

  bot.callbackQuery("amb:proceed", async (ctx) => {
    await ctx.answerCallbackQuery();
    const step = ctx.session.step;
    if (step.kind !== "ambiguous") return;
    ctx.session.step = { kind: "idle" };
    await ctx.reply("👍 Dropping the invite. Handling your message instead…");
    await routeFreeText(ctx, step.text);
  });

  // Employee picking which of their tasks a report belongs to.
  bot.callbackQuery(/^whichtask:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const step = ctx.session.step;
    if (step.kind !== "which_task" || !ctx.employee) return;
    ctx.session.step = { kind: "idle" };
    const taskId = ctx.match![1]!;
    const rows = await getServiceSql()<{ title: string }[]>`
      select title from task where id = ${taskId}`;
    const rec = await recordTaskUpdate({
      taskId,
      employeeId: ctx.employee.id,
      status: "pending",
      telegramMessageId: ctx.callbackQuery.message?.message_id ?? null,
    });
    await processNote(ctx, rec.taskUpdateId, rec.correlationId, step.text, rows[0]?.title);
  });

  bot.callbackQuery("whichtask:none", async (ctx) => {
    await ctx.answerCallbackQuery();
    const step = ctx.session.step;
    if (step.kind !== "which_task" || !ctx.employee) return;
    ctx.session.step = { kind: "idle" };
    const rec = await recordTaskUpdate({
      employeeId: ctx.employee.id,
      status: "pending",
      telegramMessageId: ctx.callbackQuery.message?.message_id ?? null,
    });
    await processNote(ctx, rec.taskUpdateId, rec.correlationId, step.text);
  });

  // ── Voice notes ───────────────────────────────────────────────────────────
  // The most important affordance for a worker who struggles to write: speak the
  // problem. Transcribed speech is fed into exactly the same pipeline as typed
  // text, so both channels behave identically.
  bot.on("message:voice", async (ctx) => {
    if (!ctx.employee) {
      return void (await ctx.reply("Please register first — send /start."));
    }
    const voice = ctx.message.voice;
    await ctx.reply("🎤 Got your voice note, listening…");

    const step = ctx.session.step;
    const correlationId = step.kind === "blocker_note" ? step.correlationId : undefined;

    // Write-first: record that they spoke BEFORE attempting transcription, so a
    // failure can never erase the fact that a report was made.
    const assetId = await saveVoiceAsset({
      employeeId: ctx.employee.id,
      fileId: voice.file_id,
      correlationId,
    });

    try {
      const file = await ctx.api.getFile(voice.file_id);
      const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      const audio = new Uint8Array(await res.arrayBuffer());

      const t = await transcribeAudio(audio, "voice.ogg", {
        languageHint: ctx.employee.language ?? undefined,
        correlationId,
      });
      if (!t.text) throw new Error("empty transcript");

      await markVoiceTranscribed(assetId, t.text, correlationId);
      await ctx.reply(`I heard: “${t.text}”`);
      await handleText(ctx, t.text);
    } catch (err) {
      await markVoiceFailed(assetId, err instanceof Error ? err.message : String(err), correlationId);
      await ctx.reply(
        "Sorry, I could not hear that clearly. Please send it again, or type it instead.\n" +
          "_Your message was still recorded._",
        { parse_mode: "Markdown" },
      );
    }
  });

  // ── Documents and photos ──────────────────────────────────────────────────
  // An instruction is often "do this" plus a spec sheet, and a report is often a photo
  // of the fault. Telegram sends the file and the words as separate updates, so the
  // file is held on the session and picked up by whichever message explains it.
  bot.on(["message:document", "message:photo"], async (ctx) => {
    if (!ctx.employee) {
      return void (await ctx.reply("Please register first — send /start."));
    }
    const doc = ctx.message.document;
    const photos = ctx.message.photo;
    // Telegram sends a photo at several resolutions; the last is the largest.
    const largest = photos?.[photos.length - 1];

    const file: IncomingFile | null = doc
      ? {
          fileId: doc.file_id,
          fileUniqueId: doc.file_unique_id,
          fileName: doc.file_name ?? null,
          mimeType: doc.mime_type ?? null,
          fileSize: doc.file_size ?? null,
          kind: "document",
          caption: ctx.message.caption ?? null,
        }
      : largest
        ? {
            fileId: largest.file_id,
            fileUniqueId: largest.file_unique_id,
            fileName: null,
            mimeType: "image/jpeg",
            fileSize: largest.file_size ?? null,
            kind: "photo",
            caption: ctx.message.caption ?? null,
          }
        : null;
    if (!file) return;

    const held = ctx.session.pendingFiles ?? [];
    if (held.length >= MAX_ATTACHMENTS) {
      await ctx.reply(`I can only hold ${MAX_ATTACHMENTS} files at a time. Send the instruction first.`);
      return;
    }
    // Re-sending the same file (a stalled upload retried by hand, say) must not stack up
    // duplicates — on 2026-09-08 that delivered the same PDF to the employee twice.
    //
    // file_unique_id is NOT enough: a re-upload of identical bytes gets a fresh one, as
    // the two held copies of 1.pdf in that session proved. Name plus exact byte size is
    // what actually identifies "you sent me this again".
    const already = held.some(
      (f) =>
        (file.fileUniqueId != null && f.fileUniqueId === file.fileUniqueId) ||
        f.fileId === file.fileId ||
        (f.fileName != null &&
          f.fileName === file.fileName &&
          f.fileSize != null &&
          f.fileSize === file.fileSize),
    );
    if (already) {
      await ctx.reply(`📎 I already have ${describeAttachment(file)} — not adding it twice.`);
      return;
    }
    held.push(file);
    ctx.session.pendingFiles = held;

    const caption = ctx.message.caption?.trim();
    if (caption) {
      // The caption IS the instruction — act on it now, with the file attached.
      await handleText(ctx, caption);
      return;
    }
    // With no caption we still must not make the CEO guess the magic words — offer the
    // action directly. Not guessing the words was the whole failure of 2026-09-08.
    if (ctx.role === "ceo" && hasReadableDoc([file])) {
      await ctx.reply(
        `📎 Got ${describeAttachment(file)}.\n\nShall I read it and turn the work inside into tasks?`,
        {
          reply_markup: new InlineKeyboard()
            .text("📄 Read it and assign the tasks", "doc:read")
            .row()
            .text("↪ No — I will say what it is for", "doc:wait"),
        },
      );
      return;
    }
    await ctx.reply(
      `📎 Got ${describeAttachment(file)}.\n` +
        (ctx.role === "ceo"
          ? "Now tell me what it is for — for example: _send this to Rashid, fix van 2 chiller_."
          : "Now tell me what it is about, and I will file it with your report."),
      { parse_mode: "Markdown" },
    );
  });

  // ── Free text: routed by whatever step the conversation is in ─────────────
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    await handleText(ctx, text);
  });

  return bot;
}

/**
 * All free-text handling. Shared by typed messages and (from T16) by the text a
 * voice note was transcribed into, so both channels behave identically.
 */
export async function handleText(ctx: FreshCtx, text: string): Promise<void> {
  const step = ctx.session.step;

  // A question we gave up waiting on is said out loud, not dropped silently — otherwise
  // the person's next message is answered in a context they no longer remember being in.
  if (ctx.expiredStep && ctx.expiredStep !== "idle") {
    const what: Record<string, string> = {
      invite_name: "creating an invite code",
      assign_title: "assigning a task",
      assign_pending: "assigning a task",
      new_task: "adding a task",
      which_task: "picking which task your update was about",
      confirm_doc_tasks: "confirming tasks from a document",
    };
    const label = what[ctx.expiredStep];
    if (label) {
      await ctx.reply(`_(You were ${label} a while ago — I have let that go.)_`, {
        parse_mode: "Markdown",
      });
    }
  }

  switch (step.kind) {
    case "awaiting_code": {
      const check = await validateInvite(text);
      if (!check.valid) {
        const why =
          check.reason === "expired"
            ? "that code has expired"
            : check.reason === "already_used"
              ? "that code has already been used"
              : "I do not recognise that code";
        await ctx.reply(`Sorry — ${why}. Please ask the CEO for a new one.`);
        return;
      }
      ctx.session.step = { kind: "awaiting_consent", code: text };
      await ctx.reply(consentNotice("en"), {
        reply_markup: new InlineKeyboard()
          .text("✅ I agree", "consent:agree")
          .row()
          .text("✖ No thanks", "consent:decline"),
      });
      return;
    }

    case "profile": {
      const field = PROFILE_STEPS[step.index] as ProfileStep | undefined;
      if (!field) {
        ctx.session.step = { kind: "idle" };
        return;
      }
      await updateProfileField(step.employeeId, field, text);
      const nextIndex = step.index + 1;
      const next = PROFILE_STEPS[nextIndex];
      if (next) {
        ctx.session.step = { ...step, index: nextIndex };
        await ctx.reply(profilePrompt(next));
        return;
      }
      ctx.session.step = { kind: "idle" };
      await ctx.reply("Last one — which language do you prefer?", {
        reply_markup: new InlineKeyboard()
          .text("English", "lang:en")
          .text("हिंदी", "lang:hi")
          .text("മലയാളം", "lang:ml"),
      });
      return;
    }

    case "blocker_note": {
      ctx.session.step = { kind: "idle" };
      await processNote(ctx, step.taskUpdateId, step.correlationId, text);
      return;
    }

    case "task_note": {
      // Detail for a Done/Pending task. Same pipeline — if what they wrote turns out to
      // describe a problem, it still becomes a blocker and still reaches the CEO.
      ctx.session.step = { kind: "idle" };
      await processNote(ctx, step.taskUpdateId, step.correlationId, text, step.taskTitle);
      return;
    }

    case "new_task": {
      if (!ctx.employee) return;
      await createTask(ctx.employee.id, text);
      ctx.session.step = { kind: "idle" };
      await ctx.reply("➕ Task added.", {
        reply_markup: new InlineKeyboard().text("📋 Log daily tasks", "menu:log"),
      });
      return;
    }

    case "invite_name": {
      // A person's name is short, has no verb, and never arrives attached to a document.
      // When the answer plainly is not a name, ASK which the person meant instead of
      // stamping it onto an invite code — the failure this prevents produced a code
      // called "Assign the tasks to hemanth based on the attached pdf document."
      if (!looksLikeName(text) || ctx.session.pendingFiles?.length) {
        const kb = new InlineKeyboard()
          .text("🔑 Use it as the name", "amb:invite")
          .row()
          .text("↪ No — do this instead", "amb:proceed");
        await ctx.reply(
          `You asked me for an invite code earlier and I was waiting for a name.\n\n` +
            `"${text.slice(0, 80)}" does not look like one — did you mean to do something else?`,
          { reply_markup: kb },
        );
        ctx.session.step = { kind: "ambiguous", text, pending: "invite_name" };
        return;
      }
      ctx.session.step = { kind: "idle" };
      await issueInvite(ctx, text);
      return;
    }

    case "assign_pending": {
      // They typed a name instead of tapping a button — resolve it against the people
      // THIS person may assign to, so a manager typing a stranger's name gets "I don't
      // recognise that name" and the directory, never a task on a stranger's list.
      const people = ctx.viewer ? await listAssignable(ctx.viewer) : [];
      const needle = text.trim().toLowerCase();

      // Assigning work to the WRONG person is worse than asking again, so a name must be
      // unambiguous before it is acted on. First-substring-match would send the job to
      // whoever sorted first: with a "Sara" and a "Sarah" on the books, or a two-letter
      // typo matching three people, the CEO would never learn it went astray.
      const matches =
        needle.length >= 2
          ? people.filter((p) => p.display_name.toLowerCase().includes(needle))
          : [];
      const exact = matches.find((p) => p.display_name.toLowerCase() === needle);
      const match = exact ?? (matches.length === 1 ? matches[0] : undefined);

      if (!match) {
        await ctx.reply(
          matches.length > 1
            ? `"${text.trim()}" matches ${matches.length} people — ${matches
                .map((p) => p.display_name)
                .join(", ")}. Tap the one you mean:`
            : "I don't recognise that name. Tap one of these instead:",
        );
        await showDirectory(ctx);
        return;
      }
      ctx.session.step = { kind: "idle" };
      if (!ctx.employee) return;
      const res = await assignTask({
        assignedBy: ctx.employee.id,
        assignedTo: match.id,
        title: step.title,
        attachments: ctx.session.pendingFiles,
      });
      ctx.session.pendingFiles = undefined;
      await ctx.reply(
        `📌 Assigned to ${match.display_name}: "${step.title}"\n` +
          (res.attachments ? `📎 ${res.attachments} file(s) sent with it.\n` : "") +
          (res.delivered ? "They have been notified." : "They are not on Telegram yet, so it is queued."),
      );
      return;
    }

    case "eod_addendum": {
      ctx.session.step = { kind: "idle" };
      if (!ctx.employee) return;
      await ctx.reply("📊 Writing it up…");
      const mine = await generateEodReport(ctx.employee.id, undefined, text);
      await ctx.reply(formatEodReport(mine), { parse_mode: "Markdown" });
      return;
    }

    case "confirm_doc_tasks": {
      // They typed instead of tapping. The plan is a proposal, not a commitment — drop
      // it and handle what they actually said, rather than leaving them stuck behind it.
      //
      // The held file MUST be released here too: routeFreeText re-plans whenever a
      // readable document is pending, so keeping it would send the next message straight
      // back into the same plan, forever.
      ctx.session.step = { kind: "idle" };
      ctx.session.pendingFiles = undefined;
      await ctx.reply("Dropping that document plan — nothing was created.");
      await routeFreeText(ctx, text);
      return;
    }

    case "ambiguous": {
      // They answered the "which did you mean?" question in words. Take the new message
      // as the intent and let the held text go.
      ctx.session.step = { kind: "idle" };
      await routeFreeText(ctx, text);
      return;
    }

    case "which_task": {
      // They typed rather than tapping; treat the new text as the report itself.
      ctx.session.step = { kind: "idle" };
      if (!ctx.employee) return;

      // They typed instead of tapping. The question was "which task is this about?", so
      // what they typed is most likely the ANSWER — a task name — not a new report.
      //
      // The old code filed `step.text` and threw `text` away entirely, so whatever they
      // just typed vanished without a word. Try to match it against their open tasks;
      // either way the original words are what gets filed, because those are the report.
      const open = await listOpenTasks(ctx.employee.id);
      const needle = text.trim().toLowerCase();
      const named =
        needle.length >= 3 ? open.find((t) => t.title.toLowerCase().includes(needle)) : undefined;

      const rec = await recordTaskUpdate({
        taskId: named?.id ?? null,
        employeeId: ctx.employee.id,
        status: "pending",
        telegramMessageId: ctx.message?.message_id ?? null,
      });
      if (named) await ctx.reply(`📎 Filing it under "${named.title}".`);
      await processNote(ctx, rec.taskUpdateId, rec.correlationId, step.text, named?.title);
      return;
    }

    case "assign_title": {
      ctx.session.step = { kind: "idle" };
      if (!ctx.employee || !ctx.viewer) return;
      // The reporting line may have changed between the tap and the title being typed.
      if (!(await canAssignTo(ctx.viewer, step.toEmployeeId))) {
        await ctx.reply(`${step.toName} no longer reports to you, so nothing was assigned.`);
        return;
      }
      const res = await assignTask({
        assignedBy: ctx.employee.id,
        assignedTo: step.toEmployeeId,
        title: text,
        attachments: ctx.session.pendingFiles,
      });
      ctx.session.pendingFiles = undefined;
      await ctx.reply(
        `📌 Assigned to ${step.toName}.\n` +
          (res.attachments ? `📎 ${res.attachments} file(s) sent with it.\n` : "") +
          (res.delivered
            ? "They have been notified in Telegram."
            : "They are not on Telegram yet, so it is queued."),
      );
      return;
    }

    default: {
      if (!ctx.employee) {
        await ctx.reply("Send /start to see your menu, or /help for instructions.");
        return;
      }
      await routeFreeText(ctx, text);
    }
  }
}

/**
 * Show today's tasks with a status button on each — the core daily-capture screen.
 *
 * Shared by the menu button and by /log, /status and /mytasks, so there is exactly one
 * implementation and the command cannot drift from the button.
 */
async function showLogBoard(ctx: FreshCtx): Promise<void> {
  if (!ctx.employee) {
    return void (await ctx.reply("Please enter an invite code first — send /start."));
  }
  const tasks = await listOpenTasks(ctx.employee.id);
  if (tasks.length === 0) {
    return void (await ctx.reply(
      "You have no open tasks yet.\n\nYou can also just tell me what you did or what is " +
        "stuck — type it or send a voice note, and I will file it.",
      { reply_markup: new InlineKeyboard().text("➕ Add a task", "menu:addtask") },
    ));
  }
  await ctx.reply(`You have ${tasks.length} task(s). Tap a status for each:`);
  for (const t of tasks) {
    const kb = new InlineKeyboard()
      .text("✅ Done", `log:${t.id}:done`)
      .text("⏳ Pending", `log:${t.id}:pending`)
      .text("🚫 Blocker", `log:${t.id}:blocker`);
    await ctx.reply(`• ${t.title}`, { reply_markup: kb });
  }
}

/** Formats we can actually read. A photo has no text layer, so it is not one. */
const READABLE_MIME = /^(application\/pdf|text\/|application\/json)/;

function hasReadableDoc(files: readonly IncomingFile[] | undefined): boolean {
  return (files ?? []).some(
    (f) =>
      f.kind === "document" &&
      (READABLE_MIME.test(f.mimeType ?? "") || /\.(pdf|txt|md|csv|json)$/i.test(f.fileName ?? "")),
  );
}

/**
 * Read the attached document, work out the separate jobs in it and who each is for, and
 * show the CEO a proposal to confirm.
 *
 * Nothing is written until they tap. A misread document that silently became six
 * people's Monday would be far worse than one extra tap, and CLAUDE.md is explicit that
 * nothing goes out on the CEO's behalf without an explicit human action.
 */
async function planFromDocument(ctx: FreshCtx, instruction: string): Promise<void> {
  const employee = ctx.employee;
  if (!employee) return;
  // Only the button is shown to the CEO, but `doc:read` is callback data anyone can send.
  // Reading a document into tasks assigns to whoever it names, so the role is checked
  // here — at the function — not only at the button.
  if (ctx.role !== "ceo") {
    await ctx.reply("Only the CEO can turn a document into tasks. Your file is held — tell me what it is for.");
    return;
  }
  const file = (ctx.session.pendingFiles ?? []).find(
    (f) =>
      f.kind === "document" &&
      (READABLE_MIME.test(f.mimeType ?? "") || /\.(pdf|txt|md|csv|json)$/i.test(f.fileName ?? "")),
  );
  if (!file) return;

  // Cap the expensive path before spending a download, a parse and a model call on it.
  const rl = await checkRateLimit({ key: "document", employeeId: employee.id });
  if (!rl.allowed) {
    await ctx.reply(rl.message);
    return;
  }

  await ctx.reply(`📄 Reading ${safeFileName(file.fileName)}…`);

  let doc: ExtractedDocument;
  let safety: SafetyReport;
  try {
    // Document work is the heaviest path in the system — a download, a PDF parse and a
    // large prompt. It gets its own narrow semaphore so two people sending PDFs at once
    // cannot starve everyone else's ordinary status messages. Declared but never applied
    // until now, which meant /health advertised a bound nothing enforced.
    const bytes = await documentSemaphore.run(() => downloadTelegramFile(ctx, file.fileId));

    // The safety gate runs on the BYTES, before any parser touches them. The declared
    // MIME type and the extension both come from the sender and are trivially wrong.
    safety = await inspectFile({
      bytes,
      declaredName: file.fileName,
      declaredMime: file.mimeType,
      uploadedBy: employee.id,
    });

    if (!safety.mayRead) {
      ctx.session.pendingFiles = undefined;
      await ctx.reply(explainVerdict(safety, file.fileName ?? "that file"), {
        parse_mode: "Markdown",
      });
      return;
    }
    if (safety.verdict === "suspicious") {
      // Readable but never forwardable — extracting text runs nothing here, while passing
      // the file on would hand active content to a viewer that obeys it.
      await ctx.reply(explainVerdict(safety, file.fileName ?? "that file"), {
        parse_mode: "Markdown",
      });
    }

    // Parsing is the CPU-heavy half, so it runs inside the same narrow limit.
    doc = await documentSemaphore.run(async () =>
      (file.mimeType ?? "").includes("pdf") || /\.pdf$/i.test(file.fileName ?? "")
        ? extractPdfText(bytes)
        : decodeTextFile(bytes),
    );
  } catch (err) {
    // Telegram's file endpoint is the flakiest hop in this system — it returned
    // Gateway Timeout and ECONNRESET repeatedly on 2026-09-08. Say so plainly and keep
    // the file held, so retrying is one message rather than a re-upload.
    await ctx.reply(
      "I could not download that file from Telegram just now — the connection failed.\n" +
        "Your file is still held. Send the instruction again in a moment to retry.",
    );
    await logAudit({
      actor: `employee:${employee.id}`,
      action: "document.download_failed",
      entity: "employee",
      entityId: employee.id,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  if (!doc.text.trim()) {
    // A scanned page has no text layer. That is a "needs a human" answer, not an error,
    // and it must never look like "the document contained no work".
    await ctx.reply(
      "I could not find any text in that document — it may be a scan or an image.\n" +
        "Tell me the tasks here and I will assign them, or send a text/PDF with real text.",
    );
    return;
  }

  const colleagues = (await listEmployees()).filter((p) => p.id !== employee.id);
  let plan: DocumentPlan;
  try {
    plan = await planDocumentTasks({
      text: doc.text,
      colleagues: colleagues.map((c) => ({
        id: c.id,
        display_name: c.display_name,
        department: c.department,
      })),
      instruction,
      // Required for the rate limit to count this read against the person who made it.
      uploadedBy: employee.id,
    });
  } catch {
    await ctx.reply("I could not read that document reliably. Tell me the tasks here instead.");
    return;
  }

  if (plan.tasks.length === 0) {
    await ctx.reply("I read the document but found no tasks in it. Tell me what to assign.");
    return;
  }

  // The CEO is told what was in their document before being asked to act on it.
  const warning = explainInjection(plan.injection);
  if (warning) await ctx.reply(warning);

  const held: PlanForConfirm = {
    fileName: safeFileName(file.fileName),
    sendFile: false,
    // A flagged file is never offered for forwarding, so the "also send it" button
    // cannot turn this system into the delivery mechanism for active content.
    mayForward: safety.mayForward,
    tasks: plan.tasks.map((t) => ({
      title: t.title,
      detail: t.detail,
      assigneeId: t.assignee?.id ?? null,
      assigneeName: t.assignee?.display_name ?? null,
    })),
  };
  ctx.session.step = { kind: "confirm_doc_tasks", plan: held };

  await ctx.reply(formatDocumentPlan(plan, held.fileName), {
    parse_mode: "Markdown",
    reply_markup: docPlanKeyboard(held),
  });
}

/**
 * Buttons for a plan. An unowned task must never silently block the whole plan — hiding
 * the create button with no alternative would leave the CEO staring at a list they cannot
 * act on, which is its own failure. So the owned tasks stay creatable and the unowned
 * ones get an explicit "say who" path.
 */
function docPlanKeyboard(plan: PlanForConfirm): InlineKeyboard {
  const owned = plan.tasks.filter((t) => t.assigneeId).length;
  const orphan = plan.tasks.length - owned;
  const kb = new InlineKeyboard();

  if (owned > 0) {
    kb.text(
      orphan > 0 ? `✅ Create the ${owned} with owners` : "✅ Create these tasks",
      "docplan:go",
    ).row();
  }
  if (orphan > 0) {
    kb.text(`👤 Say who does the other ${orphan}`, "docplan:who").row();
  }
  // The forward option is simply absent for a flagged file. An option that exists and
  // then refuses invites retrying; one that is not there states the boundary.
  if (plan.mayForward) {
    kb.text(
      plan.sendFile ? "📎 File WILL be sent — tap to stop" : "📄 Also send the file",
      "docplan:file",
    ).row();
  }
  kb.text("❌ Cancel", "docplan:cancel");
  return kb;
}

/** Fetch a Telegram file, with bounded retries — this hop fails transiently. */
async function downloadTelegramFile(ctx: FreshCtx, fileId: string): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const f = await ctx.api.getFile(fileId);
      const res = await fetch(`https://api.telegram.org/file/bot${ctx.api.token}/${f.file_path}`);
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Move any files the person sent just before this message onto the record it produced,
 * and clear the hold. A photo of a leaking chiller is evidence on that report — held
 * only until we know what it belongs to, never left dangling on the session.
 */
async function takePendingFiles(
  ctx: FreshCtx,
  target: { taskUpdateId?: string | null; taskId?: string | null },
): Promise<number> {
  const files = ctx.session.pendingFiles;
  if (!files?.length || !ctx.employee) return 0;
  ctx.session.pendingFiles = undefined;
  const saved = await saveAttachments({
    files,
    uploadedBy: ctx.employee.id,
    taskUpdateId: target.taskUpdateId ?? null,
    taskId: target.taskId ?? null,
  });
  if (saved.length) {
    await ctx.reply(`📎 Attached ${saved.length} file(s) to this report.`);
  }
  return saved.length;
}

/**
 * Decide what a free-text message means, IN CONTEXT, then act.
 *
 * Pipeline: retrieve this person's real world (open tasks, what they recently said,
 * their blockers, their colleagues) -> let the model resolve the references against
 * that slice -> validate every id it returns -> take a fixed action.
 *
 * The model never invents a task or a person: it picks from lists we supplied, and
 * anything out of range is dropped. So "the chiller one is sorted now" can attach to
 * the right existing task, and "ask Rashid to check van 2" can become a real
 * assignment, without either being guessable from the words alone.
 */
async function routeFreeText(ctx: FreshCtx, text: string): Promise<void> {
  const employee = ctx.employee;
  if (!employee) return;

  // A clear question needs no model call at all.
  if (isObviousQuestion(text)) {
    await answerForRole(ctx, text);
    return;
  }

  // A work document attached by the CEO IS the object of whatever they just said, so
  // reading it must not depend on a model classifying a terse caption. It did, and it
  // failed in exactly the way you would expect: "analyse and assign the task
  // accordingly" carries no object and no name, so the resolver returned `smalltalk`
  // and the PDF was never opened (gotcha G34).
  //
  // The presence of the document is the signal, and it is a fact, not a judgement —
  // so this is a deterministic branch taken before any model call.
  if (ctx.role === "ceo" && hasReadableDoc(ctx.session.pendingFiles)) {
    await planFromDocument(ctx, text);
    return;
  }

  let r: ResolvedMessage | null = null;
  try {
    const mctx = await loadMessageContext(employee.id);
    r = await resolveMessage(text, mctx);
  } catch {
    r = null; // provider unavailable — fall through to the safe default
  }

  await logAudit({
    actor: `employee:${employee.id}`,
    action: "message.resolved",
    entity: "employee",
    entityId: employee.id,
    detail: r
      ? {
          intent: r.intent,
          timeframe: r.timeframe,
          task: r.task?.title ?? null,
          assignee: r.assignee?.display_name ?? null,
          reason: r.reason,
        }
      : { intent: "unresolved", reason: "resolver unavailable" },
  });

  // Safe default when the resolver is down: store it as a report. Their words are kept
  // and a real problem still escalates.
  if (!r) {
    const rec = await recordTaskUpdate({
      employeeId: employee.id,
      status: "pending",
      telegramMessageId: ctx.message?.message_id ?? null,
    });
    await processNote(ctx, rec.taskUpdateId, rec.correlationId, text);
    return;
  }

  switch (r.intent) {
    case "question":
      await answerForRole(ctx, text);
      return;

    case "assignment": {
      // Assignment straight from plain text — no slash command needed. One message may
      // name several people and several jobs, so each item is assigned on its own.
      // The resolver was given every colleague as a candidate, so for a manager each
      // named person is checked against the write rule; the ones outside their team are
      // reported back by name, not silently dropped and not silently assigned.
      if (ctx.role !== "employee" && ctx.viewer) {
        const named = r.items.filter((i) => i.assignee);
        const refused: string[] = [];
        const allowed: typeof named = [];
        for (const item of named) {
          if (await canAssignTo(ctx.viewer, item.assignee!.id)) allowed.push(item);
          else refused.push(item.assignee!.display_name);
        }
        if (refused.length > 0) {
          await ctx.reply(`${refused.join(", ")} ${refused.length === 1 ? "does" : "do"} not report to you, so I did not assign anything to them.`);
        }
        if (allowed.length > 0) {
          const lines: string[] = [];
          // Take the files ONCE. Passing them inside the loop attached and delivered the
          // same photo on every item, so "tell Rashid X and Priya Y" sent the picture
          // twice — the docplan path already guards against exactly this.
          const files = ctx.session.pendingFiles;
          ctx.session.pendingFiles = undefined;
          for (const item of allowed) {
            const title = (item.newTaskTitle ?? text).slice(0, 160);
            const res = await assignTask({
              assignedBy: employee.id,
              assignedTo: item.assignee!.id,
              title,
              attachments: lines.length === 0 ? files : undefined,
            });
            lines.push(
              `📌 ${item.assignee!.display_name}: "${title}"` +
                (res.delivered ? "" : " _(queued — not on Telegram yet)_"),
            );
          }
          await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
          return;
        }
        // Nobody named: keep the extracted task and ASK who, instead of losing it.
        const title = (r.newTaskTitle ?? text).slice(0, 160);
        ctx.session.step = { kind: "assign_pending", title };
        await ctx.reply(`Who should do "${title}"?`);
        await showDirectory(ctx);
        return;
      }
      // An employee asking for someone else's help is still a report the CEO should see.
      const rec = await recordTaskUpdate({
        employeeId: employee.id,
        status: "pending",
        telegramMessageId: ctx.message?.message_id ?? null,
      });
      await processNote(ctx, rec.taskUpdateId, rec.correlationId, text);
      return;
    }

    case "new_task": {
      // "I need to service the bottling machine and clean the Marina unit" is two jobs.
      const titles = r.items
        .map((i) => (i.newTaskTitle ?? "").slice(0, 160))
        .filter((t) => t.length > 0);
      if (titles.length === 0) titles.push(text.slice(0, 160));
      for (const t of titles) await createTask(employee.id, t);
      await ctx.reply(
        (titles.length === 1
          ? `➕ Added a task: "${titles[0]}"`
          : `➕ Added ${titles.length} tasks:\n` + titles.map((t) => `• ${t}`).join("\n")) +
          (r.timeframe === "future" ? "\n_Noted as upcoming work._" : ""),
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("📋 Log daily tasks", "menu:log"),
        },
      );
      return;
    }

    case "smalltalk":
      await ctx.reply("👍 Noted. Send /start for your menu, or just tell me what is happening.");
      return;

    case "status_update":
    default: {
      let chosen = r.task;

      // Nothing matched. Rather than filing the words loose, ASK — unless there is only
      // one open task, in which case the answer is obvious.
      if (!chosen && ctx.role !== "ceo") {
        const open = await listOpenTasks(employee.id);
        if (open.length === 1) {
          chosen = { ...open[0]!, created_at: new Date() };
        } else if (open.length > 1) {
          ctx.session.step = { kind: "which_task", text };
          const kb = new InlineKeyboard();
          for (const t of open.slice(0, 8)) kb.text(t.title.slice(0, 45), `whichtask:${t.id}`).row();
          kb.text("↪ Not about a specific task", "whichtask:none");
          await ctx.reply("Which task is this about?", { reply_markup: kb });
          return;
        }
      }

      // When a task is known the words attach to it, never as an orphan update.
      const rec = await recordTaskUpdate({
        taskId: chosen?.id ?? null,
        employeeId: employee.id,
        status: "pending",
        telegramMessageId: ctx.message?.message_id ?? null,
      });
      await takePendingFiles(ctx, { taskUpdateId: rec.taskUpdateId, taskId: chosen?.id ?? null });
      if (chosen) await ctx.reply(`📎 Filing this under "${chosen.title}".`);
      await processNote(ctx, rec.taskUpdateId, rec.correlationId, text, chosen?.title);
    }
  }
}

/** Questions: the CEO gets guarded NL->SQL; an employee gets only their own rows. */
async function answerForRole(ctx: FreshCtx, text: string): Promise<void> {
  const employee = ctx.employee;
  if (!employee) return;

  if (ctx.role === "ceo") {
    await ctx.reply("🔎 Looking that up…");
    try {
      const res = await answerQuestion(text);
      await ctx.reply(res.answer);
      if (res.sql) await ctx.reply(`Query used (${res.rowCount} row(s)):

${res.sql}`);
    } catch {
      await ctx.reply("I could not answer that one. Try rephrasing, or use the dashboard.");
    }
    return;
  }

  // Employees never get free SQL — that path bypasses row-level security.
  const summary = await summariseOwnWork(employee.id);
  await ctx.reply(formatOwnWork(summary), {
    reply_markup: new InlineKeyboard().text("📋 Log daily tasks", "menu:log"),
  });
}

/**
 * Store the employee's words, then parse → route → alert. Acknowledges BEFORE the
 * model is called, because the text is already safely on disk (SPEC-000 R23).
 */
async function processNote(
  ctx: FreshCtx,
  taskUpdateId: string,
  correlationId: string,
  text: string,
  taskTitle?: string,
): Promise<void> {
  await ctx.reply("✅ Saved your words. Checking…");

  // A photo of the fault is usually sent WITH the words describing it, so any held file
  // belongs on this update. Without this the photo stayed on the session and surfaced
  // attached to whatever the person did next — evidence filed against the wrong record.
  await takePendingFiles(ctx, { taskUpdateId });

  const res = await attachNoteAndProcess(taskUpdateId, text, correlationId);

  if (res.needsReview) {
    await ctx.reply(
      "Your message is saved, but I could not understand it automatically.\n" +
        "I have passed it to the CEO to read. Nothing was lost.",
    );
    return;
  }
  if (!res.blockerId) {
    await ctx.reply(
      taskTitle
        ? `👍 Saved against "${taskTitle}". I did not read that as a problem — ` +
          "the CEO can still see exactly what you wrote."
        : "👍 Recorded — I did not read that as a problem, but the CEO can see what you wrote.",
    );
    return;
  }
  await ctx.reply(
    `🚨 Logged a *${res.severity}* ${res.category} problem.\n` +
      (res.summary ? `_${res.summary}_\n` : "") +
      (res.alerted ? "The CEO has been alerted." : "Queued for the CEO."),
    { parse_mode: "Markdown" },
  );
}

async function issueInvite(ctx: FreshCtx, name: string): Promise<void> {
  const invite = await createInvite({
    displayName: name.slice(0, 80),
    issuedBy: ctx.employee?.id ?? DEMO_CEO_ID,
  });
  await ctx.reply(
    `🔑 *Invite code for ${name}*\n\n` +
      `\`${invite.code}\`\n\n` +
      "_Tap the code above to copy it._\n" +
      `Valid until ${invite.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC.\n\n` +
      "Send this code to them. They open the bot, send /start, " +
      'tap "🔑 I have an invite code", and paste it.',
    { parse_mode: "Markdown" },
  );
}

async function showBlockers(ctx: FreshCtx): Promise<void> {
  if (!ctx.viewer) return void (await ctx.reply("Please register first — send /start."));
  // The CEO's whole queue, or a manager's team — decided by the same RLS policy the
  // dashboard reads under, so the two can never show different lists.
  const blockers = await listOpenBlockersFor(ctx.viewer);
  if (blockers.length === 0) {
    return void (await ctx.reply(ctx.role === "ceo" ? "No open blockers. 🎉" : "No open blockers in your team. 🎉"));
  }
  await ctx.reply(`${blockers.length} open blocker(s)${ctx.role === "ceo" ? "" : " in your team"}:`);
  for (const b of blockers) {
    await ctx.reply(
      `⚠️ *${b.severity}* · ${b.category}\n` +
        (b.summary ? `${b.summary}\n` : "") +
        `Raised by ${b.raised_by_name}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✅ Acknowledge", `ack:${b.id}`),
      },
    );
  }
}

async function showDirectory(ctx: FreshCtx): Promise<void> {
  if (!ctx.viewer) return void (await ctx.reply("Please register first — send /start."));
  const people = await listAssignable(ctx.viewer);
  if (people.length === 0) {
    return void (await ctx.reply(
      ctx.role === "ceo"
        ? "Nobody to assign to yet — create an invite first."
        : "Nobody reports to you yet. The CEO sets reporting lines on the dashboard's People tab.",
    ));
  }
  const kb = new InlineKeyboard();
  for (const p of people) {
    kb.text(`${p.display_name}${p.linked ? "" : " (not on Telegram)"}`, `assignto:${p.id}`).row();
  }
  await ctx.reply("Who should do the task?", { reply_markup: kb });
}
