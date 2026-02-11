import { fileURLToPath } from "node:url";
import path from "node:path";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const portFilterRaw = process.argv[2];
const portFilter = typeof portFilterRaw === "string" && portFilterRaw.trim() !== ""
  ? portFilterRaw.trim()
  : null;

const dbPath = path.resolve(__dirname, "../serial-db/serial.db");
const db = new Database(dbPath, { readonly: true });

const latest = db.prepare("SELECT id FROM serial_data ORDER BY id DESC LIMIT 1").get();
let lastId = latest?.id ?? 0;

const query = db.prepare(`
  SELECT id, port, direction, text, timestamp
  FROM serial_data
  WHERE id > ?
    AND (port = ? OR ? IS NULL)
  ORDER BY id ASC
`);

const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

function formatTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function printRow(row) {
  const isTx = row.direction === "tx";
  const prefix = isTx ? "→" : "←";
  const color = isTx ? YELLOW : GREEN;
  const text = row.text ?? "";
  const line = `[${formatTime(row.timestamp)}] [${row.port}] ${prefix} ${text}`;
  process.stdout.write(`${color}${line}${RESET}\n`);
}

process.stdout.write(`串口监控已启动。${portFilter ? `仅显示 ${portFilter}` : "显示所有串口"}\n`);
process.stdout.write("关闭此窗口即停止监控。\n");

const timer = setInterval(() => {
  try {
    const rows = query.all(lastId, portFilter, portFilter);
    if (!rows.length) return;
    for (const row of rows) {
      lastId = row.id;
      printRow(row);
    }
  } catch (err) {
    process.stderr.write(`[monitor error] ${err?.message || String(err)}\n`);
  }
}, 200);

function shutdown() {
  clearInterval(timer);
  try {
    db.close();
  } catch {
    // ignore close errors
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

process.on("exit", shutdown);
