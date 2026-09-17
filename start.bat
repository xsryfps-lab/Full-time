@echo off
cd /d "%~dp0"
title Full-Time

if not exist "node_modules" (
  echo ============================================
  echo First-time setup: installing dependencies...
  echo This may take a minute or two.
  echo ============================================
  call npm install
  echo.
)

if not exist ".env" (
  echo ============================================
  echo No .env file found - creating one from the template.
  echo ============================================
  copy .env.example .env >nul
  echo.
  echo Opening Notepad with your new .env file now.
  echo   1. Set MONGODB_URI ^(see the comments in the file for a free setup guide^)
  echo   2. Fill in your API keys ^(EXA, COHERE, GEMINI^)
  echo   3. Save ^(Ctrl+S^) and close Notepad
  echo.
  notepad .env
  echo.
  echo Once you've saved and closed .env, press any key to start the server.
  pause >nul
)

echo ============================================
echo Starting Full-Time...
echo Once you see "running at http://localhost:3000", open that link in your browser.
echo Press Ctrl+C in this window to stop the server.
echo ============================================
echo.
call npm start

pause
