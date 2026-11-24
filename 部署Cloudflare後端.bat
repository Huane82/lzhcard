@echo off
chcp 65001 > nul
title LZHCard - 部署 Cloudflare Worker

echo ==========================================
echo   正在準備部署 Cloudflare Worker 後端...
echo ==========================================

if exist "%~dp0cloudflare-worker" (
    cd /d "%~dp0cloudflare-worker"
) else if exist "D:\lzhcard\cloudflare-worker" (
    cd /d "D:\lzhcard\cloudflare-worker"
) else (
    echo [錯誤] 找不到 cloudflare-worker 資料夾！
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [提示] 偵測到尚未安裝套件，正在自動執行 npm install...
    call npm install
)

echo.
echo [執行] 正在上傳最新程式碼至 Cloudflare...
call npx wrangler deploy

if %errorlevel% neq 0 (
    echo.
    echo [失敗] 部署發生錯誤！若尚未登入帳號，請在 CMD 執行 npx wrangler login。
    pause
    exit /b 1
)

echo.
echo ==========================================
echo   ✅ Cloudflare Worker 部署完成！
echo ==========================================
pause