# Insights Hub MCP Server

Exposes Insights Hub APIs as MCP tools that Claude Code can call directly, enabling AI assistants to query assets, time series, events, anomaly detection, and other industrial IoT data.

> **Historical Note**: MindSphere is the former brand name of Insights Hub. Siemens rebranded MindSphere to Insights Hub, but the underlying API gateway, environment variable names, and domain names still retain the `mindsphere` identifier for backward compatibility.
# Demo Link
[Demo video](https://www.bilibili.com/video/BV1ji596EE7u/?spm_id_from=333.1387.homepage.video_card.click&vd_source=eb43ace3feb71c95cf2ce025e40c2646)
## Not a Traditional Plugin

This project is an **MCP (Model Context Protocol) Server**, not a traditional Claude Code Plugin. It uses the standard MCP protocol to let Claude Code discover and call Insights Hub APIs. Essentially a translation layer: Claude Code speaks MCP, and this service translates to Insights Hub REST API calls.

## Quick Start

### 1. Clone and Install

```bash
git clone <this-repo-url> insights-hub-mcp
cd insights-hub-mcp
npm install
```

### 2. Configure Credentials

Copy `.mcp.json` and fill in your Insights Hub credentials:

```json
{
  "mcpServers": {
    "insights-hub": {
      "command": "node",
      "args": ["mcp-server.js", "--stdio"],
      "cwd": "<your-project-path>",
      "env": {
        "MINDSPHERE_CLIENT_ID": "your-client-id",
        "MINDSPHERE_CLIENT_SECRET": "your-client-secret",
        "MINDSPHERE_BASE_URL": "https://gateway.eu1.mindsphere.io",
        "MINDSPHERE_TOKEN_URL": "https://<your-tenant>.piam.eu1.mindsphere.io/oauth/token",
        "MINDSPHERE_TENANT": "your-tenant-name"
      }
    }
  }
}
```

### 3. Connect to Claude Code

**Option A: Project-level (recommended)**

Place `.mcp.json` in your project root directory. Claude Code will automatically load the MCP server on startup.

**Option B: Global connection**

Add the above configuration to the `mcpServers` field in `~/.claude.json`. This makes the MCP server available across all projects.

```json
// ~/.claude.json
{
  "mcpServers": {
    "insights-hub": { ... }
  }
}
```

**Quick Permission Setup (optional)**

To avoid manual approval for every tool call, add the following to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__insights-hub"]
  }
}
```

### 4. Verify Connection

In Claude Code, enter:

```
Test the connection using the insights-hub ping tool
```

Or directly request a list of assets:

```
List 5 assets
```

## Available Tools

At startup, the server automatically parses the Postman Collection (`MindSphere-V3-Training.postman_collection.json`) and registers **107 tools** covering 15 Insights Hub services:

| Service | Tool Prefix | Count | Primary Functions |
|---------|-------------|-------|-------------------|
| Auth | `auth_` | 4 | Acquire/refresh Bearer Token, JWT |
| Asset Management | `asset_`, `assettype_` | 18 | Asset CRUD, type management, Aspect/Variable management |
| Agent Management | `agent_` | 8 | Agent lifecycle, data source configuration, data point mapping |
| Event Management | `event_`, `eventtype_` | 16 | Event CRUD, bulk operations, event type management |
| Time Series | `timeseries_` | 6 | Time series read/write/delete, aggregate queries |
| Anomaly Detection | `anomalydetection_` | 3 | Model creation, anomaly detection |
| KPI Calculation | `kpicalculation_` | 1 | KPI computation |
| Signal Validation | `signalvalidation_` | 3 | Noise detection, range violation, spike detection |
| Trend Prediction | `trendprediction_` | 3 | Model training, prediction, model listing |
| Event Analytics | `eventanalytics_` | 1 | Top Events query |
| Data Flow Engine | `dataflowengine_` | 6 | Stream definition CRUD, app listing |
| File | `file_` | 1 | File management |
| Notification | `notification_` etc. | 22 | Message sending, template management, recipient management, notification categories |
| Tenant Management | `tenant_` | 2 | Tenant info, subtenant listing |
| System | `ping` | 1 | Connectivity test |

**Tool Naming Convention**: `{service-prefix}_{operation-name}`, for example:
- `asset_getAssets` — Get asset list
- `timeseries_readTimeSeries` — Read time series data
- `anomalydetection_detectanomalies` — Run anomaly detection

## Architecture

```
┌──────────────┐     MCP (stdio/HTTP)     ┌──────────────────┐     REST/OAuth     ┌─────────────────┐
│  Claude Code │ ◄──────────────────────► │  mcp-server.js   │ ◄───────────────► │  MindSphere API │
│  (VSCode)    │                          │  (107 tools)     │                   │  (gateway.eu1)  │
└──────────────┘                          └──────────────────┘                   └─────────────────┘
                                                 ▲
                                                 │ Parsed at startup
                                          ┌──────┴──────────────┐
                                          │ Postman Collection  │
                                          │ (105 API requests)  │
                                          └─────────────────────┘
