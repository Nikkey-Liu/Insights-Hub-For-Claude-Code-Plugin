# Insights Hub MCP Server

将 Insights Hub API 暴露为 Claude Code 可直接调用的 MCP 工具，让 AI 助手能够查询资产、时间序列、事件、异常检测等工业物联网数据。

> **历史说明**：MindSphere 是 Insights Hub 的曾用名称。Siemens 将 MindSphere 品牌更名为 Insights Hub，但底层 API 网关、环境变量名称和域名仍保留 `mindsphere` 标识。

## 这不是传统 Plugin

这个项目是 **MCP (Model Context Protocol) Server**，而非 Claude Code 的传统 Plugin。它通过标准 MCP 协议让 Claude Code 发现并调用 Insights Hub API。本质上是一个翻译层：Claude Code 说 MCP，这个服务转译为 Insights Hub REST API 调用。

## 快速开始

### 1. 克隆并安装

```bash
git clone <this-repo-url> insights-hub-mcp
cd insights-hub-mcp
npm install
```

### 2. 配置凭证

复制 `.mcp.json` 并填入你的 Insights Hub 凭证：

```json
{
  "mcpServers": {
    "insights-hub": {
      "command": "node",
      "args": ["mcp-server.js", "--stdio"],
      "cwd": "<你的项目路径>",
      "env": {
        "MINDSPHERE_CLIENT_ID": "你的Client ID",
        "MINDSPHERE_CLIENT_SECRET": "你的Client Secret",
        "MINDSPHERE_BASE_URL": "https://gateway.eu1.mindsphere.io",
        "MINDSPHERE_TOKEN_URL": "https://<你的租户>.piam.eu1.mindsphere.io/oauth/token",
        "MINDSPHERE_TENANT": "你的租户名"
      }
    }
  }
}
```

### 3. 连接 Claude Code

**方式一：项目级连接（推荐）**

将 `.mcp.json` 放在你的项目根目录下，Claude Code 启动时会自动加载该 MCP 服务器。

**方式二：全局连接**

将上述配置添加到 `~/.claude.json` 的 `mcpServers` 字段中。此方式让该 MCP 服务器在所有项目中都可用。

```json
// ~/.claude.json
{
  "mcpServers": {
    "insights-hub": { ... }
  }
}
```

**快捷权限设置（可选）**

为了避免每次工具调用都需要手动批准，在 `~/.claude/settings.json` 中添加：

```json
{
  "permissions": {
    "allow": ["mcp__insights-hub"]
  }
}
```

### 4. 验证连接

在 Claude Code 中输入：

```
用 insights-hub 的 ping 工具测试连接
```

或直接要求列出资产：

```
列出 5 个资产
```

## 可用工具一览

服务器启动时会自动从 Postman Collection (`MindSphere-V3-Training.postman_collection.json`) 解析并注册 **107 个工具**，覆盖 15 个 Insights Hub 服务：

| 服务 | 工具前缀 | 数量 | 主要功能 |
|------|----------|------|----------|
| Auth | `auth_` | 4 | 获取/刷新 Bearer Token、JWT |
| Asset Management | `asset_`, `assettype_` | 18 | 资产 CRUD、类型管理、Aspect/Variable 管理 |
| Agent Management | `agent_` | 8 | 代理生命周期、数据源配置、数据点映射 |
| Event Management | `event_`, `eventtype_` | 16 | 事件创建/查询/更新、批量操作、事件类型管理 |
| Time Series | `timeseries_` | 6 | 时序数据读写/删除、聚合查询 |
| Anomaly Detection | `anomalydetection_` | 3 | 模型创建、异常检测 |
| KPI Calculation | `kpicalculation_` | 1 | KPI 计算 |
| Signal Validation | `signalvalidation_` | 3 | 噪声检测、范围违规、尖峰检测 |
| Trend Prediction | `trendprediction_` | 3 | 模型训练、预测、模型列表 |
| Event Analytics | `eventanalytics_` | 1 | Top Events 查询 |
| Data Flow Engine | `dataflowengine_` | 6 | Stream 定义 CRUD、App 列表 |
| File | `file_` | 1 | 文件管理 |
| Notification | `notification_` 等 | 22 | 消息发送、模板管理、收件人管理、通知类别 |
| Tenant Management | `tenant_` | 2 | 租户信息、子租户列表 |
| 系统 | `ping` | 1 | 连通性测试 |

**工具命名规则**：`{服务前缀}_{操作名}`，例如：
- `asset_getAssets` — 获取资产列表
- `timeseries_readTimeSeries` — 读取时序数据
- `anomalydetection_detectanomalies` — 执行异常检测

## 架构说明

