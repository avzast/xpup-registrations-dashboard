@echo off
chcp 65001 >nul
cd /d "%~dp0app"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.9+ не найден. Установите его с https://www.python.org/downloads/
  pause
  exit /b 1
)
python server.py
pause
