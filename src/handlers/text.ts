/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import type { StatusCallback } from "../types";
import { getSessionForChat } from "../session";
import { ALLOWED_USERS, QUIET_MODE } from "../config";
import { isAuthorizedInChat, rateLimiter } from "../security";
import { runScheduleNow, findScheduleByKeyword } from "../scheduler";
import {
  auditLog,
  auditLogRateLimit,
  checkInterrupt,
  startTypingIndicator,
} from "../utils";
import {
  StreamingState,
  createStatusCallback,
  setupQuietPlaceholder,
} from "./streaming";
import {
  getMode,
  isBetaMessage,
  stripBetaPrefix,
  getBetaSystemPrompt,
  getDeptSystemPrompt,
  appendCompareLog,
  runSilentBetaQuery,
  runCeoRoutingQuery,
} from "../config-loader";
import {
  parseCeoRouting,
  appendRoutingLog,
  DEPT_LABELS,
} from "../ceo-parser";
import { getGroupRoute } from "../group-routing";
import { consumeDailyGroupQuota } from "../group-quota";

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  const activeSession = getSessionForChat(chatId, ctx.chat?.type);
  const groupRoute = getGroupRoute(chatId, ctx.chat?.type);

  // Đính kèm nội dung quoted/replied message vào context
  const replyMsg = ctx.message?.reply_to_message;
  const replyText = replyMsg?.text || replyMsg?.caption;
  if (replyText) {
    const preview = replyText.length > 300 ? replyText.slice(0, 300) + "..." : replyText;
    message = `[Trả lời tin nhắn: "${preview}"]\n\n${message}`;
  }

  // 1. Authorization check
  if (!isAuthorizedInChat(userId, ctx.chat?.type, ALLOWED_USERS, ctx.chat?.id)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check for interrupt prefix
  message = await checkInterrupt(message, activeSession);
  if (!message.trim()) {
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

  // 4. Check trigger keywords — fire matching schedule without going through Claude
  const triggered = findScheduleByKeyword(message);
  if (triggered) {
    await ctx.reply(`⏳ Đang chạy: <b>${triggered.name}</b>...`, { parse_mode: "HTML" });
    await runScheduleNow(ctx.api, triggered.id, chatId ?? undefined);
    return;
  }

  if (groupRoute?.dailyRequestLimitPerUser) {
    const quota = consumeDailyGroupQuota(
      chatId,
      userId,
      groupRoute.dailyRequestLimitPerUser
    );
    if (!quota.allowed) {
      await ctx.reply(
        `Anh đã dùng hết ${quota.limit} request hôm nay trong group này. Hạn mức sẽ reset vào ngày mai.`
      );
      return;
    }
  }

  // 5. Routing: beta / compare mode
  const mode = getMode();
  const isCompare = !groupRoute && mode === "compare";
  const isBeta = !groupRoute && (mode === "beta" || isBetaMessage(message));

  let sessionOverrides: { systemPrompt?: string; model?: string } | undefined =
    groupRoute ? { systemPrompt: groupRoute.systemPrompt } : undefined;
  let replyTag = "";

  if (isBeta || isCompare) {
    message = stripBetaPrefix(message);

    // Phase 2: CEO routing — quick silent call to get dept
    try {
      const ceoResponse = await runCeoRoutingQuery(message);
      const routing = parseCeoRouting(ceoResponse);

      appendRoutingLog({
        input: message,
        action: routing?.action ?? "parse_failed",
        dept: routing?.dept ?? null,
        model_used: "cc/claude-sonnet-4-6",
        success: routing !== null,
      });

      if (routing?.action === "route" && routing.dept) {
        const dept = routing.dept as string;
        const label = DEPT_LABELS[dept] ?? dept.toUpperCase();
        replyTag = `[${label}] `;
        // Inject CEO context into message if provided
        const contextedMsg = routing.context
          ? `[Context: ${routing.context}]\n\n${message}`
          : message;
        message = contextedMsg;
        sessionOverrides = { systemPrompt: getDeptSystemPrompt(dept) };
        // Notify user which dept is handling
        await ctx.reply(`🔀 Chuyển sang ${label}...`).catch(() => {});
      } else {
        // CEO handles directly or clarify
        replyTag = "[BETA] ";
        sessionOverrides = { systemPrompt: getBetaSystemPrompt() };
      }
    } catch (e) {
      // CEO routing failed — fallback to CEO system prompt
      console.warn("[routing] CEO query failed, using beta fallback:", e);
      replyTag = "[BETA] ";
      sessionOverrides = { systemPrompt: getBetaSystemPrompt() };
    }
  }

  // Store (stripped) message for retry
  activeSession.lastMessage = message;

  // Set conversation title from first message (if new session)
  if (!activeSession.isActive) {
    const title =
      message.length > 50 ? message.slice(0, 47) + "..." : message;
    activeSession.conversationTitle = groupRoute
      ? `${groupRoute.name}: ${title}`
      : title;
  }

  // 6. Mark processing started
  const stopProcessing = activeSession.startProcessing();

  // 7. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 8. Create streaming state and callback
  let state = new StreamingState();
  state.quietMode = QUIET_MODE;
  let statusCallback = createStatusCallback(ctx, state);
  await setupQuietPlaceholder(ctx, state);

  // 9. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stableOverrides = isCompare ? undefined : sessionOverrides;
      const stableStart = Date.now();

      const response = await activeSession.sendMessageStreaming(
        message,
        username,
        userId,
        replyTag && !isCompare
          ? wrapWithBetaTag(replyTag, statusCallback)
          : statusCallback,
        chatId,
        ctx,
        stableOverrides
      );

      // Compare mode: fire beta query silently in background after stable
      if (isCompare) {
        const stableLatency = Date.now() - stableStart;
        void (async () => {
          try {
            const beta = await runSilentBetaQuery(message);
            appendCompareLog({
              input: message,
              stable: { response, latency_ms: stableLatency },
              beta,
            });
          } catch (e) {
            console.warn("[compare] beta query failed:", e);
          }
        })();
      }

      // 10. Audit log
      await auditLog(userId, username, "TEXT", message, response);
      break; // Success - exit retry loop
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      // Clean up any partial messages from this attempt
      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }
      if (state.placeholderMessage) {
        try {
          await ctx.api.deleteMessage(
            state.placeholderMessage.chat.id,
            state.placeholderMessage.message_id
          );
        } catch {
          // Ignore cleanup errors
        }
      }

      // Retry on Claude Code crash (not user cancellation)
      const isSessionNotFound = errorStr.includes("No conversation found with session ID");
      if ((isClaudeCodeCrash || isSessionNotFound) && attempt < MAX_RETRIES) {
        if (isSessionNotFound) {
          console.log(`Session expired, starting new session (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`);
          await activeSession.kill();
        } else {
          console.log(
            `Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
          );
          await activeSession.kill(); // Clear corrupted session
          await ctx.reply(`⚠️ Claude crashed, retrying...`);
        }
        // Reset state for retry
        state = new StreamingState();
        state.quietMode = QUIET_MODE;
        statusCallback = createStatusCallback(ctx, state);
        await setupQuietPlaceholder(ctx, state);
        continue;
      }

      // Final attempt failed or non-retryable error
      console.error("Error processing message:", error);

      // Check if it was a cancellation
      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
        const wasInterrupt = activeSession.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.");
        }
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
      }
      break; // Exit loop after handling error
    }
  }

  // 11. Cleanup
  stopProcessing();
  typing.stop();
}

// Wraps statusCallback to prepend [BETA] tag on the first text segment
function wrapWithBetaTag(tag: string, cb: StatusCallback): StatusCallback {
  let tagged = false;
  return async (type, text, id) => {
    if (!tagged && type === "segment_end" && text) {
      tagged = true;
      return cb(type, tag + text, id);
    }
    return cb(type, text, id);
  };
}
