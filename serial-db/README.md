# Serial DB

## How to Start

```bash
npm run start
```

## Overview

`listener.js` connects to COM11, listens for serial data, and writes it into a SQLite database.

## Database File Location

The database file is located at:

```
./serial.db
```

## How to View Database Content

You can view the database content using:

- **sqlite3 command line**:
  ```bash
  sqlite3 ./serial.db
  ```
  Then run SQL queries such as:
  ```sql
  .tables
  SELECT * FROM serial_data;
  .schema serial_data
  ```

- **DB Browser for SQLite**: Download from https://sqlitebrowser.org/ and open `./serial.db`.

## Database Table Structure

The `serial_data` table has the following fields:

| Field      | Type     | Description                     |
|------------|----------|----------------------------------|
| id         | INTEGER  | Primary key, auto-increment     |
| timestamp  | TEXT     | ISO 8601 timestamp when data was received |
| raw        | TEXT     | Raw serial data string          |

