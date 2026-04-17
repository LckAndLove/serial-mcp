# Contributing

感谢你参与 serial-mcp 的建设。

## 如何提 Issue

1. 先搜索已有 Issue，避免重复。
2. 新建 Issue 时请包含：
   - 使用环境（系统、Node 版本、串口设备）
   - 复现步骤
   - 期望行为与实际行为
   - 日志或截图（如有）
3. Bug 标题建议格式：`[bug] 简要描述`。
4. 功能建议标题建议格式：`[feature] 简要描述`。

## 如何提 PR

1. Fork 本仓库并从 `main` 拉分支。
2. 分支命名建议：
   - `fix/xxx`
   - `feat/xxx`
   - `docs/xxx`
3. 提交前请保证：
   - 变更有清晰目的
   - 本地可运行
   - 不包含无关改动
4. PR 描述请包含：
   - 改动内容摘要
   - 验证方式
   - 影响范围
5. 小步提交，保持 commit message 清晰。

## 开发环境搭建

1. 安装 Node.js 18+。
2. 克隆仓库：

```bash
git clone https://github.com/LckAndLove/serial-mcp.git
cd serial-mcp
```

3. 安装依赖：

```bash
cd serial-virtual && npm install
cd ../serial-db && npm install
cd ../serial-mcp && npm install
```

4. 按需调整配置：
   - `serial-db/config.json`
   - `serial-mcp/config.json`
   - `serial-virtual/config.json`

## 代码风格

- JavaScript 使用 2 空格缩进。
- 优先使用明确命名，避免缩写。
- 错误提示对外统一为简明中文，不暴露内部堆栈。
- 避免提交调试代码（临时 `console.log`、注释掉的死代码）。
- 保持函数职责单一，避免过长函数。
