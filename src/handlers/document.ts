/**
 * Document handler for Claude Telegram Bot.
 *
 * Supports PDF, Office (docx/xlsx/pptx/xls), EPub, text files, and archives.
 * PDF + Office extraction goes through markitdown CLI (Python venv).
 */

import type { Context } from "grammy";
import { existsSync } from "fs";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR, QUIET_MODE } from "../config";
import { isAuthorized, isAuthorizedInChat, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import {
  StreamingState,
  createStatusCallback,
  setupQuietPlaceholder,
} from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";
import { isAudioFile, processAudioFile } from "./audio";
import { smartExtractPdf } from "../pdf-vision";

// Path to markitdown CLI. Set MARKITDOWN_CLI env nếu install ở venv riêng.
// Mặc định gọi qua PATH — team cài bằng `pipx install markitdown` hoặc
// `pip install markitdown` rồi để PATH tìm.
const MARKITDOWN_CLI = process.env.MARKITDOWN_CLI || "markitdown";

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

// Formats handled by markitdown CLI (converted to Markdown).
const MARKITDOWN_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".xls",
  ".pptx",
  ".epub",
];

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];

// Max file size (50MB)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Max content from archive (50K chars total)
const MAX_ARCHIVE_CONTENT = 50000;

// Create document-specific media group buffer
const documentBuffer = createMediaGroupBuffer({
  emoji: "📄",
  itemLabel: "document",
  itemLabelPlural: "documents",
});

/**
 * Download a document and return the local path.
 */
async function downloadDocument(ctx: Context): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const file = await ctx.getFile();
  const fileName = doc.file_name || `doc_${Date.now()}`;

  // Sanitize filename
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const docPath = `${TEMP_DIR}/${safeName}`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(docPath, buffer);

  return docPath;
}

/**
 * Check if a file should be converted via markitdown CLI.
 */
function isMarkitdownFile(extension: string, mimeType?: string): boolean {
  if (MARKITDOWN_EXTENSIONS.includes(extension)) return true;
  if (mimeType === "application/pdf") return true;
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mimeType === "application/epub+zip"
  ) {
    return true;
  }
  return false;
}

/**
 * Convert a document to Markdown via markitdown CLI.
 */
async function markitdownExtract(filePath: string): Promise<string> {
  if (!existsSync(MARKITDOWN_CLI)) {
    throw new Error(
      `markitdown CLI not found at ${MARKITDOWN_CLI}. Set MARKITDOWN_CLI env var or install: pip install 'markitdown[all]'`
    );
  }
  const proc = Bun.spawn([MARKITDOWN_CLI, filePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`markitdown exit ${exitCode}: ${stderr.slice(0, 200)}`);
  }
  return stdout;
}

/**
 * Extract text from a document.
 */
async function extractText(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF: markitdown first, vision fallback for scanned PDFs
  if (extension === ".pdf" || mimeType === "application/pdf") {
    let markitdownText: string | null = null;
    let markitdownErr: Error | null = null;

    try {
      markitdownText = (await markitdownExtract(filePath)).slice(0, 200000);
    } catch (err) {
      markitdownErr = err instanceof Error ? err : new Error(String(err));
    }

    const { text, method } = await smartExtractPdf(filePath, markitdownText, markitdownErr);
    console.log(`[document] PDF extracted via ${method}: ${text.length} chars`);
    return text.slice(0, 200000);
  }

  // Office / EPub → markitdown CLI only
  if (isMarkitdownFile(extension, mimeType)) {
    try {
      const text = await markitdownExtract(filePath);
      return text.slice(0, 200000);
    } catch (error) {
      console.error("markitdown extraction failed:", error);
      return `[Failed to convert ${extension}: ${String(error).slice(0, 200)}]`;
    }
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    // Limit to 100K chars
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

/**
 * Check if a file extension is an archive.
 */
function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get archive extension from filename.
 */
function getArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return "";
}

/**
 * Extract an archive to a temp directory.
 */
async function extractArchive(
  archivePath: string,
  fileName: string
): Promise<string> {
  const ext = getArchiveExtension(fileName);
  const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
  await Bun.$`mkdir -p ${extractDir}`;

  if (ext === ".zip") {
    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
  } else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
    await Bun.$`tar -xf ${archivePath} -C ${extractDir}`.quiet();
  } else {
    throw new Error(`Unknown archive type: ${ext}`);
  }

  return extractDir;
}

