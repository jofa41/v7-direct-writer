@echo off
setlocal

cd /d "%~dp0"

set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
set "APP_FILE=%~dp0app.py"
set "LOCAL_URL=http://127.0.0.1:5000"

if not exist "%PYTHON_EXE%" (
  echo .venv\Scripts\python.exe was not found.
  echo Prepare the project .venv before running this script.
  pause
  exit /b 1
)

if not exist "%APP_FILE%" (
  echo app.py was not found.
  echo Place this batch file in the repository root and run it there.
  pause
  exit /b 1
)

echo Starting v7 Direct Writer local server.
echo URL: %LOCAL_URL%
echo Press Ctrl+C in this window to stop the server.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%LOCAL_URL%'"

"%PYTHON_EXE%" "%APP_FILE%"

echo.
echo Server stopped.
pause
