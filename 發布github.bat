@echo off
chcp 65001 > nul
cd /d D:\lzhcard

echo ==================================================
echo   準備將測試完成的程式碼正式推送至 GitHub
echo ==================================================
echo.
set /p msg=請輸入這次的更新說明 (直接按 Enter 預設為「更新網頁內容」): 
if "%msg%"=="" set msg=更新網頁內容

git add .
git commit -m "%msg%"
git push -u origin main

echo.
echo 推送完成！GitHub 與線上網頁已同步為最新正式版。
pause