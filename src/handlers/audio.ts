/**
 * Audio handler for Claude Telegram Bot.
 *
 * Handles native Telegram audio messages and audio files sent as documents.
 * Transcribes using OpenAI (same as voice messages) then processes with Claude.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import {
  ALLOWED_USERS,
  TEMP_DIR,
  TRANSCRIPTION_AVAILABLE,
  QUIET_MODE,
} from "../config";
import { isAuthorized, isAuthorizedInChat, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  transcribeVoice,
  startTypingIndicator,
} from "../utils";
import {
  StreamingState,
  createStatusCallback,
  setupQuietPlaceholder,
} from "./streaming";

// Supported audio file extensions
const AUDIO_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".ogg",
  ".wav",
  ".aac",
  ".flac",
  ".opus",
  ".wma",
];

/**
 * Check if a file is an audio file by extension or mime type.
 */
export function isAudioFile(fileName?: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("audio/")) {
    return true;
  }
  if (fileName) {
    const ext = "." + (fileName.split(".").pop() || "").toLowerCase();
    return AUDIO_EXTENSIONS.includes(ext);
  }
  return false;
}

/**
 * Process an audio file: transcribe and send to Claude.
 */
export async function processAudioFile(
  ctx: Context,
  filePath: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env"
    );
    return;
  }

  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);
  let keepFile = false;

  try {
    // Transcribe (with periodic progress updates for long files)
    const statusMsg = await ctx.reply("🎤 Đang nhận dạng audio...");

    let lastShown = "";
    const showProgress = async ({ elapsedSec }: { elapsedSec: number }) => {
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      const text = `🎤 Đang nhận dạng... (${mins}:${secs
        .toString()
        .padStart(2, "0")})`;
      if (text === lastShown) return;
      lastShown = text;
      try {
        await ctx.api.editMessageText(chatId, statusMsg.message_id, text);
      } catch {
        // ignore
      }
    };

    const transcript = await transcribeVoice(filePath, {
      onProgress: showProgress,
      progressIntervalMs: 30000,
    });
    if (!transcript) {
      keepFile = true;
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `❌ Nhận dạng thất bại. File audio giữ lại tại:\n<code>${filePath}</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Show transcript
    const maxDisplay = 4000;
    const displayTranscript =
      transcript.length > maxDisplay
        ? transcript.slice(0, maxDisplay) + "…"
        : transcript;
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 "${displayTranscript}"`
    );

    // Build prompt: transcript + optional caption
    const prompt = caption
      ? `${transcript}\n\n---\n\n${caption}`
      : transcript;

    // Set conversation title (if new session)
    if (!session.isActive) {
      const title =
        transcript.length > 50
          ? transcript.slice(0, 47) + "..."
          : transcript;
      session.conversationTitle = title;
    }

    // Create streaming state and callback
    const state = new StreamingState();
    state.quietMode = QUIET_MODE;
    const statusCallback = createStatusCallback(ctx, state);
    await setupQuietPlaceholder(ctx, state);

    // Send to Claude
    const claudeResponse = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    // Audit log
    await auditLog(userId, username, "AUDIO", transcript, claudeResponse);
  } catch (error) {
    console.error("Error processing audio:", error);

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      const wasInterrupt = session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    stopProcessing();
    typing.stop();

    // Clean up audio file — keep it if transcription failed so user can retry.
    if (!keepFile) {
      try {
        unlinkSync(filePath);
      } catch (error) {
        console.debug("Failed to delete audio file:", error);
      }
    }
  }
}

/**
 * Handle incoming native Telegram audio messages.
 */
export async function handleAudio(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const audio = ctx.message?.audio;

  if (!userId || !chatId || !audio) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorizedInChat(userId, ctx.chat?.type, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  console.log(`Received audio from @${username}`);

  // 3. Download audio file
  let audioPath: string;
  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const ext = audio.file_name?.split(".").pop() || "mp3";
    audioPath = `${TEMP_DIR}/audio_${timestamp}.${ext}`;

    const response = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await Bun.write(audioPath, buffer);
  } catch (error) {
    console.error("Failed to download audio:", error);
    await ctx.reply("❌ Failed to download audio file.");
    return;
  }

  // 4. Process audio
  await processAudioFile(
    ctx,
    audioPath,
    ctx.message?.caption,
    userId,
    username,
    chatId
  );
}
