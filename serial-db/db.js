const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

/**
 * 串口数据 SQLite 封装
 * - 默认数据库文件：当前目录下 serial_data.db
 * - 初始化时自动创建 serial_data 表
 */
class SerialDB {
  constructor(dbPath = path.join(__dirname, 'serial_data.db')) {
    // 打开数据库连接；better-sqlite3 为同步 API，适合本地高频小数据写入
    this.db = new Database(dbPath);

    // 创建表（若不存在）
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

    // 可选索引：提升按 session_id 与时间范围查询性能
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_serial_data_session_id ON serial_data(session_id);
      CREATE INDEX IF NOT EXISTS idx_serial_data_timestamp ON serial_data(timestamp);
    `);

    // 预编译插入语句，避免重复解析 SQL
    this.insertStmt = this.db.prepare(`
      INSERT INTO serial_data (port, timestamp, direction, raw, text, session_id)
      VALUES (@port, @timestamp, @direction, @raw, @text, @session_id)
    `);
  }

  /**
   * 插入一行串口数据
   * @param {Object} data
   * @param {string} data.port
   * @param {number} data.timestamp 毫秒时间戳
   * @param {'rx'|'tx'|string} data.direction
   * @param {Buffer|Uint8Array|null} data.raw 原始字节数据
   * @param {string|null} data.text 文本解析结果
   * @param {string} data.session_id
   * @returns {{id:number, changes:number}}
   */
  insertRow(data) {
    const row = {
      port: data?.port ?? null,
      timestamp: data?.timestamp ?? Date.now(),
      direction: data?.direction ?? null,
      raw: data?.raw ?? null,
      text: data?.text ?? null,
      session_id: data?.session_id ?? null
    };

    const result = this.insertStmt.run(row);
    return { id: Number(result.lastInsertRowid), changes: result.changes };
  }

  /**
   * 查询数据
   * @param {Object} [options]
   * @param {string} [options.session_id] 会话 ID 过滤
   * @param {number} [options.startTimestamp] 起始毫秒时间戳（包含）
   * @param {number} [options.endTimestamp] 结束毫秒时间戳（包含）
   * @param {number} [options.limit] 返回条数上限
   * @returns {Array}
   */
  queryRows(options = {}) {
    const where = [];
    const params = {};

    // 按会话过滤
    if (options.session_id != null) {
      where.push('session_id = @session_id');
      params.session_id = options.session_id;
    }

    // 按时间范围过滤（毫秒时间戳）
    if (options.startTimestamp != null) {
      where.push('timestamp >= @startTimestamp');
      params.startTimestamp = options.startTimestamp;
    }
    if (options.endTimestamp != null) {
      where.push('timestamp <= @endTimestamp');
      params.endTimestamp = options.endTimestamp;
    }

    let sql = 'SELECT id, port, timestamp, direction, raw, text, session_id FROM serial_data';
    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }

    // 默认按时间倒序、id 倒序返回最新数据
    sql += ' ORDER BY timestamp DESC, id DESC';

    if (options.limit != null) {
      sql += ' LIMIT @limit';
      params.limit = Number(options.limit);
    }

    return this.db.prepare(sql).all(params);
  }

  /**
   * 删除最老数据，最多保留 maxRows 条
   * @param {number} maxRows
   * @returns {number} 实际删除条数
   */
  cleanup(maxRows) {
    const keep = Number(maxRows);
    if (!Number.isFinite(keep) || keep < 0) {
      throw new Error('cleanup(maxRows) 参数无效，maxRows 必须是 >= 0 的数字');
    }

    const total = this.db.prepare('SELECT COUNT(*) AS c FROM serial_data').get().c;
    const toDelete = total - keep;
    if (toDelete <= 0) return 0;

    // 删除最老的 N 条（按 timestamp、id 升序）
    const result = this.db.prepare(`
      DELETE FROM serial_data
      WHERE id IN (
        SELECT id FROM serial_data
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
      )
    `).run(toDelete);

    return result.changes;
  }

  /**
   * 生成新的会话 ID（UUID v4）
   * @returns {string}
   */
  newSession() {
    return crypto.randomUUID();
  }

  /**
   * 关闭数据库连接
   */
  close() {
    this.db.close();
  }
}

module.exports = SerialDB;

