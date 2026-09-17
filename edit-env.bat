@echo off
cd /d "%~dp0"
if not exist ".env" (
  echo No .env file yet - run start.bat first.
  pause
  exit
)
notepad .env