/**
 * Build a file tree from a directory.
 */
async function buildFileTree(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: false })
  );
  entries.sort();
  return entries.slice(0, 100); // Limit to 100 files
}

/**
 * Extract text content from archive files.
 */
async function extractArchiveContent(
  extractDir: string
): Promise<{
  tree: string[];
  contents: Array<{ name: string; content: string }>;
}> {
  const tree = await buildFileTree(extractDir);
  const contents: Array<{ name: string; content: string }> = [];
  let totalSize = 0;

  for (const relativePath of tree) {
    const fullPath = `${extractDir}/${relativePath}`;
    const stat = await Bun.file(fullPath).exists();
    if (!stat) continue;

    // Check if it's a directory
    const fileInfo = Bun.file(fullPath);
    const size = fileInfo.size;
    if (size === 0) continue;

    const ext = "." + (relativePath.split(".").pop() || "").toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) continue;

    // Skip large files
    if (size > 100000) continue;

    try {
      const text = await fileInfo.text();
      const truncated = text.slice(0, 10000); // 10K per file max
      if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
      contents.push({ name: relativePath, content: truncated });
      totalSize += truncated.length;
    } catch {
      // Skip binary or unreadable files
    }
  }

  return { tree, contents };
}

/**
 * Process an archive file.
 */
