@echo off
setlocal

rem 仅停止本项目启动的 Node 进程，不影响系统中的其他 Node 应用。
powershell -NoProfile -ExecutionPolicy Bypass -Command "$processes = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'serial-(mcp|db|virtual)' }; $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo Serial MCP project processes stopped.
endlocal
