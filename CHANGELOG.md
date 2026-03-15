# Changelog

## [v2.0.6] - 2026-04-17
### 修复
- open_monitor 改用 explorer.exe + bat 文件绕过 session 限制，监控窗口正常弹出

## [v2.0.5] - 2026-04-17
### 修复
- open_monitor psCmd 格式修正，使用双引号和正斜杠路径

## [v2.0.4] - 2026-04-17
### 修复
- monitor-window.js 数据库目录自动创建

## [v2.0.3] - 2026-04-17
### 修复
- open_monitor 在 npx 环境下路径问题

## [v2.0.2] - 2026-04-17
### 修复
- listener 默认配置，补充 http.port 字段

## [v2.0.1] - 2026-04-17
### 修复
- listener.js 打包进 npm 包，修复 spawn 路径 ENOENT 问题

## [v2.0.0] - 2026-04-17
### 新增
- 发布到 npm，支持 npx 一键使用
- Claude Code：claude mcp add -s user serial -- cmd /c npx -y @lckandyou/serial-mcp
- Codex CLI：codex mcp add serial -- npx -y @lckandyou/serial-mcp

## [v1.5.0] - 2026-04-16
### 新增
- MCP Server 启动时自动拉起 listener，用户无需手动启动服务
- 锁文件机制防止多个 Claude Code 实例重复启动 listener
- listener 以独立进程运行，Claude Code 关闭不影响串口监听

## [v1.4.1] - 2026-04-16
### 新增
- detect_device 工具：插板子前快照，插板子后自动识别新增串口
- 支持 auto_connect 参数，发现新设备自动连接

## [v1.4.0] - 2026-04-16
### 新增
- 多串口并发支持，可同时接管多个串口
- 新增 list_connected 工具，查看当前已接管的串口列表
- send_data / send_and_wait 的 port 参数真正生效
- new_session 支持按 port 隔离会话

### 变更
- 删除 open_port / close_port 工具，改为 connect_port / disconnect_port
- get_status 返回所有已连接串口状态

## [v1.3.2] - 2026-04-16
### 修复
- connect_port 改为先试连新串口再断旧串口，避免切换失败导致离线
- send_data / send_and_wait 加前置状态校验，未连接时返回明确错误
- httpGet 加超时机制，避免 get_status 挂死

## [v1.3.1] - 2026-04-16
### 修复
- send_and_wait 改为 (timestamp, id) 双游标，防止同毫秒漏响应
- send_data 的 port 参数改为仅标记，描述里说明清楚
- 新增复合索引 (session_id, direction, timestamp, id) 保障轮询性能
- 413 超限改为温和处理，不再强制断开连接
- 异步日志写入加错误处理，磁盘满时不再静默丢失

## [v1.3.0] - 2026-04-16
### 修复
- send_and_wait 时序修复，发送完成后才开始计时
- SQL prepare 移到循环外，避免重复编译
- delimiter 模式去掉 SQL LIKE，改为 JS 判断
- 日志写入改为异步，不阻塞事件循环
- cleanup 算法优化，一次性删完超出行数

## [v1.2.0] - 2026-04-16
### 新增
- 串口动态连接，用户通过 AI 指定端口，无需修改配置文件
- 新增 connect_port / disconnect_port 工具
- get_status 透传 listener 状态

### 修复
- send_and_wait 加 session_id 过滤，多会话不串数据
- httpPost 加超时机制
- 请求体加 1MB 大小限制

## [v1.1.0] - 2026-04-16
### 修复
- new_session 真正同步到 listener，TX/RX 数据 session_id 一致
- send_and_wait 接口契约和实现对齐
- HTTP 服务绑定 127.0.0.1
- 清理死代码和无效配置

## [v1.0.0] - 2026-04-16
### 首次发布
- 虚拟串口模拟器，无需真实硬件即可开发调试
- 串口数据持久化到 SQLite，超量自动清理
- MCP Server 9个工具，支持 Claude Code 和 Codex CLI
- 一键启动脚本 start-all.bat

---

## 真实硬件验证记录 - 2026-04-16

### 测试环境
- 设备：两个星闪模组，CH340 串口芯片
- 串口：COM6 ↔ COM8
- 模式：透传互联
- 波特率：115200

### 验证结果
| 测试项 | 结果 |
|--------|------|
| AI 自动识别 CH340 串口 | ✅ |
| 同时连接 COM6 和 COM8 | ✅ |
| COM6 发送数据透传到 COM8 | ✅ |
| 数据内容准确无误 | ✅ |
| 多串口并发正常 | ✅ |

### 备注
透传场景建议使用 send_data + read_latest 组合，
而非 send_and_wait（后者适合单设备指令响应场景）。

---

## 待办
- [ ] send_to_and_read_from 工具：跨串口透传场景
- [ ] 定时发送功能
- [ ] Web 监控面板：浏览器实时查看串口数据
- [ ] 串口 idle 自动释放
