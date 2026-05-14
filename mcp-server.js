// mcp-server.js — Insights Hub MCP Server
// Exposes all Insights Hub APIs from the Postman collection as MCP tools
// Note: MindSphere is the former brand name of Insights Hub. The API gateway domain
// (mindsphere.io), environment variable names (MINDSPHERE_*), and Postman collection
// filename still retain the "MindSphere" identifier for backward compatibility.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const z = require("zod");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const config = {
  port: parseInt(process.env.MCP_PORT || "3000", 10),
  host: process.env.MCP_HOST || "127.0.0.1",
  baseUrl: process.env.MINDSPHERE_BASE_URL || "https://gateway.eu1.mindsphere.io",
  tokenUrl: process.env.MINDSPHERE_TOKEN_URL || "https://academy2.piam.eu1.mindsphere.io/oauth/token",
  clientId: process.env.MINDSPHERE_CLIENT_ID || "",
  clientSecret: process.env.MINDSPHERE_CLIENT_SECRET || "",
  tenantName: process.env.MINDSPHERE_TENANT || "academy2",
  collectionFile:
    process.env.POSTMAN_COLLECTION ||
    path.join(__dirname, "MindSphere-V3-Training.postman_collection.json"),
};

// ---------------------------------------------------------------------------
// 2. Auth Manager — acquires and caches Bearer tokens
// ---------------------------------------------------------------------------
class AuthManager {
  constructor() {
    this._token = null;
    this._tokenExpiry = 0;
  }

  async getToken() {
    if (this._token && Date.now() < this._tokenExpiry - 60000) {
      return this._token;
    }
    const res = await axios.post(
      config.tokenUrl,
      "grant_type=client_credentials",
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 15000,
      }
    );
    this._token = res.data.access_token;
    this._tokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
    console.log("[insights-hub] Token acquired, expires in", res.data.expires_in, "s");
    return this._token;
  }
}

const auth = new AuthManager();

// ---------------------------------------------------------------------------
// 3. Postman Collection Parser
// ---------------------------------------------------------------------------

