@echo off
cd /d "%~dp0"
title Minecraft Bot - Installer
echo.
echo  ==========================================
echo    Minecraft Bot Dashboard - Installer
echo  ==========================================
echo.
echo  Installing dependencies... (this can take a minute)
echo.
rem Use `npm ci` when a lockfile exists so the exact verified versions
rem (mineflayer 4.37.1 etc.) are restored — a plain `npm install` can
rem silently float dependencies and break the bot, like it did before.
if exist package-lock.json (
    call npm ci
) else (
    call npm install
)
if errorlevel 1 (
    echo.
    echo  [ERROR] Installation failed. Make sure Node.js v20 or newer is installed.
    echo          Download it from https://nodejs.org
    echo.
    pause
    exit /b 1
)
echo.
echo  [OK] Dependencies installed successfully!
echo  You can now double-click start.bat to launch the dashboard.
echo.
pause
