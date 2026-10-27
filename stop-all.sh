#!/usr/bin/env bash
set -euo pipefail

# 停止本项目启动的 Node 进程（通过匹配命令参数，不影响系统其他 Node 进程）
pids=$(pgrep -f "node .*(serial-virtual|serial-db|serial-mcp)" 2>/dev/null || true)

if [ -n "$pids" ]; then
  echo "Stopping Serial MCP processes (PIDs: $(echo $pids | tr '\n' ' '))..."
  kill $pids 2>/dev/null || true
  sleep 1
  remaining=$(pgrep -f "node .*(serial-virtual|serial-db|serial-mcp)" 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    kill -9 $remaining 2>/dev/null || true
  fi
  echo "Serial MCP processes stopped."
else
  echo "No running Serial MCP processes found."
fi
