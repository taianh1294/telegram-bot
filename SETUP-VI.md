# Hướng dẫn cài Trợ lý XECA cho team

Bot Telegram cá nhân chạy trên macOS, dùng Claude Code làm engine. Fork từ
[`linuz90/claude-telegram-bot`](https://github.com/linuz90/claude-telegram-bot)
với 1 số tính năng riêng cho team XECA.

## Thay đổi so với upstream

- **Group filter** — bot chỉ phản hồi trong group khi bị `@mention` hoặc reply
  ([`src/group-filter.ts`](src/group-filter.ts)). Chat 1-1 vẫn dùng allowlist gốc.
- **Quiet mode** — `QUIET_MODE=true` → bot ẩn mọi `Tool: ...`, `🔎 Searching`,
  `📖 Reading`. Chỉ gửi 1 tin "🤔 đang xử lý..." rồi edit thành câu trả lời cuối.
- **Auto-resume session** — sau mỗi lần restart bot tự nối tiếp cuộc trò chuyện
  gần nhất, không cần `/resume` thủ công.
- **HTTP timeout 60s** — fail fast khi đổi wifi/sleep, polling Telegram phục hồi
  trong vòng 1 phút thay vì 9 phút.
- **Block tự sát** — bot tự refuse các lệnh `launchctl bootout/kickstart` chính
  nó, `curl /getUpdates`, `pkill bun` (xem `BLOCKED_PATTERNS` trong
  [`src/config.ts`](src/config.ts)).
- **Multi-instance** — `SESSION_FILE`, `RESTART_FILE`, `TEMP_DIR`,
  `AUDIT_LOG_PATH` đều có thể override qua env để chạy 2+ bot trên cùng máy.

## Yêu cầu

- macOS (Apple Silicon hoặc Intel)
- [Bun](https://bun.sh/) ≥ 1.0
- [Claude Code](https://claude.com/product/claude-code) đã đăng nhập (`claude` CLI)
- Telegram bot token từ [@BotFather](https://t.me/BotFather)

## Cài

```bash
git clone https://github.com/toanduc1993-cmd/Bot.git
cd Bot
bun install

cp .env.example .env
# Mở .env, điền:
#   TELEGRAM_BOT_TOKEN     (từ @BotFather)
#   TELEGRAM_ALLOWED_USERS (ID Telegram của bạn — nhắn @userinfobot)
#   CLAUDE_WORKING_DIR     (folder Claude làm việc, có CLAUDE.md riêng của bạn)
```

Test chạy 1 lần:
```bash
bun run start
```

Nhắn `/start` cho bot trên Telegram, thấy phản hồi → ok.

## Chạy như service (auto-start, auto-restart, sống dậy sau wake)

### 1. LaunchAgent

Tạo `~/Library/LaunchAgents/com.team.bot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.team.bot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOURUSER/.bun/bin/bun</string>
        <string>run</string>
        <string>/Users/YOURUSER/path/to/Bot/src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOURUSER/path/to/Bot</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/YOURUSER/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>KeepAlive</key><true/>
    <key>RunAtLoad</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>/tmp/team-bot.log</string>
    <key>StandardErrorPath</key><string>/tmp/team-bot.err</string>
</dict>
</plist>
```

Load:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.team.bot.plist
launchctl print gui/$(id -u)/com.team.bot | grep -E "state|pid"
```

### 2. Restart sạch sau khi sửa code

```bash
launchctl kickstart -k gui/$(id -u)/com.team.bot
```

**Không** dùng `kill <pid>` rồi `bun run` tay — process orphan stdio.

### 3. (Tuỳ chọn) Sleepwatcher — kick bot khi máy wake

Khi đổi wifi hoặc máy ngủ, polling Telegram có thể treo. Sleepwatcher bắt event
wake và kick bot tự động.

```bash
brew install sleepwatcher
brew services start sleepwatcher

cat > ~/.wakeup <<'EOF'
#!/bin/bash
UID_USER=$(id -u $(whoami))
/bin/launchctl kickstart -k "gui/${UID_USER}/com.team.bot"
EOF
chmod +x ~/.wakeup
```

## Cấu hình group chat

Mặc định bot dùng được trong **chat riêng** với người trong `TELEGRAM_ALLOWED_USERS`.
Để dùng trong **group**:

1. **Tắt privacy mode** trong @BotFather:
   - Nhắn `/setprivacy` → chọn bot → `Disable`
2. **Add bot vào group** (sau khi tắt privacy — nếu add từ trước, kick rồi add
   lại để setting áp dụng).
3. **Lấy chat_id của group**: gửi 1 tin trong group (không cần tag), đọc log:
   ```bash
   grep "\[group-filter\]" /tmp/team-bot.log
   # → [group-filter] chat_id=-1001234567890 type=supergroup title="..."
   ```
4. (Tuỳ chọn) Dán chat_id vào `.env`:
   ```bash
   TELEGRAM_GROUP_CHAT_ID=-1001234567890
   ```

Trong group, bot **chỉ phản hồi khi**:
- Tin có `@bot_username` (mention), HOẶC
- Tin reply trực tiếp vào message của bot.

Mọi tin khác bị drop im lặng.

## Tips

- **Quiet mode**: `QUIET_MODE=true` trong `.env` để bot không spam tool calls.
- **Interrupt**: prefix `!` cho tin mới sẽ ngắt query đang chạy ngay
  (vd: `!ngừng, làm task khác`).
- **Stop**: `/stop` để ngắt query hiện tại.
- **New session**: `/new` bắt đầu trò chuyện mới (mất context cũ).
- **Resume**: `/resume` chọn 1 trong 5 session gần nhất để nối tiếp.
- **Status**: `/status` xem bot đang làm gì.

## Logs để debug

```bash
tail -f /tmp/team-bot.log    # stdout (request, response, tool calls)
tail -f /tmp/team-bot.err    # stderr (errors, polling timeouts)
```

## Troubleshooting

**Bot không phản hồi sau đổi wifi/sleep**:
- Cài `sleepwatcher` (xem trên).
- Hoặc kick tay: `launchctl kickstart -k gui/$(id -u)/com.team.bot`.

**Bot trong group không thấy tin**:
- Verify privacy mode tắt: `curl https://api.telegram.org/botTOKEN/getMe` →
  `can_read_all_group_messages: true`.
- Nếu đã tắt nhưng vẫn không thấy → kick bot khỏi group, add lại.

**Claude trả về rỗng (in=0 out=0)**:
- Update SDK: `bun install @anthropic-ai/claude-agent-sdk@latest`.
- Verify `claude` CLI đăng nhập: `claude` (chạy 1 lần và check login).

**`@RawDataBot` thay thế cho debug log**:
- Add @RawDataBot vào group → nó in JSON với chat_id luôn (không cần qua bot mình).
