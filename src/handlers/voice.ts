/**
 * Voice message handler for Claude Telegram Bot.
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

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorizedInChat(userId, ctx.chat?.type, ALLOWED_USERS, ctx.chat?.id)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env"
    );
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 4. Mark processing started (allows /stop to work during transcription/classification)
  const stopProcessing = session.startProcessing();

  // 5. Start typing indicator for transcription
  const typing = startTypingIndicator(ctx);

  let voicePath: string | null = null;

  try {
    // 6. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    // Download the file
    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // 7. Transcribe (with periodic progress updates for long files)
    const statusMsg = await ctx.reply("🎤 Đang nhận dạng giọng nói...");

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
        // Edit may fail if text unchanged or rate-limited — safe to ignore.
      }
    };

    const transcript = await transcribeVoice(voicePath, {
      onProgress: showProgress,
      progressIntervalMs: 30000,
    });
    if (!transcript) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `❌ Nhận dạng thất bại. File audio giữ lại tại:\n<code>${voicePath}</code>`,
        { parse_mode: "HTML" }
      );
      voicePath = null; // không xoá trong finally
      stopProcessing();
      return;
    }

    // 8. Show transcript (truncate display if needed - full transcript still sent to Claude)
    const maxDisplay = 4000; // Leave room for 🎤 "" wrapper within 4096 limit
    const displayTranscript =
      transcript.length > maxDisplay
        ? transcript.slice(0, maxDisplay) + "…"
        : transcript;
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 "${displayTranscript}"`
    );

    // 9. Set conversation title from transcript (if new session)
    if (!session.isActive) {
      const title =
        transcript.length > 50 ? transcript.slice(0, 47) + "..." : transcript;
      session.conversationTitle = title;
    }

    // 10. Create streaming state and callback
    const state = new StreamingState();
    state.quietMode = QUIET_MODE;
    const statusCallback = createStatusCallback(ctx, state);
    await setupQuietPlaceholder(ctx, state);

    // 11. Send to Claude
    const claudeResponse = await session.sendMessageStreaming(
      transcript,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    // 12. Audit log
    await auditLog(userId, username, "VOICE", transcript, claudeResponse);
  } catch (error) {
    console.error("Error processing voice:", error);

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
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

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch (error) {
        console.debug("Failed to delete voice file:", error);
      }
    }
  }
}
