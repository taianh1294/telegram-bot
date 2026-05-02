/**
 * Scheduler module for Claude Telegram Bot.
 *
 * Reads schedules from E:/Powerful Assistant/data/schedules.json
 * and sends messages to users at the scheduled time.
 *
 * Schedule types:
 *   once     - run at a specific datetime, then disable
 *   interval - run every N minutes
 *   daily    - run every day at HH:MM (timezone-aware)
 *   weekly   - run every week on a specific day at HH:MM
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Api } from "grammy";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { WORKING_DIR } from "./config";
import { resolve } from "path";

const SCHEDULES_FILE = resolve(WORKING_DIR, "data/schedules.json");
const LAST_NEWSLETTER_FILE = resolve(WORKING_DIR, "data/last-newsletter.json");

export interface Recurrence {
  type: "interval" | "daily" | "weekly" | "startup_daily";
  interval_minutes?: number;
  time?: string;           // "HH:MM" for daily/weekly
  day?: number;            // 0=Sun..6=Sat for weekly
  timezone?: string;       // e.g. "Asia/Ho_Chi_Minh"
  window_start?: string;   // "HH:MM" — startup_daily: earliest fire time
  window_end?: string;     // "HH:MM" — startup_daily: latest fire time
}

export interface Schedule {
  id: string;
  name: string;
  chat_id: number;
  message: string;          // static message to send, OR prompt for claude_query
  claude_query?: boolean;      // if true: send `message` to Claude, forward response to user
  claude_model?: string;       // model override for claude_query (default: claude-sonnet-4-6)
  trigger_keywords?: string[]; // keywords that manually fire this schedule (case-insensitive)
  notify_chats?: number[];     // gửi đến nhiều chat (bổ sung hoặc thay thế chat_id khi schedule tự trigger)
  next_run: string;         // ISO UTC string
  recurrence?: Recurrence;  // absent = one-time
  enabled: boolean;
  created_at: string;
  last_run: string | null;
}

interface ScheduleFile {
  schedules: Schedule[];
}

function loadSchedules(): ScheduleFile {
  try {
    if (!existsSync(SCHEDULES_FILE)) return { schedules: [] };
    const raw = readFileSync(SCHEDULES_FILE, "utf-8");
    return JSON.parse(raw) as ScheduleFile;
  } catch {
    return { schedules: [] };
  }
}

function saveLastNewsletter(scheduleId: string, content: string): void {
  try {
    const dir = resolve(WORKING_DIR, "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(LAST_NEWSLETTER_FILE, JSON.stringify({
      schedule_id: scheduleId,
      sent_at: new Date().toISOString(),
      content,
    }, null, 2), "utf-8");
  } catch (e) {
    console.error("[scheduler] Failed to save last newsletter:", e);
  }
}

function saveSchedules(data: ScheduleFile): void {
  try {
    const dir = resolve(WORKING_DIR, "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SCHEDULES_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("[scheduler] Failed to save schedules:", e);
  }
}

/**
 * Calculate the next UTC run time for a recurring schedule, after `after`.
 */
function calcNextRun(recurrence: Recurrence, after: Date): Date {
  const tz = recurrence.timezone || "Asia/Ho_Chi_Minh";

  if (recurrence.type === "interval") {
    const mins = recurrence.interval_minutes || 60;
    return new Date(after.getTime() + mins * 60_000);
  }

  if (recurrence.type === "daily" || recurrence.type === "weekly") {
    const [targetHour, targetMin] = (recurrence.time || "09:00")
      .split(":")
      .map(Number);

    // Try candidates: today, tomorrow, ... (up to 8 days for weekly)
    const maxDays = recurrence.type === "weekly" ? 8 : 2;

    for (let dayOffset = 0; dayOffset < maxDays; dayOffset++) {
      const candidate = new Date(after.getTime() + dayOffset * 86_400_000);

      // Build a date string "YYYY-MM-DDTHH:MM:00" in local tz, then convert to UTC
      // Use a trick: format candidate date in tz to get its local date components
      const localDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
      }).formatToParts(candidate);

      const year = localDate.find((p) => p.type === "year")?.value;
      const month = localDate.find((p) => p.type === "month")?.value;
      const day = localDate.find((p) => p.type === "day")?.value;
      const weekday = localDate.find((p) => p.type === "weekday")?.value;

      // For weekly: check if this day matches
      if (recurrence.type === "weekly" && recurrence.day !== undefined) {
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const targetDayName = dayNames[recurrence.day];
        if (weekday !== targetDayName) continue;
      }

      // Build ISO string for this date at target time in the timezone
      const localStr = `${year}-${month}-${day}T${String(targetHour).padStart(2, "0")}:${String(targetMin).padStart(2, "0")}:00`;

      // Convert to UTC using the timezone offset
      // Use Date constructor with the timezone-aware string
      // We need to find UTC equivalent of localStr in tz
      // Approach: use Intl to get offset
      const testDate = new Date(localStr + "Z"); // treat as UTC first
      const offsetMs = getTimezoneOffset(tz, testDate);
      const utcDate = new Date(testDate.getTime() - offsetMs);

      // Must be strictly after `after` (avoid re-firing same minute)
      if (utcDate.getTime() > after.getTime() + 30_000) {
        return utcDate;
      }
    }
  }

  // Fallback: 1 hour from now
  return new Date(after.getTime() + 3_600_000);
}

