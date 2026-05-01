/**
 * PDF OCR via Anthropic native document API.
 *
 * Dùng khi markitdown trả về quá ít text (PDF scan / image-based).
 * Gửi PDF dạng base64 trực tiếp đến Claude — không cần convert sang ảnh.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, statSync } from "fs";

// Haiku: nhanh và rẻ, đủ chất lượng cho OCR
const OCR_MODEL = "claude-haiku-4-5-20251001";

// Giới hạn Anthropic API cho PDF document: ~32MB
const MAX_PDF_BYTES = 32 * 1024 * 1024;

// Nếu markitdown trả về ít hơn ngưỡng này thì coi là PDF scan
export const MARKITDOWN_MIN_CHARS = 200;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Extract text from a PDF file using Claude's native vision.
 * Supports both text-based and scanned/image PDFs.
 */
export async function extractPdfWithVision(pdfPath: string): Promise<string> {
  const size = statSync(pdfPath).size;
  if (size > MAX_PDF_BYTES) {
    throw new Error(
      `PDF too large for vision OCR: ${(size / 1024 / 1024).toFixed(1)}MB (max 32MB)`
    );
  }

  const pdfBytes = readFileSync(pdfPath);
  const pdfBase64 = pdfBytes.toString("base64");

  const response = await getClient().messages.create({
    model: OCR_MODEL,
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64,
            },
          } as Anthropic.DocumentBlockParam,
          {
            type: "text",
            text: "Extract all text from this PDF. Return only the text content, preserving paragraphs and structure. Do not add commentary.",
          },
        ],
      },
    ],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Smart extract: markitdown first, vision as fallback for scanned PDFs.
 */
export async function smartExtractPdf(
  pdfPath: string,
  markitdownResult: string | null,
  markitdownError: Error | null
): Promise<{ text: string; method: "markitdown" | "vision" }> {
  // markitdown succeeded and returned enough text → use it
  if (!markitdownError && markitdownResult && markitdownResult.length >= MARKITDOWN_MIN_CHARS) {
    return { text: markitdownResult, method: "markitdown" };
  }

  // Fallback to vision OCR
  console.log(
    `[pdf-vision] markitdown returned ${markitdownResult?.length ?? 0} chars${markitdownError ? ` (error: ${markitdownError.message.slice(0, 60)})` : ""} — trying vision OCR`
  );

  const text = await extractPdfWithVision(pdfPath);
  return { text, method: "vision" };
}
