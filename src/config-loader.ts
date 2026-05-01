/**
 * Bot configuration loader and runtime mode manager.
 *
 * Reads config/config.yaml on each call (no restart needed to reload).
 * Runtime mode changes via setMode() persist until bot restart.
 */

import { readFileSync, existsSync, appendFileSync } from "fs";
import { resolve } from "path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { SAFETY_PROMPT, WORKING_DIR, MCP_SERVERS, ALLOWED_PATHS } from "./config";

const BOT_ROOT = resolve(import.meta.dir, "..");

export type Mode = "stable" | "beta" | "compare";

// Runtime state — resets on bot restart; config.yaml is the startup default
let runtimeMode: Mode | null = null;

export const BOT_START_TIME = Date.now();

// ── YAML parser (handles 2-level indent, no deps) ──────────────────────────

function parseScalar(v: string): string | number | boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !isNaN(Number(v))) return Number(v);
  return v;
}

function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let section = "";

  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (!line || line.trimStart().startsWith("#")) continue;

    if (/^\S/.test(line)) {
      const ci = line.indexOf(":");
      if (ci === -1) continue;
      const key = line.slice(0, ci).trim();
      const val = line.slice(ci + 1).trim().replace(/^["']|["']$/g, "");
      if (!val) {
        result[key] = {};
        section = key;
      } else {
        result[key] = parseScalar(val);
        section = "";
      }
    } else if (section) {
      const trimmed = line.trimStart();
      const ci = trimmed.indexOf(":");
      if (ci === -1) continue;
      const key = trimmed.slice(0, ci).trim();
      const val = trimmed.slice(ci + 1).trim().replace(/^["']|["']$/g, "");
      (result[section] as Record<string, unknown>)[key] = parseScalar(val);
    }
  }
  return result;
}

function loadConfig(): Record<string, unknown> {
  const p = resolve(BOT_ROOT, "config/config.yaml");
  if (!existsSync(p)) return { mode: "stable" };
  try {
    return parseSimpleYaml(readFileSync(p, "utf-8"));
  } catch {
    return { mode: "stable" };
  }
}

// ── Mode management ────────────────────────────────────────────────────────

export function getMode(): Mode {
  if (runtimeMode !== null) return runtimeMode;
  return (loadConfig().mode as Mode) || "stable";
}

export function setMode(mode: Mode): void {
  runtimeMode = mode;
  console.log(`[mode] changed to: ${mode}`);
}

// ── Beta message helpers ───────────────────────────────────────────────────

function getBetaPrefix(): string {
  return ((loadConfig().beta as Record<string, unknown>)?.trigger_prefix as string) || "/beta";
}

export function isBetaMessage(text: string): boolean {
  const prefix = getBetaPrefix();
  const t = text.trimStart();
  return t.startsWith(prefix + " ") || t === prefix;
}

export function stripBetaPrefix(text: string): string {
  const prefix = getBetaPrefix() + " ";
  const t = text.trimStart();
  return t.startsWith(prefix) ? t.slice(prefix.length).trimStart() : text;
}

export function shouldTagBetaReply(): boolean {
  return ((loadConfig().beta as Record<string, unknown>)?.tag_reply as boolean) !== false;
}

// ── System prompt for beta mode ────────────────────────────────────────────

export function getBetaSystemPrompt(): string {
  const cfg = loadConfig().beta as Record<string, unknown>;
  const file = (cfg?.system_prompt_file as string) || "agents/ceo.md";
  const p = resolve(BOT_ROOT, file);
  if (!existsSync(p)) {
    console.warn(`[config-loader] beta prompt file not found: ${p}`);
    return SAFETY_PROMPT;
  }
  return readFileSync(p, "utf-8") + "\n\n---\n\n" + SAFETY_PROMPT;
}

// ── Compare log ────────────────────────────────────────────────────────────

export function getCompareLogPath(): string {
  const cfg = loadConfig().compare as Record<string, unknown>;
  const file = (cfg?.log_file as string) || "data/compare-log.json";
  return resolve(BOT_ROOT, file);
}

export function appendCompareLog(entry: {
  input: string;
  stable: { response: string; latency_ms: number };
  beta: { response: string; latency_ms: number; dept_routed?: string };
}): void {
  const logPath = getCompareLogPath();
  const record = { timestamp: new Date().toISOString(), ...entry };
  try {
    appendFileSync(logPath, JSON.stringify(record) + "\n", "utf-8");
  } catch (e) {
    console.warn("[config-loader] failed to write compare log:", e);
  }
}

// ── Dept system prompt ─────────────────────────────────────────────────────

const VALID_DEPTS = ["it", "hr", "marketing", "finance", "pm", "van_hanh", "tham_dinh"];

export function getDeptSystemPrompt(dept: string): string {
  if (!VALID_DEPTS.includes(dept)) return getBetaSystemPrompt();
  const p = resolve(BOT_ROOT, `agents/${dept}.md`);
  if (!existsSync(p)) {
    console.warn(`[config-loader] dept prompt not found: ${p}`);
    return SAFETY_PROMPT;
  }
  return readFileSync(p, "utf-8") + "\n\n---\n\n" + SAFETY_PROMPT;
}

// ── CEO routing query (Phase 2) ────────────────────────────────────────────

export async function runCeoRoutingQuery(
  message: string
): Promise<string> {
  const parts: string[] = [];
  const systemPrompt = getBetaSystemPrompt();
  const cfg = loadConfig().beta as Record<string, unknown>;
  const model = (cfg?.model as string) || "claude-opus-4-7";

  const routingPrompt = `Route the following request. Return ONLY valid JSON, no explanation.\n\nRequest: ${message}`;

  const options: Options = {
    model,
    cwd: WORKING_DIR,
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt,
    additionalDirectories: ALLOWED_PATHS,
  };

  if (process.env.CLAUDE_CODE_PATH) {
    options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
  }

  try {
    for await (const event of query({ prompt: routingPrompt, options })) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") parts.push(block.text);
        }
      }
    }
  } catch (e) {
    console.warn("[config-loader] CEO routing query error:", e);
  }

  return parts.join("");
}

// ── Silent beta query (for compare mode) ──────────────────────────────────

export async function runSilentBetaQuery(
  message: string
): Promise<{ response: string; latency_ms: number; dept_routed?: string }> {
  const start = Date.now();
  const responseParts: string[] = [];
  const systemPrompt = getBetaSystemPrompt();
  const cfg = loadConfig().beta as Record<string, unknown>;
  const model = (cfg?.model as string) || "claude-opus-4-7";

  const options: Options = {
    model,
    cwd: WORKING_DIR,
    settingSources: ["user", "project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt,
    mcpServers: MCP_SERVERS,
    additionalDirectories: ALLOWED_PATHS,
  };

  if (process.env.CLAUDE_CODE_PATH) {
    options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
  }

  try {
    const queryInstance = query({ prompt: message, options });
    for await (const event of queryInstance) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") responseParts.push(block.text);
        }
      }
    }
  } catch (e) {
    console.warn("[config-loader] silent beta query error:", e);
  }

  const response = responseParts.join("") || "";
  const latency_ms = Date.now() - start;

  // Try to extract dept from CEO JSON response
  let dept_routed: string | undefined;
  try {
    const match = response.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      dept_routed = parsed?.dept || undefined;
    }
  } catch { /* ignore parse errors */ }

  return { response, latency_ms, dept_routed };
}
