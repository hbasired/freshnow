import { logAudit } from "./audit.js";
import { loadConfig } from "./config.js";
import { getServiceSql } from "./db.js";

/**
 * Speech-to-text for Telegram voice notes.
 *
 * Uses Groq-hosted `whisper-large-v3` rather than a local faster-whisper install
 * (a documented change from the original plan): no Python dependency, the same API
 * key, and the FULL large-v3 model — materially better on Hindi and Malayalam than
 * the local `small` model the plan assumed. Telegram sends OGG/Opus, which the
 * transcription endpoint accepts directly, so no ffmpeg transcode is needed.
 *
 * Ordering rule: the voice_asset row is written BEFORE transcription is attempted,
 * so a failed or slow transcription can never lose the fact that the employee spoke.
 */

export interface Transcription {
  text: string;
  language?: string;
}

/** Register that a voice note arrived. Called BEFORE any transcription. */
export async function saveVoiceAsset(p: {
  employeeId: string;
  fileId: string;
  correlationId?: string;
  isSynthetic?: boolean;
}): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into voice_asset (employee_id, file_id, status, is_synthetic)
    values (${p.employeeId}, ${p.fileId}, 'pending', ${p.isSynthetic ?? false})
    returning id`;
  const id = rows[0]!.id;
  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.employeeId}`,
    action: "voice.received",
    entity: "voice_asset",
    entityId: id,
  });
  return id;
}

export async function markVoiceTranscribed(
  voiceAssetId: string,
  text: string,
  correlationId?: string,
): Promise<void> {
  const sql = getServiceSql();
  await sql`update voice_asset
            set transcript_raw = ${text}, status = 'transcribed'
            where id = ${voiceAssetId}`;
  await logAudit({
    correlationId,
    actor: "system",
    action: "voice.transcribed",
    entity: "voice_asset",
    entityId: voiceAssetId,
    detail: { chars: text.length },
  });
}

export async function markVoiceFailed(
  voiceAssetId: string,
  error: string,
  correlationId?: string,
): Promise<void> {
  const sql = getServiceSql();
  await sql`update voice_asset set status = 'failed' where id = ${voiceAssetId}`;
  await logAudit({
    correlationId,
    actor: "system",
    action: "voice.failed",
    entity: "voice_asset",
    entityId: voiceAssetId,
    detail: { error: error.slice(0, 300) },
  });
}

/**
 * Transcribe audio bytes. `languageHint` ("en" | "hi" | "ml") improves accuracy
 * noticeably; when omitted Whisper auto-detects, which is the right default for a
 * workforce that mixes languages inside one sentence.
 */
export async function transcribeAudio(
  audio: Uint8Array,
  filename: string,
  opts: { languageHint?: string; correlationId?: string; timeoutMs?: number } = {},
): Promise<Transcription> {
  const c = loadConfig();
  if (!c.GROQ_API_KEY) throw new Error("GROQ_API_KEY is required for voice transcription");

  const model = process.env.WHISPER_MODEL_ID ?? "whisper-large-v3";
  const form = new FormData();
  // Copy into a fresh ArrayBuffer so the Blob is not tied to a pooled Node buffer.
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append("file", new Blob([bytes]), filename);
  form.append("model", model);
  form.append("response_format", "json");
  // Only pin the language when we are confident; a wrong pin is worse than auto-detect.
  if (opts.languageHint && ["en", "hi", "ml"].includes(opts.languageHint)) {
    form.append("language", opts.languageHint);
  }

  const ctrl = new AbortController();
  // Audio is slower than chat completion, so this gets its own, larger budget.
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45_000);
  const started = Date.now();
  try {
    const res = await fetch(`${c.GROQ_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.GROQ_API_KEY}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`transcription HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { text?: string; language?: string };
    const latency = Date.now() - started;

    const sql = getServiceSql();
    await sql`
      insert into llm_call (correlation_id, provider, model, prompt_tokens,
                            completion_tokens, cost_usd, latency_ms, success)
      values (${opts.correlationId ?? null}, 'groq', ${model}, 0, 0, 0, ${latency}, true)`;

    return { text: (data.text ?? "").trim(), language: data.language };
  } finally {
    clearTimeout(timer);
  }
}
