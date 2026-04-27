/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import { unlinkSync } from "fs";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard, InputFile } from "grammy";
import type { StatusCallback } from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
} from "../config";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
  requestId: string,
  options: string[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    const callbackData = `askuser:${requestId}:${idx}`;
    keyboard.text(display, callbackData).row();
  }
  return keyboard;
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const glob = new Bun.Glob("ask-user-*.json");
  let buttonsSent = false;

  for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
    const filepath = `/tmp/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const question = data.question || "Please choose:";
      const options = data.options || [];
      const requestId = data.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;

        // Mark as sent
        data.status = "sent";
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      console.warn(`Failed to process ask-user file ${filepath}:`, error);
    }
  }

  return buttonsSent;
}

// File extensions grouped by Telegram send method
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".webm", ".mkv"]);
const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a"]);

/**
 * Check for pending send-file requests and deliver files via Telegram.
 */
export async function checkPendingSendFileRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const glob = new Bun.Glob("send-file-*.json");
  let fileSent = false;

  for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
    const filepath = `/tmp/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const filePath: string = data.file_path || "";
      const caption: string | undefined = data.caption || undefined;

      if (!filePath) {
        try { unlinkSync(filepath); } catch { /* ignore */ }
        continue;
      }

      try {
        const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
        const inputFile = new InputFile(filePath);

        if (VIDEO_EXTENSIONS.has(ext)) {
          await ctx.replyWithVideo(inputFile, { caption });
        } else if (PHOTO_EXTENSIONS.has(ext)) {
          await ctx.replyWithPhoto(inputFile, { caption });
        } else if (AUDIO_EXTENSIONS.has(ext)) {
          await ctx.replyWithAudio(inputFile, { caption });
        } else {
          await ctx.replyWithDocument(inputFile, { caption });
        }

        fileSent = true;
      } catch (sendError) {
        console.error(`Failed to send file ${filePath}:`, sendError);
        await ctx.reply(
          `Failed to send file: ${filePath.split("/").pop() || "unknown"}`
        );
      }

      // Always clean up the request file
      try { unlinkSync(filepath); } catch { /* ignore */ }
    } catch (error) {
      console.warn(`Failed to process send-file request ${filepath}:`, error);
    }
  }

  return fileSent;
}

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content

  // Quiet mode (env QUIET_MODE=true): chỉ giữ 1 placeholder message, edit thành
  // response cuối cùng khi done. Không gửi tool/thinking/intermediate text.
  quietMode = false;
  placeholderMessage: Message | null = null;
  aggregatedText = "";
}

/**
 * Tạo placeholder message "đang xử lý" — gọi từ handler trước khi run query.
 * Chỉ tạo khi state.quietMode = true.
 */
export async function setupQuietPlaceholder(
  ctx: Context,
  state: StreamingState
): Promise<void> {
  if (!state.quietMode) return;
  try {
    state.placeholderMessage = await ctx.reply("🤔 đang xử lý...");
  } catch (error) {
    console.debug("Failed to send quiet placeholder:", error);
  }
}

/**
 * Format content for Telegram, ensuring it fits within the message limit.
 * Truncates raw content and re-converts if HTML output exceeds the limit.
 */
function formatWithinLimit(
  content: string,
  safeLimit: number = TELEGRAM_SAFE_LIMIT
): string {
  let display =
    content.length > safeLimit ? content.slice(0, safeLimit) + "..." : content;
  let formatted = convertMarkdownToHtml(display);

  // HTML tags can inflate content beyond the limit - shrink iteratively until it fits.
  // Worst case (markdown-heavy content) may need multiple passes.
  let guard = 5;
  while (formatted.length > TELEGRAM_MESSAGE_LIMIT && guard-- > 0) {
    const ratio = TELEGRAM_MESSAGE_LIMIT / formatted.length;
    const nextLen = Math.max(
      200,
      Math.floor(display.length * ratio * 0.9)
    );
    display = content.slice(0, nextLen) + "...";
    formatted = convertMarkdownToHtml(display);
  }

  // Final hard cap — cut raw HTML at a safe boundary if shrinking didn't converge.
  if (formatted.length > TELEGRAM_MESSAGE_LIMIT) {
    formatted = formatted.slice(0, TELEGRAM_MESSAGE_LIMIT - 3) + "...";
  }

  return formatted;
}