/**
 * Get timezone offset in milliseconds for a given timezone at a given UTC date.
 * Returns offset such that: local_time = utc_time + offset
 */
function getTimezoneOffset(tz: string, utcDate: Date): number {
  const utcStr = utcDate.toLocaleString("en-US", { timeZone: "UTC" });
  const localStr = utcDate.toLocaleString("en-US", { timeZone: tz });
  const utcParsed = new Date(utcStr);
  const localParsed = new Date(localStr);
  return localParsed.getTime() - utcParsed.getTime();
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

/** Lấy giờ phút hiện tại theo timezone, dạng số phút từ 00:00 */
function localMinutes(tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const m = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  return h * 60 + m;
}

/** Ngày hôm nay theo timezone, dạng "YYYY-MM-DD" */
function localDateStr(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Kiểm tra startup_daily: trong khung giờ và chưa gửi hôm nay */
function shouldFireOnStartup(schedule: Schedule): boolean {
  if (schedule.recurrence?.type !== "startup_daily") return false;
  const tz = schedule.recurrence.timezone || "Asia/Ho_Chi_Minh";
  const now = localMinutes(tz);
  const start = toMinutes(schedule.recurrence.window_start || "08:00");
  const end = toMinutes(schedule.recurrence.window_end || "20:30");
  if (now < start || now > end) return false;

  // Chưa gửi hôm nay?
  if (!schedule.last_run) return true;
  const lastRunDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz })
    .format(new Date(schedule.last_run));
  return lastRunDate !== localDateStr(tz);
}

export function startScheduler(botApi: Api): void {
  const dataDir = resolve(WORKING_DIR, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  if (!existsSync(SCHEDULES_FILE)) {
    saveSchedules({ schedules: [] });
    console.log(`[scheduler] Initialized schedules file: ${SCHEDULES_FILE}`);
  } else {
    const data = loadSchedules();
    const active = data.schedules.filter((s) => s.enabled).length;
    console.log(`[scheduler] Loaded ${data.schedules.length} schedules (${active} active)`);

    // Startup check: fire startup_daily schedules ngay nếu đủ điều kiện
    for (const schedule of data.schedules) {
      if (schedule.enabled && shouldFireOnStartup(schedule)) {
        console.log(`[scheduler] Startup fire: "${schedule.name}"`);
        setTimeout(() => tickScheduler(botApi), 5_000); // delay 5s cho bot ready
        break;
      }
    }
  }

  // Check every 30 seconds
  schedulerInterval = setInterval(() => tickScheduler(botApi), 30_000);
  console.log("[scheduler] Started (checking every 30s)");
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

async function runClaudeQuery(schedule: Schedule): Promise<string> {
  const model = schedule.claude_model || "claude-sonnet-4-6";
  console.log(`[scheduler] claude_query "${schedule.name}" model=${model}`);

  const parts: string[] = [];
  try {
    for await (const event of query({
      prompt: schedule.message,
      options: {
        model,
        maxTurns: 15,
        permissionMode: "bypassPermissions",
        cwd: WORKING_DIR,
      },
    })) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") parts.push(block.text);
        }
      }
    }
  } catch (e) {
    throw new Error(`Claude query failed: ${e}`);
  }

  const response = parts.join("").trim() || "Không có dữ liệu.";
  console.log(`[scheduler] claude_query "${schedule.name}" done (${response.length} chars)`);
  return response;
}

async function sendToChats(botApi: Api, chatIds: number[], text: string): Promise<void> {
  const LIMIT = 4000;
  for (const cid of chatIds) {
    if (text.length <= LIMIT) {
      await botApi.sendMessage(cid, text, { parse_mode: "HTML" });
    } else {
      for (let i = 0; i < text.length; i += LIMIT) {
        await botApi.sendMessage(cid, text.slice(i, i + LIMIT), { parse_mode: "HTML" });
      }
    }
  }
}

