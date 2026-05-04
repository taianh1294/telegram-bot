/**
 * Chat-specific routing for Telegram groups.
 *
 * Keeps group conversations scoped by purpose and prevents prompt/context bleed
 * between personal chat, news groups, and teaching groups.
 */

import { SAFETY_PROMPT } from "./config";

const CHINESE_TEACHING_GROUP_ID = -5017490626;

export interface GroupRoute {
  name: string;
  systemPrompt: string;
  dailyRequestLimitPerUser?: number;
}

function isGroupChat(chatType: string | undefined): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export function getGroupRoute(
  chatId: number | undefined,
  chatType: string | undefined
): GroupRoute | null {
  if (!chatId || !isGroupChat(chatType)) return null;

  if (chatId === CHINESE_TEACHING_GROUP_ID) {
    return {
      name: "tro-giang-tieng-trung",
      dailyRequestLimitPerUser: 5,
      systemPrompt:
        `Bạn là trợ giảng tiếng Trung trong group "Trò chuyện cùng trợ giảng".\n\n` +
        `Phạm vi group này CHỈ dành cho nội dung giảng dạy và học tiếng Trung: từ vựng, pinyin, ngữ pháp, phát âm, ví dụ câu, bài tập, sửa bài, kế hoạch học, tài liệu bài giảng.\n\n` +
        `Quy tắc xử lý:\n` +
        `- Nếu câu hỏi liên quan tiếng Trung, trả lời bằng tiếng Việt rõ ràng, có chữ Hán, pinyin và nghĩa tiếng Việt khi phù hợp.\n` +
        `- Nếu người dùng hỏi ngoài phạm vi học/giảng dạy tiếng Trung, trả lời ngắn rằng group này chỉ dùng cho nội dung tiếng Trung và đề nghị chuyển sang chat riêng hoặc group phù hợp.\n` +
        `- Khi tạo/lưu tài liệu, ưu tiên thư mục E:/Powerful Assistant/projects/tieng-trung/ và tuân thủ README của project này.\n` +
        `- Không dùng vai trò PM, kinh tế, bản tin, fanpage, hoặc trợ lý cá nhân trong group này trừ khi có liên hệ trực tiếp đến dạy/học tiếng Trung.\n\n` +
        `---\n\n` +
        SAFETY_PROMPT,
    };
  }

  return null;
}
