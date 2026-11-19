@echo off
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=7801
if "%HOST%"=="" set HOST=127.0.0.1
where node >nul 2>nul
if errorlevel 1 ( echo [start] 缺少 node：需要 Node.js 18+ https://nodejs.org & exit /b 1 )
if "%DSH_BIN%"=="" (
  where dsh.cmd >nul 2>nul && set DSH_BIN=dsh.cmd
)
if "%DSH_BIN%"=="" (
  echo [start] 警告：未找到 dsh —— 面板可看可配，但员工无法启动（安装 DSH 或设置 DSH_BIN）
) else (
  echo [start] dsh = %DSH_BIN%
)
echo [start] 面板：http://%HOST%:%PORT%/live
node runtime\server\broker.js --port %PORT% --host %HOST%