```

Core modules:

- **AuthManager** — Automatically manages Bearer Token acquisition and caching (refreshes 60s before expiry)
- **Collection Parser** — Recursively parses Postman v2.1 Collections, extracting requests, path parameters, query parameters, and body structures
- **Zod Schema Generator** — Auto-generates Zod parameter validation schemas from Postman requests
- **Tool Registry** — Registers all requests as MCP tools, auto-injects authentication headers and builds URLs

## Sharing with Others

### Share as Project Template

```bash
# 1. Ensure no sensitive information is included
#    Verify .mcp.json contains no real credentials
#    Confirm .gitignore excludes .env and similar files

# 2. Push to GitHub
git remote add origin git@github.com:your-org/insights-hub-mcp.git
git push -u origin main

# 3. Teammates only need to:
git clone git@github.com:your-org/insights-hub-mcp.git
cd insights-hub-mcp
npm install
# Edit .mcp.json with their own Insights Hub credentials
# Ready to use in Claude Code
```

### Share as npm Package (optional)

```bash
# After completing name, description, author in package.json
npm publish
# Others use: npx insights-hub-mcp --stdio
```

### What Recipients Need

1. **Node.js 18+** runtime
2. **Insights Hub tenant credentials** (Client ID + Client Secret + tenant name)
3. **Claude Code** (VSCode extension or CLI)
4. Fill these into `.mcp.json` and place in the project root

## Using in Development Projects

### Scenario: Developing an app that queries Insights Hub data

```
# Example project structure
my-iot-dashboard/
├── .mcp.json              ← Place MCP config here
├── src/
│   ├── components/
│   └── ...
└── package.json
```

In Claude Code, you can collaborate with AI like this:

> "Use insights-hub to check the temperature data for asset fc51e81 over the last 24 hours. If anomalies are found, run anomaly detection analysis."

Claude will automatically call:
1. `insights-hub__timeseries_readTimeSeries` to fetch data
2. `insights-hub__anomalydetection_detectanomalies` to detect anomalies
3. Return an analysis report

### Scenario: Different credentials per environment

You can create multiple `.mcp.json` variants:

```
.mcp.json              ← Default (development)
.mcp.prod.json         ← Production (do not commit to Git)
.mcp.staging.json      ← Staging
```

And switch between them in `~/.claude.json` based on your current work.

### Scenario: Using in CI/CD

```bash
# Non-interactive connectivity verification
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}' \
  | node mcp-server.js --stdio
```

## Standalone Mode (HTTP)

In addition to stdio mode, the server can also run as a standalone HTTP service:

```bash
npm start
# Listening on http://127.0.0.1:3000/mcp
```

Environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_PORT` | HTTP port | `3000` |
| `MCP_HOST` | Bind address | `127.0.0.1` |
| `MINDSPHERE_CLIENT_ID` | Client ID | (required) |
| `MINDSPHERE_CLIENT_SECRET` | Client secret | (required) |
| `MINDSPHERE_BASE_URL` | API gateway | `https://gateway.eu1.mindsphere.io` |
| `MINDSPHERE_TOKEN_URL` | OAuth endpoint | Per tenant config |
| `MINDSPHERE_TENANT` | Tenant name | `academy2` |

## Security Notes

- `.mcp.json` contains credential information — **do not commit to public Git repositories**
- It is recommended to add `.mcp.json` to `.gitignore` and provide `.mcp.example.json` as a template
- For production environments, inject credentials via environment variables rather than writing them in configuration files

## Extension and Customization

### Using a Different Postman Collection

The default collection is `MindSphere-V3-Training.postman_collection.json`. To use your own:

```json
// Add to .mcp.json env
"POSTMAN_COLLECTION": "/path/to/your/collection.json"
```

### Adding Custom Tools

Follow the existing pattern in `mcp-server.js`:

```js
server.registerTool("my_customTool", {
  description: "My custom Insights Hub operation",
  inputSchema: {
    assetId: z.string().describe("Target asset ID"),
  },
}, async (args) => {
  // Your custom logic
});
```

## License

ISC
