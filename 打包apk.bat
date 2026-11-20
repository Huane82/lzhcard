@echo off
cd /d D:\lzhcard
call npx cap sync android

cd /d D:\lzhcard\android
set "JAVA_HOME=C:\Program Files\Android\openjdk\jdk-21.0.8"
set "GRADLE_USER_HOME=D:\gradle_cache"
call gradlew.bat assembleDebug --no-daemon --max-workers=1
pause