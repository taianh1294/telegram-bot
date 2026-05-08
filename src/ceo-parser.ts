/**
 * CEO agent response parser.
 *
 * Extracts routing JSON from CEO response and logs decisions
 * to data/routing-log.json for analysis.
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const BOT_ROOT = resolve(import.meta.dir, "..");
const ROUTING_LOG = resolve(BOT_ROOT, "data/routing-log.json");

export type RoutingAction = "route" | "multi" | "clarify" | "handle";

export interface RoutingDecision {
  action: RoutingAction;
  dept: string | null;
  task: string;
  context: string;
  priority: "low" | "normal" | "high";
}

/**
 * Parse CEO routing JSON from response text.
 * Returns null if no valid JSON found — caller should fallback to stable.
 */
export function parseCeoRouting(responseText: string): RoutingDecision | null {
  // Extract first JSON object from response (CEO may add surrounding text)
  const match = responseText.match(/\{[\s\S]*?\}/);
  if (!match) return null;

  try {
    const raw = JSON.parse(match[0]);
    if (!raw.action) return null;

    return {
      action: (raw.action as RoutingAction) || "handle",
      dept: raw.dept || null,
      task: String(raw.task || ""),
      context: String(raw.context || ""),
      priority: raw.priority || "normal",
    };
  } catch {
    return null;
  }
}

export function appendRoutingLog(entry: {
  input: string;
  action: string;
  dept: string | null;
  model_used: string;
  success: boolean;
}): void {
  const record = { timestamp: new Date().toISOString(), ...entry };
  try {
    const dir = dirname(ROUTING_LOG);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(ROUTING_LOG, JSON.stringify(record) + "\n", "utf-8");
  } catch (e) {
    console.warn("[ceo-parser] routing log write failed:", e);
  }
}

/** Human-readable dept label for Telegram display. */
export const DEPT_LABELS: Record<string, string> = {
  it: "IT 💻",
  hr: "HR 👥",
  marketing: "Marketing 📣",
  finance: "Finance 📊",
  pm: "PM 📋",
  van_hanh: "Vận Hành ⚙️",
  tham_dinh: "Thẩm Định 🔍",
  phap_che: "Pháp Chế ⚖️",
};
