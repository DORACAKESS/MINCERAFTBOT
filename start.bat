@echo off
cd /d "%~dp0"
title Minecraft Bot - Dashboard

rem --- Read the port from .env (defaults to 3000) ---
set PORT=3000
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)

echo.
echo  ==========================================
echo    Minecraft Bot Dashboard
echo  ==========================================
echo.
echo  Dashboard will open at:  http://localhost:%PORT%
echo  Press Ctrl+C to stop the bot and close the dashboard.
echo.
echo  Auto-restart is ON: saving a file in src/ or public/ will restart the server.
echo  (Disable it by setting AUTO_RESTART=off in .env)
call npm start
echo.
echo  Dashboard closed.
pause