async function processArchive(
  ctx: Context,
  archivePath: string,
  fileName: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  // Show extraction progress
  const statusMsg = await ctx.reply(`📦 Extracting <b>${fileName}</b>...`, {
    parse_mode: "HTML",
  });

  try {
    // Extract archive
    console.log(`Extracting archive: ${fileName}`);
    const extractDir = await extractArchive(archivePath, fileName);
    const { tree, contents } = await extractArchiveContent(extractDir);
    console.log(`Extracted: ${tree.length} files, ${contents.length} readable`);

    // Update status
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `📦 Extracted <b>${fileName}</b>: ${tree.length} files, ${contents.length} readable`,
      { parse_mode: "HTML" }
    );

    // Build prompt
    const treeStr = tree.length > 0 ? tree.join("\n") : "(empty)";
    const contentsStr =
      contents.length > 0
        ? contents.map((c) => `--- ${c.name} ---\n${c.content}`).join("\n\n")
        : "(no readable text files)";

    const prompt = caption
      ? `Archive: ${fileName}\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}\n\n---\n\n${caption}`
      : `Please analyze this archive (${fileName}):\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}`;

    // Set conversation title (if new session)
    if (!session.isActive) {
      const rawTitle = caption || `[Archivio: ${fileName}]`;
      const title =
        rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
      session.conversationTitle = title;
    }

    // Create streaming state
    const state = new StreamingState();
    state.quietMode = QUIET_MODE;
    const statusCallback = createStatusCallback(ctx, state);
    await setupQuietPlaceholder(ctx, state);

    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(
      userId,
      username,
      "ARCHIVE",
      `[${fileName}] ${caption || ""}`,
      response
    );

    // Cleanup
    await Bun.$`rm -rf ${extractDir}`.quiet();

    // Delete status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore deletion errors
    }
  } catch (error) {
    console.error("Archive processing error:", error);
    // Delete status message on error
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
    await ctx.reply(
      `❌ Failed to process archive: ${String(error).slice(0, 100)}`
    );
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Process documents with Claude.
 */
async function processDocuments(
  ctx: Context,
  documents: Array<{ path: string; name: string; content: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Mark processing started
  const stopProcessing = session.startProcessing();

  // Build prompt
  let prompt: string;
  if (documents.length === 1) {
    const doc = documents[0]!;
    prompt = caption
      ? `Document: ${doc.name}\n\nContent:\n${doc.content}\n\n---\n\n${caption}`
      : `Please analyze this document (${doc.name}):\n\n${doc.content}`;
  } else {
    const docList = documents
      .map((d, i) => `--- Document ${i + 1}: ${d.name} ---\n${d.content}`)
      .join("\n\n");
    prompt = caption
      ? `${documents.length} Documents:\n\n${docList}\n\n---\n\n${caption}`
      : `Please analyze these ${documents.length} documents:\n\n${docList}`;
  }

  // Set conversation title (if new session)
  if (!session.isActive) {
    const docName = documents[0]?.name || "[Documento]";
    const rawTitle = caption || `[Documento: ${docName}]`;
    const title =
      rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
    session.conversationTitle = title;
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  state.quietMode = QUIET_MODE;
  const statusCallback = createStatusCallback(ctx, state);
  await setupQuietPlaceholder(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(
      userId,
      username,
      "DOCUMENT",
      `[${documents.length} docs] ${caption || ""}`,
      response
    );
  } catch (error) {
    await handleProcessingError(ctx, error, state.toolMessages);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Process document paths by extracting text and calling processDocuments.
 */
async function processDocumentPaths(
  ctx: Context,
  paths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Extract text from all documents
  const documents: Array<{ path: string; name: string; content: string }> = [];

  for (const path of paths) {
    try {
      const name = path.split("/").pop() || "document";
      const content = await extractText(path);
      documents.push({ path, name, content });
    } catch (error) {
      console.error(`Failed to extract ${path}:`, error);
    }
  }

  if (documents.length === 0) {
    await ctx.reply("❌ Failed to extract any documents.");
    return;
  }

  await processDocuments(ctx, documents, caption, userId, username, chatId);
}

/**
 * Handle incoming document messages.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId || !doc) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorizedInChat(userId, ctx.chat?.type, ALLOWED_USERS, ctx.chat?.id)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check file size
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 50MB.");
    return;
  }

  // 3. Check file type
  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isMarkdownable = isMarkitdownFile(extension, doc.mime_type);
  const isText =
    TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");
  const isArchiveFile = isArchive(fileName);

  // Check if it's an audio file sent as a document
  if (
    !isMarkdownable &&
    !isText &&
    !isArchiveFile &&
    isAudioFile(fileName, doc.mime_type)
  ) {
    console.log(`Received audio document: ${fileName} from @${username}`);

    // Rate limit check
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    // Download and process as audio
    let docPath: string;
    try {
      docPath = await downloadDocument(ctx);
    } catch (error) {
      console.error("Failed to download audio document:", error);
      await ctx.reply("❌ Failed to download audio file.");
      return;
    }

    await processAudioFile(ctx, docPath, ctx.message?.caption, userId, username, chatId);
    return;
  }

  if (!isMarkdownable && !isText && !isArchiveFile) {
    await ctx.reply(
      `❌ Định dạng file chưa hỗ trợ: ${extension || doc.mime_type}\n\n` +
        `Hỗ trợ: ${MARKITDOWN_EXTENSIONS.join(
          ", "
        )}, archives (${ARCHIVE_EXTENSIONS.join(", ")}), ${TEXT_EXTENSIONS.join(
          ", "
        )}`
    );
    return;
  }

  // 4. Download document
  let docPath: string;
  try {
    docPath = await downloadDocument(ctx);
  } catch (error) {
    console.error("Failed to download document:", error);
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  // 5. Archive files - process separately (no media group support)
  if (isArchiveFile) {
    console.log(`Received archive: ${fileName} from @${username}`);
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    await processArchive(
      ctx,
      docPath,
      fileName,
      ctx.message?.caption,
      userId,
      username,
      chatId
    );
    return;
  }

  // 6. Single document - process immediately
  if (!mediaGroupId) {
    console.log(`Received document: ${fileName} from @${username}`);
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      return;
    }

    try {
      const content = await extractText(docPath, doc.mime_type);
      await processDocuments(
        ctx,
        [{ path: docPath, name: fileName, content }],
        ctx.message?.caption,
        userId,
        username,
        chatId
      );
    } catch (error) {
      console.error("Failed to extract document:", error);
      await ctx.reply(
        `❌ Failed to process document: ${String(error).slice(0, 100)}`
      );
    }
    return;
  }

  // 7. Media group - buffer with timeout
  await documentBuffer.addToGroup(
    mediaGroupId,
    docPath,
    ctx,
    userId,
    username,
    processDocumentPaths
  );
}