async function tickScheduler(botApi: Api): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
  const data = loadSchedules();
  const now = new Date();
  let changed = false;

  for (const schedule of data.schedules) {
    if (!schedule.enabled) continue;

    // startup_daily: kiểm tra khung giờ và chưa gửi hôm nay
    const isStartupDaily = schedule.recurrence?.type === "startup_daily";
    if (isStartupDaily) {
      if (!shouldFireOnStartup(schedule)) continue;
    } else {
      const nextRun = new Date(schedule.next_run);
      if (nextRun > now) continue;
    }

    // Fire! — gửi đến tất cả chat trong notify_chats (hoặc chat_id nếu không có)
    const targetChats = schedule.notify_chats?.length
      ? schedule.notify_chats
      : [schedule.chat_id];

    try {
      if (schedule.claude_query) {
        // Báo đang xử lý tới tất cả chat trước
        for (const cid of targetChats) {
          await botApi.sendMessage(cid, `⏳ Đang tổng hợp <b>${schedule.name}</b>...`, { parse_mode: "HTML" });
        }
        // Gọi Claude 1 lần, gửi kết quả đến tất cả chat
        const response = await runClaudeQuery(schedule);
        await sendToChats(botApi, targetChats, response);
        saveLastNewsletter(schedule.id, response);
      } else {
        await sendToChats(botApi, targetChats, schedule.message);
        console.log(`[scheduler] Fired: "${schedule.name}" → ${targetChats.join(", ")}`);
      }
      schedule.last_run = now.toISOString();
    } catch (e) {
      console.error(`[scheduler] Failed to fire "${schedule.name}":`, e);
    }

    if (!isStartupDaily && schedule.recurrence) {
      schedule.next_run = calcNextRun(schedule.recurrence, now).toISOString();
    } else if (!schedule.recurrence) {
      schedule.enabled = false;
    }

    changed = true;
  }

  if (changed) saveSchedules(data);
  } finally {
    tickRunning = false;
  }
}

/** Tìm schedule theo keyword trong tin nhắn người dùng.
 *  Chỉ match khi message BẮT ĐẦU bằng keyword (sau khi strip @mention),
 *  tránh bắt nhầm khi keyword xuất hiện ngẫu nhiên trong câu dài. */
export function findScheduleByKeyword(message: string): Schedule | null {
  const data = loadSchedules();
  // Strip @username mention ở đầu message (group chat)
  const stripped = message.trim().replace(/^@\S+\s*/, "").trim();
  const lower = stripped.toLowerCase();
  return data.schedules.find(s =>
    s.enabled &&
    s.trigger_keywords?.some(kw => {
      const kwLower = kw.toLowerCase();
      return lower === kwLower || lower.startsWith(kwLower + " ") || lower.startsWith(kwLower + "\n");
    })
  ) ?? null;
}

/** Chạy ngay một schedule theo id — dùng cho trigger thủ công.
 *  overrideChatId: nếu trigger từ chat khác (nhóm), gửi kết quả về đó thay vì schedule.chat_id */
export async function runScheduleNow(botApi: Api, scheduleId: string, overrideChatId?: number): Promise<boolean> {
  const data = loadSchedules();
  const schedule = data.schedules.find(s => s.id === scheduleId && s.enabled);
  if (!schedule) return false;

  const targetChatId = overrideChatId ?? schedule.chat_id;
  const now = new Date();
  try {
    if (schedule.claude_query) {
      await botApi.sendMessage(targetChatId, `⏳ Đang tổng hợp <b>${schedule.name}</b>...`, { parse_mode: "HTML" });
      const response = await runClaudeQuery(schedule);
      await sendToChats(botApi, [targetChatId], response);
      saveLastNewsletter(schedule.id, response);
    } else {
      await botApi.sendMessage(targetChatId, schedule.message, { parse_mode: "HTML" });
    }
    schedule.last_run = now.toISOString();
    saveSchedules(data);
    return true;
  } catch (e) {
    console.error(`[scheduler] Manual fire failed "${schedule.name}":`, e);
    return false;
  }
}

export function getSchedulesSummary(): string {
  const data = loadSchedules();
  if (data.schedules.length === 0) return "Chưa có lịch nào.";

  const lines = data.schedules.map((s) => {
    const status = s.enabled ? "✅" : "❌";
    const nextRun = s.enabled
      ? new Date(s.next_run).toLocaleString("vi-VN", {
          timeZone: "Asia/Ho_Chi_Minh",
          dateStyle: "short",
          timeStyle: "short",
        })
      : "—";
    const repeat = s.recurrence
      ? `🔄 ${formatRecurrence(s.recurrence)}`
      : "1 lần";
    return `${status} <b>${s.name}</b>\n   ${repeat} | Lần tới: ${nextRun}\n   ID: <code>${s.id}</code>`;
  });

  return `<b>Danh sách lịch (${data.schedules.length}):</b>\n\n` + lines.join("\n\n");
}

function formatRecurrence(r: Recurrence): string {
  const tz = r.timezone || "Asia/Ho_Chi_Minh";
  if (r.type === "interval") return `Mỗi ${r.interval_minutes} phút`;
  if (r.type === "daily") return `Hàng ngày lúc ${r.time} (${tz})`;
  if (r.type === "weekly") {
    const days = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
    return `Hàng tuần ${days[r.day ?? 0]} lúc ${r.time} (${tz})`;
  }
  return "Không rõ";
}
