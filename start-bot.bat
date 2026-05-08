@echo off
cd /d "E:\Powerful Assistant\projects\TelegramBot"
set LOGS_DIR=E:\Powerful Assistant\logs
if not exist "%LOGS_DIR%" mkdir "%LOGS_DIR%"

for /f "tokens=1,2 delims==" %%A in ('type .env ^| findstr /v "^#" ^| findstr "="') do set %%A=%%B

"C:\Users\Dell\.bun\bin\bun.exe" run src/index.ts >> "%LOGS_DIR%\bot.log" 2>> "%LOGS_DIR%\bot.err"
