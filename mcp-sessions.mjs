// Persistent MCP sessions for codemode: one connected McpClient per server,
// kept alive across all tool calls of a run (pi's mcp-codemode pattern:
// connect once, then client.callTool() repeatedly on the same client).
//
// Connection logic (registry, ${VAR} expansion, transports, OAuth) mirrors
// ~/workspace/mcp/bin/mcp.mjs, but clients are cached instead of
// connect-per-call. No import of the CLI: this repo stays self-contained.
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

const HOME = os.homedir();
const CONFIG_DIR = resolve(HOME, ".config", "mcp");
const REGISTRY_PATH = resolve(CONFIG_DIR, "servers.json");
const TOKENS_PATH = resolve(CONFIG_DIR, "tokens.json");

const DEFAULT_CONNECT_TIMEOUT_MS = 45000;
// Client-level request timeout must not be stricter than the per-call
// timeoutMs (max 120000, enforced via AbortSignal in tools.mjs); otherwise
// the connect timeout would silently cap every tool call at 45s.
const MAX_REQUEST_TIMEOUT_MS = 120000;

let _piMcp = null;
async function piMcp() {
  if (!_piMcp) _piMcp = await import("@earendil-works/pi-mcp");
  return _piMcp;
}

/** Expand ${VAR} from the environment; throw on missing/empty so a call never goes out half-substituted. */
function expandEnv(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === "") {
      throw new Error(`missing required env var "${name}" (referenced as \${${name}})`);
    }
    return v;
  });
}

function expandMap(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expandEnv(v)]));
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(`no MCP registry at ${REGISTRY_PATH}`);
  }
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

/** File-backed OAuth state store: ~/.config/mcp/tokens.json (0600), keyed by server name. */
class FileOAuthStateStore {
  constructor(serverName) {
    this.serverName = serverName;
  }
  readAll() {
    try {
      return JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
    } catch {
      return {};
    }
  }
  load() {
    return this.readAll().servers?.[this.serverName];
  }
  async save(state) {
    const all = this.readAll();
    all.servers = all.servers || {};
    all.servers[this.serverName] = state;
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(TOKENS_PATH, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(TOKENS_PATH, 0o600);
    } catch {}
  }
}

async function buildTransport(entry, serverName) {
  const { StreamableHttpTransport, StdioTransport } = await piMcp();
  if (entry.transport === "streamable-http" || !entry.transport) {
    const opts = { url: expandEnv(entry.url) };
    if (entry.headers) opts.headers = expandMap(entry.headers);
    for (const k of ["openGetStream", "maxMessageBytes"]) {
      if (entry.options && entry.options[k] !== undefined) opts[k] = entry.options[k];
    }
    if (entry.oauth) {
      const { McpOAuthProvider, adaptOAuthProvider } = await import("@earendil-works/pi-mcp/oauth");
      const provider = new McpOAuthProvider({
        serverUrl: expandEnv(entry.url),
        redirectUrl: entry.oauth?.redirectUrl || "http://127.0.0.1/callback",
        clientMetadata: {
          client_name: entry.oauth?.clientName || "muse-mcp",
          ...(entry.oauth?.scope ? { scope: entry.oauth.scope } : {}),
        },
        store: new FileOAuthStateStore(serverName),
        onRedirect: () => {},
      });
      opts.authProvider = adaptOAuthProvider(provider);
    }
    return new StreamableHttpTransport(opts);
  }
  if (entry.transport === "stdio") {
    if (!entry.command) throw new Error(`stdio server "${serverName}" needs "command"`);
    return new StdioTransport({
      command: expandEnv(entry.command),
      args: (entry.args || []).map(expandEnv),
      env: entry.env ? expandMap(entry.env) : undefined,
      inheritEnv: entry.inheritEnv ?? true,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    });
  }
  throw new Error(`unsupported transport "${entry.transport}"`);
}

function isAuthRequired(e) {
  return e?.name === "McpOAuthAuthorizationRequiredError";
}

/**
 * Keeps one connected McpClient per server for the lifetime of a codemode run.
 * Create one per run; call closeAll() when the run ends (stdio child processes
 * die with their client).
 */
export class McpSessionManager {
  constructor({ connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    this.connectTimeoutMs = connectTimeoutMs;
    this.clients = new Map(); // server -> McpClient (connected)
    this.pending = new Map(); // server -> in-flight connect promise
    this.connects = new Map(); // server -> number of actual connects (diagnostics)
  }

  /** Connected client for server, connecting once and reusing afterwards. */
  async getClient(serverName, { signal } = {}) {
    if (this.clients.has(serverName)) return this.clients.get(serverName);
    if (this.pending.has(serverName)) return this.pending.get(serverName);
    const p = this._connect(serverName, { signal }).finally(() => {
      this.pending.delete(serverName);
    });
    this.pending.set(serverName, p);
    return p;
  }

  async _connect(serverName, { signal } = {}) {
    const { McpClient } = await piMcp();
    const servers = loadRegistry();
    const entry = servers[serverName];
    if (!entry) throw new Error(`unknown server "${serverName}" in ${REGISTRY_PATH}`);
    const client = new McpClient({
      name: "muse-codemode",
      version: "1.0.0",
      requestTimeoutMs: MAX_REQUEST_TIMEOUT_MS,
    });
    const transport = await buildTransport(entry, serverName);
    try {
      await this._withTimeout(
        client.connect(transport),
        this.connectTimeoutMs,
        `timed out connecting to MCP server "${serverName}"`,
        signal,
      );
    } catch (e) {
      await client.close().catch(() => {});
      if (isAuthRequired(e)) {
        throw new Error(`server "${serverName}" needs OAuth authorization — run: mcp auth --server ${serverName}`);
      }
      throw e;
    }
    this.clients.set(serverName, client);
    this.connects.set(serverName, (this.connects.get(serverName) ?? 0) + 1);
    return client;
  }

  async _withTimeout(promise, ms, message, signal) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
          timer.unref?.();
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** How many real connects happened per server (proves session reuse). */
  stats() {
    return Object.fromEntries(this.connects);
  }

  async closeAll() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.pending.clear();
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }
}
