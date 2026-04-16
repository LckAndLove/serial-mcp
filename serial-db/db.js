const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

/**
 * 读取同目录 config.json 中的 db.path
 * 如果未配置则默认使用 ./serial.db
 */
function resolveDbPath() {
  const configPath = path.join(__dirname, 'config.json');
  let dbPath = './serial.db';

  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      dbPath = config?.db?.path || dbPath;
    }
  } catch (_) {
    // 配置读取失败时使用默认路径，避免启动中断
  }

  return path.resolve(__dirname, dbPath);
}

/**
 * 串口数据数据库封装
 */
class SerialDB {
  constructor(dbPath = resolveDbPath()) {
    // 打开数据库连接
    this.db = new Database(dbPath);

    // 开启 WAL 模式，提高并发读写性能
    this.db.pragma('journal_mode = WAL');

    // 初始化数据表
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

    // 为常用查询字段建立索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_serial_data_session_id ON serial_data(session_id);
      CREATE INDEX IF NOT EXISTS idx_serial_data_timestamp ON serial_data(timestamp);
    `);

    // 预编译插入语句
    this.insertStmt = this.db.prepare(`
      INSERT INTO serial_data (port, timestamp, direction, raw, text, session_id)
      VALUES (@port, @timestamp, @direction, @raw, @text, @session_id)
    `);
  }

  /**
   * 插入一行数据
   * data 字段：port, timestamp, direction, raw, text, session_id
   */
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

  /**
   * 查询数据
   * 支持：
   * - session_id
   * - timestamp 范围（timestampStart/timestampEnd 或 startTimestamp/endTimestamp）
   * - limit
   */
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

  /**
   * 删除最老数据，保留最多 maxRows 条
   */
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
      .prepare(
        'DELETE FROM serial_data WHERE id IN (SELECT id FROM serial_data ORDER BY id ASC LIMIT ?)'
      )
      .run(count - keep);

    return result.changes;
  }

  /**
   * 创建新的会话 ID（UUID v4）
   */
  newSession() {
    return crypto.randomUUID();
  }

  /**
   * 关闭数据库
   */
  close() {
    this.db.close();
  }
}

module.exports = SerialDB;

