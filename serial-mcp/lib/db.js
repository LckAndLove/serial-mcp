import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const DATA_DIR = path.join(os.homedir(), '.serial-mcp');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'serial.db');

class SerialDB {
  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);

    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS serial_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        port TEXT,
        timestamp INTEGER,
        direction TEXT,
        raw BLOB,
        text TEXT,
        session_id TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_serial_data_session_id ON serial_data(session_id);
      CREATE INDEX IF NOT EXISTS idx_serial_data_timestamp ON serial_data(timestamp);
    `);

    this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_serial_data_poll
      ON serial_data (session_id, direction, timestamp, id)
    `).run();

    this.insertStmt = this.db.prepare(`
      INSERT INTO serial_data (port, timestamp, direction, raw, text, session_id)
      VALUES (@port, @timestamp, @direction, @raw, @text, @session_id)
    `);
  }

  insertRow(data = {}) {
    const row = {
      port: data.port ?? null,
      timestamp: data.timestamp ?? Date.now(),
      direction: data.direction ?? null,
      raw: data.raw ?? null,
      text: data.text ?? null,
      session_id: data.session_id ?? null
    };

    const result = this.insertStmt.run(row);
    return {
      id: Number(result.lastInsertRowid),
      changes: result.changes
    };
  }

  queryRows(options = {}) {
    const where = [];
    const params = {};

    if (options.session_id != null) {
      where.push('session_id = @session_id');
      params.session_id = options.session_id;
    }

    const timestampStart = options.timestampStart ?? options.startTimestamp;
    const timestampEnd = options.timestampEnd ?? options.endTimestamp;

    if (timestampStart != null) {
      where.push('timestamp >= @timestampStart');
      params.timestampStart = Number(timestampStart);
    }
    if (timestampEnd != null) {
      where.push('timestamp <= @timestampEnd');
      params.timestampEnd = Number(timestampEnd);
    }

    let sql = 'SELECT id, port, timestamp, direction, raw, text, session_id FROM serial_data';
    if (where.length) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }
    sql += ' ORDER BY timestamp DESC, id DESC';

    if (options.limit != null) {
      sql += ' LIMIT @limit';
      params.limit = Math.max(0, Number(options.limit) || 0);
    }

    return this.db.prepare(sql).all(params);
  }

  cleanup(maxRows) {
    const keep = Number(maxRows);
    if (!Number.isFinite(keep) || keep < 0) {
      throw new Error('maxRows 必须是大于等于 0 的数字');
    }

    const count = this.db.prepare('SELECT COUNT(*) as n FROM serial_data').get().n;
    if (count <= keep) {
      return 0;
    }

    const result = this.db
      .prepare('DELETE FROM serial_data WHERE id IN (SELECT id FROM serial_data ORDER BY id ASC LIMIT ?)')
      .run(count - keep);

    return result.changes;
  }

  newSession() {
    return crypto.randomUUID();
  }

  close() {
    this.db.close();
  }
}

export default SerialDB;
