#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting serial-virtual device..."
(cd "$SCRIPT_DIR/serial-virtual" && node virtual-device.js) &
VIRTUAL_PID=$!

sleep 2

echo "Starting serial-db listener..."
(cd "$SCRIPT_DIR/serial-db" && node listener.js) &
DB_PID=$!

echo "Serial MCP services started (virtual PID: $VIRTUAL_PID, db PID: $DB_PID)."
echo "Run ./stop-all.sh to terminate these services."
