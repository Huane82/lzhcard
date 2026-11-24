@echo off
chcp 65001 > nul
title LZHCard - 打包 Windows 安裝版 (.exe)

echo ==========================================
echo   正在準備打包 Windows 標準安裝版 (.exe)...
echo ==========================================

if exist "%~dp0desktop-widget" (
    cd /d "%~dp0desktop-widget"
) else if exist "D:\lzhcard\desktop-widget" (
    cd /d "D:\lzhcard\desktop-widget"
) else (
    echo [錯誤] 找不到 desktop-widget 資料夾！
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [提示] 正在安裝基礎套件...
    call npm install
)

if not exist "node_modules\.bin\electron-builder.cmd" (
    echo [提示] 正在自動安裝 electron-builder 打包工具...
    call npm install -D electron-builder
)

echo.
echo [執行] 正在打包 Windows 安裝精靈 .exe（支援安裝與解除安裝）...
call npx electron-builder --win nsis -c.win.signAndEditExecutable=false

if %errorlevel% neq 0 (
    echo.
    echo [失敗] 打包過程發生錯誤！若先前有開啟桌面小工具，請先關閉後再重試。
    pause
    exit /b 1
)

echo.
echo ==========================================
echo   ✅ 安裝版打包完成！正在自動開啟輸出資料夾...
echo ==========================================
if exist "dist-widget" (
    start "" "dist-widget"
) else if exist "dist" (
    start "" "dist"
)
pause