/**
 * Split formatted HTML into chunks at safe boundaries so no tag is cut in half.
 */
function splitHtmlSafely(html: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = html;

  while (rest.length > limit) {
    // Prefer paragraph boundary, then newline, then space.
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;

    // If the cut falls inside an HTML tag (between "<" and ">"), back up.
    const openTag = rest.lastIndexOf("<", cut);
    const closeTag = rest.lastIndexOf(">", cut);
    if (openTag > closeTag) {
      cut = openTag;
    }

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

/**
 * Split long formatted content into chunks and send as separate messages.
 */
async function sendChunkedMessages(
  ctx: Context,
  content: string
): Promise<void> {
  const chunks = splitHtmlSafely(content, TELEGRAM_SAFE_LIMIT);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      // HTML failed (possibly broken tags from split) - try plain text
      try {
        await ctx.reply(chunk);
      } catch (plainError) {
        console.debug("Failed to send chunk:", plainError);
      }
    }
  }
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      // Quiet mode: bỏ qua mọi status trừ segment_end (gom text) + done (flush).
      if (state.quietMode) {
        if (statusType === "segment_end" && content) {
          state.aggregatedText +=
            (state.aggregatedText ? "\n\n" : "") + content;
          return;
        }
        if (statusType === "done") {
          const placeholder = state.placeholderMessage;
          const finalText = state.aggregatedText.trim();

          if (placeholder && finalText) {
            const formatted = convertMarkdownToHtml(finalText);
            if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
              try {
                await ctx.api.editMessageText(
                  placeholder.chat.id,
                  placeholder.message_id,
                  formatted,
                  { parse_mode: "HTML" }
                );
              } catch {
                try {
                  await ctx.api.editMessageText(
                    placeholder.chat.id,
                    placeholder.message_id,
                    finalText
                  );
                } catch (editError) {
                  console.debug("Quiet edit failed:", editError);
                }
              }
            } else {
              try {
                await ctx.api.deleteMessage(
                  placeholder.chat.id,
                  placeholder.message_id
                );
              } catch {}
              await sendChunkedMessages(ctx, formatted);
            }
          } else if (placeholder && !finalText) {
            // Không có response text — xóa placeholder cho gọn
            try {
              await ctx.api.deleteMessage(
                placeholder.chat.id,
                placeholder.message_id
              );
            } catch {}
          }
        }
        return;
      }

      if (statusType === "thinking") {
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "text" && segmentId !== undefined) {
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message
          const formatted = formatWithinLimit(content);
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            // HTML parse failed, fall back to plain text
            console.debug("HTML reply failed, using plain text:", htmlError);
            const msg = await ctx.reply(formatted);
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          const formatted = formatWithinLimit(content);
          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await ctx.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              formatted,
              {
                parse_mode: "HTML",
              }
            );
            state.lastContent.set(segmentId, formatted);
          } catch (error) {
            const errorStr = String(error);
            if (errorStr.includes("MESSAGE_TOO_LONG")) {
              // Skip this intermediate update - segment_end will chunk properly
              console.debug(
                "Streaming edit too long, deferring to segment_end"
              );
            } else {
              console.debug("HTML edit failed, trying plain text:", error);
              try {
                await ctx.api.editMessageText(
                  msg.chat.id,
                  msg.message_id,
                  formatted
                );
                state.lastContent.set(segmentId, formatted);
              } catch (editError) {
                console.debug("Edit message failed:", editError);
              }
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (state.textMessages.has(segmentId) && content) {
          const msg = state.textMessages.get(segmentId)!;
          const formatted = convertMarkdownToHtml(content);

          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }

          if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted,
                {
                  parse_mode: "HTML",
                }
              );
            } catch (error) {
              const errorStr = String(error);
              if (errorStr.includes("MESSAGE_TOO_LONG")) {
                // HTML overhead pushed it over - delete and chunk
                try {
                  await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
                } catch (delError) {
                  console.debug("Failed to delete for chunking:", delError);
                }
                await sendChunkedMessages(ctx, formatted);
              } else {
                console.debug("Failed to edit final message:", error);
              }
            }
          } else {
            // Too long - delete and split
            try {
              await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
            } catch (error) {
              console.debug("Failed to delete message for splitting:", error);
            }
            await sendChunkedMessages(ctx, formatted);
          }
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch (error) {
            console.debug("Failed to delete tool message:", error);
          }
        }
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
