@echo off
echo 停止所有 Node 进程...
taskkill /f /im node.exe >nul 2>&1
echo ✅ 已停止
pause
