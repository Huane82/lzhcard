@echo off
chcp 65001 > nul
cd /d D:\lzhcard

echo [測試部署] 正在將 www 最新網頁直接部署至 Firebase...
call firebase deploy

echo.
echo ==================================================
echo   Firebase 測試部署完成！請開啟網頁確認功能。
echo   (確認無誤後，再執行「github發布.bat」正式存檔)
echo ==================================================
pause