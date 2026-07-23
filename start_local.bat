@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
set "APP_FILE=%~dp0app.py"
set "LOCAL_URL=http://127.0.0.1:5000"

if not exist "%PYTHON_EXE%" (
  echo .venv\Scripts\python.exe が見つかりません。
  echo 先にこのプロジェクト内の .venv を準備してください。
  pause
  exit /b 1
)

if not exist "%APP_FILE%" (
  echo app.py が見つかりません。
  echo このバッチをリポジトリ直下に置いて実行してください。
  pause
  exit /b 1
)

echo v7 Direct Writer Web版 ローカルサーバーを起動します。
echo URL: %LOCAL_URL%
echo 終了するには、この画面で Ctrl+C を押してください。
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%LOCAL_URL%'"

"%PYTHON_EXE%" "%APP_FILE%"

echo.
echo サーバーが終了しました。
pause
