# Claude Code MCP 接入配置

## 配置方式

Claude Code 通过 MCP（Model Context Protocol）连接 serial-mcp 服务器。

## 配置文件路径

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

## 配置内容

```json
{
  "mcpServers": {
    "serial": {
      "command": "node",
      "args": ["D:\LCK\COM\serial-mcp\server.js"],
      "env": {}
    }
  }
}
```

## 启动顺序

1. 先启动 serial-virtual：进入 serial-virtual 目录，执行 `npm run device`
2. 再启动 serial-db：进入 serial-db 目录，执行 `npm run start`
3. 最后启动 Claude Code，MCP 会自动连接 serial-mcp 服务器

## 验证

启动后，在 Claude Code 中输入 `/mcp` 可以查看已连接的 MCP 工具。