function loadCollection(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

// Walk the item tree; return a flat array of { request, folderPath, collectionAuth }
function extractRequests(items, folderPath = [], collectionAuth = null) {
  const results = [];
  if (!items) return results;
  for (const item of items) {
    if (item.item) {
      results.push(
        ...extractRequests(item.item, [...folderPath, item.name], collectionAuth)
      );
    } else if (item.request) {
      results.push({
        name: item.name,
        method: (item.request.method || "GET").toUpperCase(),
        url: item.request.url,
        headers: item.request.header || [],
        body: item.request.body || null,
        auth: item.request.auth || null,
        folderPath: [...folderPath],
        collectionAuth,
      });
    }
  }
  return results;
}

// ---- UUID / path-param detection ----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /^\{\{(.+?)\}\}$/;

function extractPathParams(url) {
  const params = {};
  if (!url || !url.path) return params;
  for (const seg of url.path) {
    const m = seg.match(PLACEHOLDER_RE);
    if (m) {
      params[m[1]] = { type: "string", required: true, example: seg };
    } else if (UUID_RE.test(seg)) {
      // Hardcoded UUID — make it an overridable param
      const key = "pathId";
      params[key] = params[key] || { type: "string", required: true, example: seg };
    }
  }
  return params;
}

// Detect variable host segments in URL
function extractHostVars(url) {
  const vars = [];
  if (!url || !url.host) return vars;
  for (const h of url.host) {
    const m = h.match(PLACEHOLDER_RE);
    if (m) vars.push(m[1]);
  }
  return vars;
}

// ---- Build a Zod input schema from a request ----
function buildInputSchema(req) {
  const shape = {};

  // Path params
  const pathParams = extractPathParams(req.url);
  for (const [name, info] of Object.entries(pathParams)) {
    const key = sanitizeKey(name);
    if (info.required) {
      shape[key] = z.string().describe(`Path parameter: ${name}. Example: ${info.example}`);
    } else {
      shape[key] = z.string().optional().describe(`Path parameter: ${name}. Example: ${info.example}`);
    }
  }

  // Query params
  if (req.url && req.url.query) {
    for (const q of req.url.query) {
      if (q.disabled) continue;
      const key = sanitizeKey(q.key);
      const val = q.value || "";
      if (PLACEHOLDER_RE.test(val)) {
        shape[key] = z.string().describe(`Query parameter (required): ${val}`);
      } else if (/^\d+(\.\d+)?$/.test(val)) {
        shape[key] = z.number().optional().describe(`Query parameter. Default example: ${val}`);
      } else {
        shape[key] = z.string().optional().describe(`Query parameter. Example: ${val || "(empty)"}`);
      }
    }
  }

  // Body
  if (req.body) {
    if (req.body.mode === "raw" && req.body.raw) {
      try {
        const parsed = JSON.parse(req.body.raw);
        if (Array.isArray(parsed)) {
          shape.body = z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe("Request body as JSON array");
        } else {
          shape.body = z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Request body as JSON object");
        }
      } catch {
        shape.body = z.string().optional().describe("Request body (raw text)");
      }
    } else if (req.body.mode === "formdata") {
      shape.body = z.string().optional().describe("Request body (form-encoded string)");
    } else if (req.body.mode === "urlencoded") {
      shape.body = z.string().optional().describe("Request body (url-encoded string)");
    }
  }

  // Common optional headers overrides
  shape._ifMatch = z.string().optional().describe("If-Match header for optimistic concurrency");

  return Object.keys(shape).length > 0 ? z.object(shape) : z.object({}).passthrough();
}

function sanitizeKey(key) {
  return key.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
}

// ---- Generate tool name from folder path + request name ----
function generateToolName(folderPath, requestName) {
  let prefix = "";
  if (folderPath.length > 0) {
    const top = folderPath[0].toLowerCase().replace(/\s+/g, "");
    if (top === "analytics") {
      // Use sub-folder name for analytics
      if (folderPath.length > 1) {
        prefix = folderPath[1].toLowerCase().replace(/[^a-z0-9]+/g, "");
      } else {
        prefix = "analytics";
      }
    } else {
      prefix = top.replace(/[^a-z0-9]+/g, "");
    }
  } else {
    prefix = "auth";
  }

  // For nested under Assets/Types, Events/EventTypes, Notification/*
  if (folderPath.length > 1) {
    const parent = folderPath[folderPath.length - 1].toLowerCase().replace(/[^a-z0-9]+/g, "");
    const grandParent = folderPath[0].toLowerCase().replace(/\s+/g, "");
    if (grandParent === "assets" && parent === "types") {
      prefix = "assettype";
    } else if (grandParent === "events" && parent === "eventtypes") {
      prefix = "eventtype";
    } else if (grandParent === "notification") {
      if (parent === "communicationcategory") prefix = "notificationcategory";
      else if (parent === "recipient") prefix = "notificationrecipient";
      else if (parent === "templates") prefix = "notificationtemplate";
    }
  }

  // Action from request name
  let action = requestName
    .replace(/\s*\(.*?\)\s*/g, "") // strip parentheticals
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .replace(/\s+/g, "_");

  // Lower camel: first word lower, rest title
  const parts = action.split("_");
  action = parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join("");

  let name = prefix + "_" + action;

  // Handle duplicates: append _2, _3 etc from a counter map
  if (!generateToolName._counts) generateToolName._counts = new Map();
  const cnt = generateToolName._counts.get(name) || 0;
  generateToolName._counts.set(name, cnt + 1);
  if (cnt > 0) {
    name = name + "_" + (cnt + 1);
  }

  return name;
}

// ---- Build description from request metadata ----
function buildDescription(req) {
  const parts = [req.method + " " + (req.url?.raw || "")];
  if (req.body && req.body.raw) {
    try {
      const bodyObj = JSON.parse(req.body.raw);
      parts.push(" | Body keys: " + Object.keys(bodyObj).join(", "));
    } catch {}
  }
  return parts.join("");
}

// ---- Build the actual HTTP URL from a request URL object + args ----
function buildUrl(urlObj, args, baseUrl) {
  if (!urlObj) return baseUrl;

  const protocol = urlObj.protocol || "https";
  // Determine host: use configured baseUrl host if gateway, else use original
  let host;
  if (urlObj.host) {
    host = urlObj.host.join(".");
  } else {
    host = new URL(baseUrl).host;
  }

  // Path — replace {{placeholders}} and UUIDs with args
  let pathParts = [];
  if (urlObj.path) {
    for (const seg of urlObj.path) {
      const pm = seg.match(PLACEHOLDER_RE);
      if (pm) {
        const key = sanitizeKey(pm[1]);
        pathParts.push(args[key] || seg);
      } else if (UUID_RE.test(seg)) {
        pathParts.push(args.pathId || seg);
      } else {
        pathParts.push(seg);
      }
    }
  } else {
    // Fallback: parse from raw
    const rawPath = (urlObj.raw || "").replace(/^https?:\/\/[^/]+/, "");
    return baseUrl.replace(/\/+$/, "") + rawPath;
  }

  let url = protocol + "://" + host + "/" + pathParts.join("/");

  // Query params
  if (urlObj.query && urlObj.query.length > 0) {
    const qs = [];
    for (const q of urlObj.query) {
      if (q.disabled) continue;
      const key = sanitizeKey(q.key);
      if (args[key] !== undefined && args[key] !== "") {
        qs.push(encodeURIComponent(q.key) + "=" + encodeURIComponent(args[key]));
      } else if (q.value && !PLACEHOLDER_RE.test(q.value)) {
        qs.push(encodeURIComponent(q.key) + "=" + encodeURIComponent(q.value));
      }
    }
    if (qs.length > 0) url += "?" + qs.join("&");
  }

  return url;
}

// ---- Build request headers ----
function buildHeaders(req, args, authToken) {
  const headers = {};

  // Collection-level auth: Bearer token (most requests)
  if (req.collectionAuth && req.collectionAuth.type === "bearer" && authToken) {
    headers["Authorization"] = "Bearer " + authToken;
  }

  // Request-level auth overrides
  if (req.auth) {
    if (req.auth.type === "bearer" && req.auth.bearer) {
      const token = req.auth.bearer.find((b) => b.key === "token");
      if (token) headers["Authorization"] = "Bearer " + token.value;
    }
    // Basic auth handled specially in handler
  }

  // Static headers from Postman
  for (const h of req.headers) {
    if (h.disabled) continue;
    const val = h.value || "";
    if (!PLACEHOLDER_RE.test(val) && h.key.toLowerCase() !== "authorization") {
      headers[h.key] = val;
    }
  }

  // Content-Type defaults
  if (req.body && req.body.mode === "raw" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  // If-Match override
  if (args._ifMatch) {
    headers["If-Match"] = args._ifMatch;
  }

  return headers;
}

// ---- Build request body ----
function buildBody(req, args) {
  if (!req.body || args.body === undefined) return undefined;

  if (req.body.mode === "raw" && req.body.raw) {
    // If caller provided body object, use it directly
    if (typeof args.body === "object") return args.body;
    // Try to parse the original body template and merge
    try {
      const template = JSON.parse(req.body.raw);
      if (typeof args.body === "string") {
        try {
          return JSON.parse(args.body);
        } catch {
          return args.body;
        }
      }
      return template;
    } catch {
      return args.body;
    }
  }

  if (req.body.mode === "formdata") {
    return args.body;
  }

  if (req.body.mode === "urlencoded") {
    return args.body;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// 4. Special-cased auth tools — these acquire tokens, not call business APIs
// ---------------------------------------------------------------------------
const AUTH_TOOL_NAMES = new Set();

function registerAuthTools(server) {
  // auth_serviceCredentials — standard OAuth client_credentials
  server.registerTool(
    "auth_serviceCredentials",
    {
      description: "Acquire a Bearer token using client credentials (standard OAuth)",
      inputSchema: {
        clientId: z.string().optional().describe("Override MINDSPHERE_CLIENT_ID"),
        clientSecret: z.string().optional().describe("Override MINDSPHERE_CLIENT_SECRET"),
      },
    },
    async (args) => {
      try {
        const cid = args.clientId || config.clientId;
        const csec = args.clientSecret || config.clientSecret;
        const res = await axios.post(
          "https://academy2.piam.eu1.mindsphere.io/oauth/token",
          "grant_type=client_credentials",
          {
            headers: {
              Authorization: "Basic " + Buffer.from(cid + ":" + csec).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 15000,
          }
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(res.data, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Auth failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
  AUTH_TOOL_NAMES.add("auth_serviceCredentials");

  // auth_serviceCredentialsSubtenant — OAuth with subtenant impersonation
  server.registerTool(
    "auth_serviceCredentialsSubtenant",
    {
      description: "Acquire a Bearer token with subtenant impersonation",
      inputSchema: {
        subtenant: z.string().optional().describe("Subtenant ID (defaults to MINDSPHERE_TENANT)"),
        clientId: z.string().optional().describe("Override MINDSPHERE_CLIENT_ID"),
        clientSecret: z.string().optional().describe("Override MINDSPHERE_CLIENT_SECRET"),
      },
    },
    async (args) => {
      try {
        const cid = args.clientId || config.clientId;
        const csec = args.clientSecret || config.clientSecret;
        const sub = args.subtenant || config.tenantName;
        const res = await axios.post(
          "https://academy2.piam.eu1.mindsphere.io/oauth/token",
          `grant_type=client_credentials&iam_action=client_credentials.subtenant-impersonation&subtenant=${sub}`,
          {
            headers: {
              Authorization: "Basic " + Buffer.from(cid + ":" + csec).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 15000,
          }
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(res.data, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Auth failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
  AUTH_TOOL_NAMES.add("auth_serviceCredentialsSubtenant");

  // auth_tokenManagerJwt — Technical Token Manager JWT
  server.registerTool(
    "auth_tokenManagerJwt",
    {
      description: "Acquire a JWT via Technical Token Manager",
      inputSchema: {
        authKey: z.string().optional().describe("Base64-encoded clientId:clientSecret"),
        appName: z.string().optional().describe("Application name"),
        appVersion: z.string().optional().describe("Application version"),
        hostTenant: z.string().optional().describe("Host tenant name"),
        userTenant: z.string().optional().describe("User tenant name"),
      },
    },
    async (args) => {
      try {
        const authKey = args.authKey || Buffer.from(config.clientId + ":" + config.clientSecret).toString("base64");
        const body = {
          appName: args.appName || "insights-hub",
          appVersion: args.appVersion || "1.0.0",
          hostTenant: args.hostTenant || config.tenantName,
          userTenant: args.userTenant || config.tenantName,
        };
        const res = await axios.post(
          "https://gateway.eu1.mindsphere.io/api/technicaltokenmanager/v3/oauth/token",
          body,
          {
            headers: {
              "X-SPACE-AUTH-KEY": "Basic " + authKey,
              "Content-Type": "application/json",
            },
            timeout: 15000,
          }
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(res.data, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `TokenManager JWT failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
  AUTH_TOOL_NAMES.add("auth_tokenManagerJwt");

  // auth_getTokenKeys — retrieve public token signing keys
  server.registerTool(
    "auth_getTokenKeys",
    {
      description: "Retrieve public token signing keys from PIAM",
    },
    async () => {
      try {
        const res = await axios.get("https://academy2.piam.eu1.mindsphere.io/token_keys", {
          timeout: 15000,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(res.data, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
  AUTH_TOOL_NAMES.add("auth_getTokenKeys");
}

// ---------------------------------------------------------------------------
// 5. Ping tool — connectivity test
// ---------------------------------------------------------------------------
function registerPingTool(server) {
  server.registerTool(
    "ping",
    {
      description: "Test Insights Hub MCP server connectivity. Returns a confirmation message if the server is running.",
    },
    async () => {
      return {
        content: [
          { type: "text", text: "Insights Hub MCP server is running." },
        ],
      };
    }
  );
}

// ---------------------------------------------------------------------------
// 6. Register all Postman requests as MCP tools
// ---------------------------------------------------------------------------
let registeredCount = 0;

function registerAllTools(server, requests) {
  for (const req of requests) {
    // Skip requests that override collection auth with basic/noauth
    // (they're handled separately by the auth tools)
    if (req.auth && (req.auth.type === "basic" || req.auth.type === "noauth")) {
      continue;
    }

    const toolName = generateToolName(req.folderPath, req.name);
    const description = buildDescription(req);
    const inputSchema = buildInputSchema(req);

    // Determine if this uses the collection Bearer auth
    const usesCollectionAuth =
      (!req.auth || req.auth.type === "bearer") &&
      req.collectionAuth &&
      req.collectionAuth.type === "bearer";

    server.registerTool(toolName, { description, inputSchema }, async (args) => {
      try {
        // Acquire token if needed
        let authToken = null;
        if (usesCollectionAuth) {
          authToken = await auth.getToken();
        }

        const url = buildUrl(req.url, args, config.baseUrl);
        const headers = buildHeaders(req, args, authToken);
        const data = buildBody(req, args);

        const response = await axios({
          method: req.method,
          url,
          headers,
          data,
          validateStatus: () => true,
          timeout: 30000,
        });

        let responseText;
        try {
          responseText = JSON.stringify(response.data, null, 2);
        } catch {
          responseText = String(response.data || "");
        }

        return {
          content: [
            { type: "text", text: `HTTP ${response.status} ${response.statusText}` },
            { type: "text", text: responseText.length > 50000 ? responseText.substring(0, 50000) + "\n... (truncated)" : responseText },
          ],
        };
      } catch (err) {
        if (err.response) {
          return {
            content: [
              {
                type: "text",
                text: `API Error ${err.response.status}: ${JSON.stringify(err.response.data)}`,
              },
            ],
            isError: true,
          };
        }
        if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.code === "ECONNABORTED") {
          return {
            content: [{ type: "text", text: `Network error: ${err.message}` }],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text", text: `Error: ${err.message}\n${err.stack || ""}` },
          ],
          isError: true,
        };
      }
    });

    registeredCount++;
  }
}

const useStdio = process.argv.includes("--stdio");

// ---------------------------------------------------------------------------
// 7. Server startup
// ---------------------------------------------------------------------------
async function main() {
  // Silence console output in stdio mode — stdout is the MCP protocol channel
  const log = useStdio ? () => {} : console.log.bind(console);
  log("[insights-hub] Starting Insights Hub MCP Server...");

  // Load Postman collection
  let collection;
  try {
    collection = loadCollection(config.collectionFile);
    log(`[insights-hub] Loaded collection: ${collection.info.name}`);
  } catch (err) {
    console.error("[insights-hub] Failed to load Postman collection:", err.message);
    process.exit(1);
  }

  // Extract all requests
  const collectionAuth = collection.auth || null;
  const requests = extractRequests(collection.item, [], collectionAuth);
  log(`[insights-hub] Extracted ${requests.length} requests from collection`);

  // Create MCP server
  const server = new McpServer({
    name: "insights-hub",
    version: "1.0.0",
  });

  // Register ping tool
  registerPingTool(server);

  // Register auth tools
  registerAuthTools(server);

  // Register all Postman-request tools
  registerAllTools(server, requests);

  log(`[insights-hub] Registered ${registeredCount + 4 + 1} tools (${registeredCount} API + 4 auth + ping)`);

  if (useStdio) {
    // ---- Stdio transport (for Claude Code subprocess) ----
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // StdioServerTransport handles the connection lifecycle — no Express needed
  } else {
    // ---- HTTP transport (for standalone use) ----
    const app = createMcpExpressApp({ host: config.host });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => require("crypto").randomUUID(),
    });

    await server.connect(transport);

    app.all("/mcp", async (req, res) => {
      await transport.handleRequest(req, res, req.body);
    });

    app.listen(config.port, config.host, () => {
      log(`[insights-hub] Listening on http://${config.host}:${config.port}/mcp`);
      if (!config.clientId) {
        log("[insights-hub] NOTE: MINDSPHERE_CLIENT_ID not set — API tools will fail until credentials are configured.");
      }
    });

    // Graceful shutdown (HTTP only)
    const shutdown = async () => {
      log("\n[insights-hub] Shutting down...");
      await transport.close();
      await server.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

main().catch((err) => {
  console.error("[insights-hub] Fatal:", err);
  process.exit(1);
});