```
┌──────────────┐     MCP (stdio/HTTP)     ┌──────────────────┐     REST/OAuth     ┌─────────────────┐
│  Claude Code │ ◄──────────────────────► │  mcp-server.js   │ ◄───────────────► │  MindSphere API │
│  (VSCode)    │                          │  (107 tools)     │                   │  (gateway.eu1)  │
└──────────────┘                          └──────────────────┘                   └─────────────────┘
                                                 ▲
                                                 │ 启动时解析
                                          ┌──────┴──────────────┐
                                          │ Postman Collection  │
                                          │ (105 API requests)  │
                                          └─────────────────────┘
```

核心模块：

- **AuthManager** — 自动管理 Bearer Token 获取与缓存（过期前 60s 刷新）
- **Collection Parser** — 递归解析 Postman v2.1 Collection，提取请求、路径参数、查询参数、Body 结构
- **Zod Schema Generator** — 从 Postman 请求自动生成 Zod 参数校验模式
- **Tool Registry** — 将所有请求注册为 MCP 工具，自动注入认证头、构建 URL

## 如何分享给他人

### 分享为项目模板

```bash
# 1. 确保不包含敏感信息
#    检查 .mcp.json 不含真实凭证
#    确认 .gitignore 排除了 .env 等文件

# 2. 推送到 GitHub
git remote add origin git@github.com:your-org/insights-hub-mcp.git
git push -u origin main

# 3. 同事获取后只需：
git clone git@github.com:your-org/insights-hub-mcp.git
cd insights-hub-mcp
npm install
# 编辑 .mcp.json 填入自己的 Insights Hub 凭证
# 在 Claude Code 中直接使用
```

### 分享为 npm 包（可选）

```bash
# 在 package.json 中补充 name、description、author 后
npm publish
# 他人使用：npx insights-hub-mcp --stdio
```

### 接收方需要什么

1. **Node.js 18+** 环境
2. **Insights Hub 租户凭证**（Client ID + Client Secret + 租户名）
3. **Claude Code**（VSCode 扩展或 CLI）
4. 将这些配置填入 `.mcp.json` 并放在项目根目录

## 在开发项目中使用

### 场景：开发一个需要查询 Insights Hub 数据的应用

```
# 项目结构示例
my-iot-dashboard/
├── .mcp.json              ← 放置 MCP 配置
├── src/
│   ├── components/
│   └── ...
└── package.json
```

在 Claude Code 中你可以这样与 AI 协作：

> "用 insights-hub 查一下资产 fc51e81 最近 24 小时的温度数据，如果发现异常，用 anomaly detection 分析一下"

Claude 会自动调用：
1. `insights-hub__timeseries_readTimeSeries` 获取数据
2. `insights-hub__anomalydetection_detectanomalies` 检测异常
3. 返回分析报告

### 场景：需要不同环境的凭证

你可以创建多个 `.mcp.json` 变体：

```
.mcp.json              ← 默认（开发环境）
.mcp.prod.json         ← 生产环境（不可提交到 Git）
.mcp.staging.json      ← 预发布环境
```

并在 `~/.claude.json` 中根据当前工作切换。

### 场景：CI/CD 中使用

```bash
# 非交互式验证连通性
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}' \
  | node mcp-server.js --stdio
```

## 独立运行（HTTP 模式）

除 stdio 模式外，也可作为独立 HTTP 服务运行：

```bash
npm start
# Listening on http://127.0.0.1:3000/mcp
```

环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MCP_PORT` | HTTP 端口 | `3000` |
| `MCP_HOST` | 绑定地址 | `127.0.0.1` |
| `MINDSPHERE_CLIENT_ID` | 客户端 ID | (必填) |
| `MINDSPHERE_CLIENT_SECRET` | 客户端密钥 | (必填) |
| `MINDSPHERE_BASE_URL` | API 网关 | `https://gateway.eu1.mindsphere.io` |
| `MINDSPHERE_TOKEN_URL` | OAuth 端点 | 按租户配置 |
| `MINDSPHERE_TENANT` | 租户名 | `academy2` |

## 安全提醒

- `.mcp.json` 包含凭证信息，**不应提交到公共 Git 仓库**
- 建议将 `.mcp.json` 加入 `.gitignore`，提供 `.mcp.example.json` 作为模板
- 生产环境凭证建议通过环境变量注入，而非写在配置文件中

## 扩展与定制

### 更换 Postman Collection

默认使用 `MindSphere-V3-Training.postman_collection.json`。如需使用自己的 Collection：

```json
// .mcp.json 的 env 中添加
"POSTMAN_COLLECTION": "/path/to/your/collection.json"
```

### 添加自定义工具

在 `mcp-server.js` 中参考现有模式：

```js
server.registerTool("my_customTool", {
  description: "My custom Insights Hub operation",
  inputSchema: {
    assetId: z.string().describe("Target asset ID"),
  },
}, async (args) => {
  // 你的自定义逻辑
});
```

## 许可证

ISC
