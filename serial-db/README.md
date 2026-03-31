# Serial DB

## Requirements

- Node.js >= 22

## How to Start

From the `serial-db` directory, install dependencies and start the listener:

```bash
npm ci
npm run start
```

## Overview

`listener.js` starts a local HTTP control service at `http://127.0.0.1:7070` by default. Set `http.port` in `config.json` to change the port. The listener generates a token at startup, writes it to `~/.serial-mcp/listener.token`, and requires its value in the `Authorization: Bearer <token>` header.

The service manages one or more serial ports dynamically through `POST /connect`, `POST /disconnect`, `POST /send`, `POST /session`, and `GET /status`. It persists received (RX) and transmitted (TX) frames in SQLite.

## Database File Location

The listener stores its database at `~/.serial-mcp/serial.db`.

When you instantiate `SerialDB` from `db.js` without passing a path, it uses `db.path` from the adjacent `config.json`. Relative paths resolve from the `serial-db` directory. The fallback is `./serial.db` in that directory.

## How to View Database Content

- **sqlite3 command line**

  ```bash
  sqlite3 "$HOME/.serial-mcp/serial.db"
  ```

  To inspect the schema and view stored frames, enter:

  ```sql
  .schema serial_data
  SELECT * FROM serial_data;
  ```

- **DB Browser for SQLite**. Open `~/.serial-mcp/serial.db` in [DB Browser for SQLite](https://sqlitebrowser.org/), replacing `~` with your home directory if needed.

## Database Table Structure

`db.js` enables SQLite write-ahead logging (`journal_mode = WAL`) and sets `busy_timeout = 5000` milliseconds on the connection. The `serial_data` table has seven fields.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `INTEGER` | Primary key, auto-increment |
| `port` | `TEXT` | Serial port path (e.g. `COM3`, `/dev/ttyUSB0`) |
| `timestamp` | `INTEGER` | Unix timestamp in milliseconds |
| `direction` | `TEXT` | `rx` (received) or `tx` (sent) |
| `raw` | `BLOB` | Raw binary frame bytes |
| `text` | `TEXT` | UTF-8 decoded text (or `[HEX] ...` for binary RX data) |
| `session_id` | `TEXT` | Session UUID used to group data across resets or firmware flashes |
