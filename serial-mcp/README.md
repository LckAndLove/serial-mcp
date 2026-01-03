# serial-mcp

MCP Server for serial port communication.

## Installation

```bash
npm install
```

## Start MCP Server

```bash
npm run start
```

## Claude Desktop Configuration

Add the following to your Claude Desktop config file at `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "serial-mcp": {
      "command": "node",
      "args": ["D:/LCK/COM/serial-mcp/server.js"],
      "env": {}
    }
  }
}
```

## Claude Code Configuration

Add the following to your Claude Code settings file at `%APPDATA%\Claude\projects\<project-id>\settings.json`:

```json
{
  "mcpServers": {
    "serial-mcp": {
      "command": "node",
      "args": ["D:/LCK/COM/serial-mcp/server.js"],
      "env": {}
    }
  }
}
```

## Complete claude_desktop_config.json Example

```json
{
  "mcpServers": {
    "serial-mcp": {
      "command": "node",
      "args": ["D:/LCK/COM/serial-mcp/server.js"],
      "env": {}
    }
  }
}
```
