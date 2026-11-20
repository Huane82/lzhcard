@echo off
chcp 65001 >nul
cd /d D:\lzhcard

echo [1/3] 正在同步網頁資源至 Android 專案...
call npx cap sync android

if exist "assets\icon.png" (
    echo [2/3] 偵測到 assets\icon.png，正在生成 App 圖示...
    call npx @capacitor/assets generate --android
) else (
    echo [2/3] 未找到 D:\lzhcard\assets\icon.png，跳過圖示更新...
)

echo [3/3] 正在打包 Debug APK...
cd /d D:\lzhcard\android
set "JAVA_HOME=C:\Program Files\Android\openjdk\jdk-21.0.8"
set "GRADLE_USER_HOME=D:\gradle_cache"
call gradlew.bat assembleDebug --no-daemon --max-workers=1

echo.
echo 打包流程結束！APK 位置：D:\lzhcard\android\app\build\outputs\apk\debug\app-debug.apk
pause
