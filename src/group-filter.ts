/**
 * Group chat filter middleware.
 *
 * Trong group/supergroup, bot CHỈ phản hồi khi:
 *  - Tin nhắn @mention username của bot, HOẶC
 *  - Tin nhắn là reply trực tiếp vào message của bot
 *
 * Trong private chat (1-1), filter này không áp dụng — flow auth gốc tiếp tục.
 *
 * Group chat còn phải qua auth ở handler: user_id phải nằm trong
 * TELEGRAM_ALLOWED_USERS và chat_id phải nằm trong TELEGRAM_ALLOWED_GROUPS.
 */

import type { Context, NextFunction } from "grammy";

let cachedBotUsername: string | null = null;

/**
 * Khởi tạo username bot (gọi 1 lần lúc start sau bot.api.getMe()).
 */
export function setBotUsername(username: string): void {
  cachedBotUsername = username.toLowerCase();
}

/**
 * Trả về true nếu message này được phép xử lý trong context group.
 * Logic:
 *  - Private chat → luôn true (dùng auth allowlist gốc).
 *  - Group/supergroup → chỉ true khi @mention bot hoặc reply bot.
 *  - Channel post → luôn false.
 */
export function shouldHandleInGroup(ctx: Context): boolean {
  const chatType = ctx.chat?.type;

  // Private chat: cho qua (auth gốc xử lý)
  if (chatType === "private") {
    return true;
  }

  // Channel: bỏ qua
  if (chatType === "channel") {
    return false;
  }

  // Group / supergroup: kiểm tra mention/reply
  if (chatType === "group" || chatType === "supergroup") {
    return isBotMentionedOrReplied(ctx);
  }

  // Loại chat lạ (không xác định) → bỏ qua cho an toàn
  return false;
}

/**
 * Detect bot có được tag hoặc reply trong message không.
 *
 * Cover các loại trigger:
 *   1. Reply vào message của bot
 *   2. @mention username bot trong text/caption
 *   3. Text mention (Telegram cho phép tag user không có username) — không
 *      áp dụng với bot, bỏ qua
 *   4. /command (đã được bot.command() handle riêng — không vào filter này)
 */
function isBotMentionedOrReplied(ctx: Context): boolean {
  const username = cachedBotUsername;
  if (!username) {
    // Chưa init username → an toàn, bỏ qua
    console.warn("[group-filter] Bot username chưa init");
    return false;
  }

  // 1. Reply vào bot
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo?.from?.is_bot && replyTo.from.username?.toLowerCase() === username) {
    return true;
  }

  // 2. @mention trong text hoặc caption
  const text = ctx.message?.text ?? ctx.message?.caption ?? "";
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? [];

  for (const entity of entities) {
    if (entity.type === "mention") {
      const mentioned = text
        .slice(entity.offset, entity.offset + entity.length)
        .toLowerCase();
      // entity dạng "@username"
      if (mentioned === `@${username}`) {
        return true;
      }
    }
  }

  return false;
}

/**
 * grammY middleware. Đặt trước mọi handler để filter group.
 */
export async function groupFilterMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  // Callback queries (button clicks) luôn cho qua — không liên quan group filter
  if (ctx.callbackQuery) {
    await next();
    return;
  }

  // Không có message (vd edited_message) → bỏ qua
  if (!ctx.message) {
    return;
  }

  // Log mọi message từ group để debug chat_id (kể cả khi bị drop vì không tag).
  const chat = ctx.chat;
  if (chat && (chat.type === "group" || chat.type === "supergroup")) {
    const title = "title" in chat ? chat.title : "(no title)";
    const handled = shouldHandleInGroup(ctx);
    console.log(
      `[group-filter] chat_id=${chat.id} type=${chat.type} title="${title}" handled=${handled}`
    );
  }

  if (shouldHandleInGroup(ctx)) {
    await next();
  }
  // Nếu false: drop im lặng, không phản hồi gì hết.
}
