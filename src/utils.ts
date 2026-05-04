/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import OpenAI from "openai";
import { existsSync } from "fs";
import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  OPENAI_API_KEY,
  TRANSCRIPTION_PROMPT,
  TRANSCRIPTION_AVAILABLE,
  WHISPER_SCRIPT_PATH,
} from "./config";

// ============== OpenAI Client ==============

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// ============== Audit Logging ==============

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      // Plain text format for readability
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      content = lines.join("\n") + "\n";
    }

    // Append to audit log file
    const fs = await import("fs/promises");
    await fs.appendFile(AUDIT_LOG_PATH, content);
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await writeAuditLog(event);
}

export async function auditLogAuth(
  userId: number,
  username: string,
  authorized: boolean
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "auth",
    user_id: userId,
    username,
    authorized,
  });
}

export async function auditLogTool(
  userId: number,
  username: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  blocked = false,
  reason = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "tool_use",
    user_id: userId,
    username,
    tool_name: toolName,
    tool_input: toolInput,
    blocked,
  };
  if (blocked && reason) {
    event.reason = reason;
  }
  await writeAuditLog(event);
}

export async function auditLogError(
  userId: number,
  username: string,
  error: string,
  context = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "error",
    user_id: userId,
    username,
    error,
  };
  if (context) {
    event.context = context;
  }
  await writeAuditLog(event);
}

export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Voice Transcription ==============

export type TranscribeProgress = (info: {
  elapsedSec: number;
  stderrTail: string;
}) => void | Promise<void>;

export interface TranscribeOptions {
  onProgress?: TranscribeProgress;
  progressIntervalMs?: number;
}

/**
 * Transcribe audio.
 * Priority: whisper.cpp (local) → WHISPER_SCRIPT_PATH (custom script) → OpenAI API
 * Returns null on failure so the caller can decide whether to keep the audio file.
 */
export async function transcribeVoice(
  filePath: string,
  options: TranscribeOptions = {}
): Promise<string | null> {
  // 1. whisper.cpp — local, free, works offline
  const { isWhisperCppAvailable, transcribeWithWhisperCpp } = await import("./whisper-cpp");
  if (isWhisperCppAvailable()) {
    return transcribeWithWhisperCpp(filePath, options);
  }

  // 2. Custom local script (legacy MLX Whisper or any wrapper)
  if (WHISPER_SCRIPT_PATH) {
    return transcribeWithLocalScript(filePath, options);
  }

  // 3. OpenAI Whisper API
  if (!openaiClient) {
    console.warn("No transcription backend configured");
    return null;
  }

  try {
    const file = Bun.file(filePath);
    const transcript = await openaiClient.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: file,
      prompt: TRANSCRIPTION_PROMPT,
    });
    return transcript.text;
  } catch (error) {
    console.error("Transcription failed:", error);
    return null;
  }
}

async function transcribeWithLocalScript(
  filePath: string,
  options: TranscribeOptions
): Promise<string | null> {
  if (!existsSync(WHISPER_SCRIPT_PATH)) {
    console.error(`WHISPER_SCRIPT_PATH not found: ${WHISPER_SCRIPT_PATH}`);
    return null;
  }

  const startedAt = Date.now();
  const proc = Bun.spawn([WHISPER_SCRIPT_PATH, filePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Tail the last few KB of stderr so the caller can surface recent progress.
  let stderrTail = "";
  const stderrCollector = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrTail = (stderrTail + decoder.decode(value)).slice(-4096);
    }
  })();

  // Periodic progress tick while the subprocess is running.
  const tick = options.progressIntervalMs ?? 30000;
  const progressHandle = options.onProgress
    ? setInterval(() => {
        void options.onProgress!({
          elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
          stderrTail,
        });
      }, tick)
    : null;

  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    await stderrCollector;

    if (exitCode !== 0) {
      console.error(
        `Transcription script failed (exit ${exitCode}): ${stderrTail}`
      );
      return null;
    }

    const transcript = stdout.trim();
    return transcript || null;
  } catch (error) {
    console.error("Transcription subprocess error:", error);
    try {
      proc.kill();
    } catch {}
    return null;
  } finally {
    if (progressHandle) clearInterval(progressHandle);
  }
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        console.debug("Typing indicator failed:", error);
      }
      await Bun.sleep(4000);
    }
  };

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Message Interrupt ==============

// Import session lazily to avoid circular dependency
let sessionModule: {
  session: {
    isRunning: boolean;
    stop: () => Promise<"stopped" | "pending" | false>;
    markInterrupt: () => void;
    clearStopRequested: () => void;
  };
} | null = null;

type InterruptibleSession = {
  isRunning: boolean;
  stop: () => Promise<"stopped" | "pending" | false>;
  markInterrupt: () => void;
  clearStopRequested: () => void;
};

export async function checkInterrupt(
  text: string,
  targetSession?: InterruptibleSession
): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  let interruptSession = targetSession;
  if (!interruptSession) {
    // Lazy import to avoid circular dependency
    if (!sessionModule) {
      sessionModule = await import("./session");
    }
    interruptSession = sessionModule.session;
  }

  const strippedText = text.slice(1).trimStart();
  const normalizedInterrupt = strippedText.trim().toLowerCase();

  if (interruptSession.isRunning) {
    console.log("! prefix - interrupting current query");
    interruptSession.markInterrupt();
    await interruptSession.stop();
    await Bun.sleep(100);
    // Clear stopRequested so the new message can proceed
    interruptSession.clearStopRequested();
  }

  // Treat !stop as a pure stop alias (same behavior as /stop):
  // cancel current work and do not forward "stop" as a new prompt.
  if (normalizedInterrupt === "stop" || normalizedInterrupt === "/stop") {
    return "";
  }

  return strippedText;
}
