# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run start      # Run the bot
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # Run TypeScript type checking
bun install        # Install dependencies
```

## Architecture

This is a Telegram bot (~3,300 lines TypeScript) that lets you control Claude Code from your phone via text, voice, photos, and documents. Built with Bun and grammY.

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Key Modules

- **`src/index.ts`** - Entry point, registers handlers, starts polling
- **`src/config.ts`** - Environment parsing, MCP loading, safety prompts
- **`src/session.ts`** - `ClaudeSession` class wrapping Agent SDK V2 with streaming, session persistence (`/tmp/claude-telegram-session.json`), and defense-in-depth safety checks
- **`src/security.ts`** - `RateLimiter` (token bucket), path validation, command safety checks
- **`src/formatting.ts`** - Markdown→HTML conversion for Telegram, tool status emoji formatting
- **`src/utils.ts`** - Audit logging, voice transcription (OpenAI), typing indicators
- **`src/types.ts`** - Shared TypeScript types

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:
- **`commands.ts`** - `/start`, `/new`, `/stop`, `/status`, `/resume`, `/restart`, `/retry`
- **`text.ts`** - Text messages with intent filtering
- **`voice.ts`** - Voice→text via OpenAI, then same flow as text
- **`audio.ts`** - Audio file transcription via OpenAI (mp3, m4a, ogg, wav, etc.), also handles audio sent as documents
- **`photo.ts`** - Image analysis with media group buffering (1s timeout for albums)
- **`document.ts`** - PDF extraction (pdftotext CLI), text files, archives, routes audio files to `audio.ts`
- **`video.ts`** - Video messages and video notes
- **`callback.ts`** - Inline keyboard button handling for ask_user MCP
- **`streaming.ts`** - Shared `StreamingState` and status callback factory

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket, configurable)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns)
5. System prompt constraints
6. Audit logging

### Configuration

All config via `.env` (copy from `.env.example`). Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `CLAUDE_WORKING_DIR` - Working directory for Claude
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription

MCP servers defined in `mcp-config.ts`.

### Runtime Files

- `/tmp/claude-telegram-session.json` - Session persistence for `/resume`
- `/tmp/telegram-bot/` - Downloaded photos/documents
- `/tmp/claude-telegram-audit.log` - Audit log

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Adding a message handler**: Create in `handlers/`, export from `index.ts`, register in `index.ts` with appropriate filter

**Streaming pattern**: All handlers use `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()` for live updates.

**Type checking**: Run `bun run typecheck` periodically while editing TypeScript files. Fix any type errors before committing.

**After code changes**: Restart via launchd — it's the supervised way that avoids orphan processes / broken stdio:

```bash
launchctl kickstart -k gui/$(id -u)/com.troly.bot
```

**NEVER** kill the bot PID from inside a chat session and then re-run `bun run src/index.ts` manually — the new process inherits a detached stdio and ends up alive-but-unresponsive. Always use `launchctl kickstart` so launchd owns the restart.

## Standalone Build

The bot can be compiled to a standalone binary with `bun build --compile`. This is used by the ClaudeBot macOS app wrapper.

### External Dependencies

PDF extraction uses `pdftotext` CLI instead of an npm package (to avoid bundling issues):

```bash
brew install poppler  # Provides pdftotext
```

### PATH Requirements

When running as a standalone binary (especially from a macOS app), the PATH may not include Homebrew. The launcher must ensure PATH includes:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)

Without this, `pdftotext` won't be found and PDF parsing will fail silently with an error message.

## Scheduler — Tạo lịch tự động

Bot có hệ thống lịch tự động. File lịch: `E:/Powerful Assistant/data/schedules.json`

### Cách tạo lịch mới

Khi người dùng yêu cầu tạo lịch nhắc nhở, hãy đọc file schedules.json (tạo nếu chưa có), thêm entry mới và lưu lại. **Bắt buộc hỏi `chat_id` nếu chưa biết** — dùng lệnh /status để lấy.

Chat ID của anh Tài Anh: **988275882** (private chat)

### Format JSON

```json
{
  "schedules": [
    {
      "id": "uuid-duy-nhat",
      "name": "Tên lịch ngắn gọn",
      "chat_id": 988275882,
      "message": "Nội dung tin nhắn gửi đến người dùng (có thể dùng HTML: <b>bold</b>)",
      "next_run": "2026-04-30T02:00:00.000Z",
      "recurrence": {
        "type": "daily",
        "time": "09:00",
        "timezone": "Asia/Ho_Chi_Minh"
      },
      "enabled": true,
      "created_at": "2026-04-30T00:00:00.000Z",
      "last_run": null
    }
  ]
}
```

### Các loại lịch (`recurrence`)

| type | Mô tả | Các trường bổ sung |
|------|--------|-------------------|
| *(không có)* | Chạy 1 lần rồi tắt | — |
| `"interval"` | Lặp mỗi N phút | `interval_minutes: number` |
| `"daily"` | Hàng ngày lúc HH:MM | `time: "HH:MM"`, `timezone` |
| `"weekly"` | Hàng tuần | `time`, `timezone`, `day: 0-6` (0=CN) |

### Tính `next_run`

`next_run` là thời điểm UTC tiếp theo. Ví dụ: nhắc lúc 9:00 SA (GMT+7) = `03:00:00Z` hôm đó.

Công thức: `next_run_UTC = local_time - 7h` (với timezone Asia/Ho_Chi_Minh = UTC+7)

### Xóa / tắt lịch

- Tắt tạm: đặt `"enabled": false`
- Xóa hẳn: xóa entry khỏi mảng `schedules`

### Xem lịch

Người dùng gõ `/schedules` để xem tất cả lịch hiện tại.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.

## Running as Service (macOS)

This project is supervised by launchd via `~/Library/LaunchAgents/com.troly.bot.plist`.

```bash
# Restart (preferred way — launchd handles stop/start cleanly)
launchctl kickstart -k gui/$(id -u)/com.troly.bot

# Status
launchctl print gui/$(id -u)/com.troly.bot | grep -E "state|last exit|pid"

# Stop / start (if you really need to)
launchctl bootout   gui/$(id -u)/com.troly.bot
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.troly.bot.plist

# Logs
tail -f /tmp/claude-telegram-bot-ts.log
tail -f /tmp/claude-telegram-bot-ts.err
```
