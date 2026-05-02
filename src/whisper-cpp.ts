/**
 * whisper.cpp integration for local speech-to-text.
 *
 * Pipeline: audio file → ffmpeg (WAV 16kHz mono) → whisper.cpp → transcript
 *
 * Env vars:
 *   WHISPER_CPP_PATH  — path to whisper-cli.exe / main.exe
 *   WHISPER_CPP_MODEL — path to .bin model file (ggml-medium.bin recommended)
 *   WHISPER_CPP_LANG  — language code, default "vi"
 *   WHISPER_CPP_THREADS — CPU threads, default 4
 */

import { existsSync, unlinkSync } from "fs";

const WHISPER_CPP_PATH    = process.env.WHISPER_CPP_PATH    || "";
const WHISPER_CPP_MODEL   = process.env.WHISPER_CPP_MODEL   || "";
const WHISPER_CPP_LANG    = process.env.WHISPER_CPP_LANG    || "vi";
const WHISPER_CPP_THREADS = process.env.WHISPER_CPP_THREADS || "4";

export function isWhisperCppAvailable(): boolean {
  return !!(
    WHISPER_CPP_PATH  && existsSync(WHISPER_CPP_PATH) &&
    WHISPER_CPP_MODEL && existsSync(WHISPER_CPP_MODEL)
  );
}

// ── Audio conversion ───────────────────────────────────────────────────────

async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, "_w.wav");
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", inputPath,
     "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg failed (${exitCode}): ${err.slice(0, 200)}`);
  }
  return wavPath;
}

// ── Output parser ──────────────────────────────────────────────────────────

function parseWhisperOutput(raw: string): string {
  return raw
    .split("\n")
    // Remove timestamp markers: [00:00:00.000 --> 00:00:05.000]
    .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, "").trim())
    .filter(l => l && !l.startsWith("WEBVTT") && !/^\d+$/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Main transcription ─────────────────────────────────────────────────────

export async function transcribeWithWhisperCpp(
  filePath: string,
  options: {
    onProgress?: (o: { elapsedSec: number; stderrTail: string }) => void;
    progressIntervalMs?: number;
  } = {}
): Promise<string | null> {
  let wavPath: string | null = null;

  try {
    wavPath = await convertToWav(filePath);

    const args = [
      WHISPER_CPP_PATH,
      "-m", WHISPER_CPP_MODEL,
      "-f", wavPath,
      "-l", WHISPER_CPP_LANG,
      "-t", WHISPER_CPP_THREADS,
      "-np",          // no system/progress prints
      "-nt",          // no timestamps in output
    ];

    const startedAt = Date.now();
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

    // Collect stderr for progress display
    let stderrTail = "";
    const stderrDone = (async () => {
      const reader = proc.stderr.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrTail = (stderrTail + dec.decode(value)).slice(-2048);
      }
    })();

    const tick = options.progressIntervalMs ?? 30000;
    const timer = options.onProgress
      ? setInterval(() => {
          void options.onProgress!({
            elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
            stderrTail,
          });
        }, tick)
      : null;

    try {
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      await stderrDone;

      if (exitCode !== 0) {
        console.error(`[whisper.cpp] exit ${exitCode}: ${stderrTail.slice(0, 200)}`);
        return null;
      }

      const transcript = parseWhisperOutput(stdout);
      console.log(`[whisper.cpp] transcribed ${transcript.length} chars`);
      return transcript || null;
    } finally {
      if (timer) clearInterval(timer);
    }
  } catch (e) {
    console.error("[whisper.cpp] error:", e);
    return null;
  } finally {
    if (wavPath) {
      try { unlinkSync(wavPath); } catch { /* ignore */ }
    }
  }
}
