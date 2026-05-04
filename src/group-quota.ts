/**
 * Daily per-user quota for routed group chats.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { WORKING_DIR } from "./config";

const GROUP_USAGE_FILE = resolve(WORKING_DIR, "data/group-usage.json");
const QUOTA_TZ = "Asia/Ho_Chi_Minh";

interface GroupUsageFile {
  date: string;
  groups: Record<string, Record<string, number>>;
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
}

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: QUOTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function loadUsage(): GroupUsageFile {
  const today = todayLocal();
  try {
    if (!existsSync(GROUP_USAGE_FILE)) {
      return { date: today, groups: {} };
    }

    const data = JSON.parse(readFileSync(GROUP_USAGE_FILE, "utf-8")) as GroupUsageFile;
    if (data.date !== today) {
      return { date: today, groups: {} };
    }
    return data;
  } catch {
    return { date: today, groups: {} };
  }
}

function saveUsage(data: GroupUsageFile): void {
  const dir = dirname(GROUP_USAGE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(GROUP_USAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function consumeDailyGroupQuota(
  chatId: number,
  userId: number,
  limit: number
): QuotaResult {
  const data = loadUsage();
  const groupKey = String(chatId);
  const userKey = String(userId);

  data.groups[groupKey] ||= {};
  const used = data.groups[groupKey][userKey] || 0;

  if (used >= limit) {
    return { allowed: false, used, remaining: 0, limit };
  }

  const nextUsed = used + 1;
  data.groups[groupKey][userKey] = nextUsed;
  saveUsage(data);

  return {
    allowed: true,
    used: nextUsed,
    remaining: Math.max(0, limit - nextUsed),
    limit,
  };
}
