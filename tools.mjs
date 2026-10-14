// Default codemode tools for this system. All filesystem access is confined to $HOME.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
const MCP_BIN = path.join(HOME, ".local", "bin", "mcp");

/** Resolve p against $HOME and reject anything escaping it. */
export function resolveUnderHome(p, what = "path") {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error(`${what} must be a non-empty string`);
  }
  const resolved = path.resolve(HOME, p);
  const rel = path.relative(HOME, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
  throw new Error(`${what} must be under ${HOME}, got: ${p}`);
}

function intArg(v, name, { min, max, def }) {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

function strArg(v, name, { allowEmpty = false } = {}) {
  if (typeof v !== "string" || (!allowEmpty && v.length === 0)) {
    throw new Error(`${name} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  }
  return v;
}

const readTool = {
  name: "read",
  description:
    "Read a file under the user's home directory. Relative paths resolve against $HOME. Returns the file text (or base64).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to $HOME" },
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      maxBytes: { type: "integer", minimum: 1, maximum: 10485760, default: 1048576 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: { type: "string" },
  execute: async (rawArgs) => {
    const args = rawArgs ?? {};
    const file = resolveUnderHome(strArg(args.path, "path"));
    const encoding = args.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") throw new Error("encoding must be utf8 or base64");
    const maxBytes = intArg(args.maxBytes, "maxBytes", { min: 1, max: 10 * 1024 * 1024, def: 1024 * 1024 });
    const fh = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > maxBytes) {
        throw new Error(`file exceeds maxBytes (${maxBytes}); refusing to read ${file}`);
      }
      return buf.subarray(0, bytesRead).toString(encoding);
    } finally {
      await fh.close();
    }
  },
};

const writeTool = {
  name: "write",
  description:
    "Write a file under the user's home directory (parent directories are created). Relative paths resolve against $HOME.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to $HOME" },
      content: { type: "string", description: "File content to write" },
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { path: { type: "string" }, bytes: { type: "integer" } },
  },
  execute: async (rawArgs) => {
    const args = rawArgs ?? {};
    const file = resolveUnderHome(strArg(args.path, "path"));
    const content = strArg(args.content, "content", { allowEmpty: true });
    const encoding = args.encoding ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") throw new Error("encoding must be utf8 or base64");
    const data = Buffer.from(content, encoding);
    if (data.length > 10 * 1024 * 1024) throw new Error("content exceeds 10 MiB; refusing to write");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    return { path: file, bytes: data.length };
  },
};

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Spawn a process with a hard timeout. Never hangs: timer always kills the child. */
function spawnWithTimeout(file, argv, { cwd, timeoutMs, shell, maxOutputBytes, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    const opts = { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env };
    try {
      child = shell
        ? spawn(`${file} ${argv.map(shellQuote).join(" ")}`.trim(), { ...opts, shell: "/bin/bash" })
        : spawn(file, argv, opts);
    } catch (err) {
      reject(new Error(`spawn failed: ${err.message}`));
      return;
    }
    let timedOut = false;
    let truncated = false;
    const cap = (buf, chunk) => {
      const next = Buffer.concat([buf, chunk]);
      if (next.length > maxOutputBytes) {
        truncated = true;
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => child.kill("SIGKILL");
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (d) => {
      stdout = cap(stdout, d);
    });
    child.stderr.on("data", (d) => {
      stderr = cap(stderr, d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`exec: ${err.message}`));
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (timedOut) {
        reject(new Error(`exec timed out after ${timeoutMs}ms (SIGKILL)`));
        return;
      }
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode: code,
        signal: sig ?? null,
        truncated,
      });
    });
  });
}

const execTool = {
  name: "exec",
  description:
    "Run a command on this machine. No shell by default (pass shell:true for pipes/globs via bash). cwd defaults to $HOME and must stay under $HOME. ALWAYS has a timeout (default 30s); a hanging command is SIGKILLed and reported as an error.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Executable, or full shell string when shell:true" },
      args: { type: "array", items: { type: "string" }, default: [] },
      cwd: { type: "string", description: "Working dir, absolute or relative to $HOME" },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 120000, default: 30000 },
      shell: { type: "boolean", default: false },
      maxOutputBytes: { type: "integer", minimum: 1, maximum: 10485760, default: 1048576 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "integer" },
      signal: { type: ["string", "null"] },
      truncated: { type: "boolean" },
    },
  },
  execute: async (rawArgs, { signal } = {}) => {
    const args = rawArgs ?? {};
    const command = strArg(args.command, "command");
    const argv = args.args ?? [];
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) {
      throw new Error("args must be an array of strings");
    }
    const cwd = args.cwd === undefined ? HOME : resolveUnderHome(strArg(args.cwd, "cwd"), "cwd");
    const timeoutMs = intArg(args.timeoutMs, "timeoutMs", { min: 1000, max: 120000, def: 30000 });
    const shell = args.shell === undefined ? false : args.shell;
    if (typeof shell !== "boolean") throw new Error("shell must be a boolean");
    const maxOutputBytes = intArg(args.maxOutputBytes, "maxOutputBytes", {
      min: 1,
      max: 10 * 1024 * 1024,
      def: 1024 * 1024,
    });
    return spawnWithTimeout(command, argv, { cwd, timeoutMs, shell, maxOutputBytes, signal });
  },
};

const mcpTool = {
  name: "mcp",
  description:
    "Call a tool on a registered MCP server via the system `mcp` CLI (servers: openai-docs, xai-docs, anthropic-docs, cloudflare, context7, exa, ksht, firecrawl, inspo). Returns the tool result as compact LLM text (--llm).",
  inputSchema: {
    type: "object",
    properties: {
      server: { type: "string", description: "MCP server name from the registry" },
      name: { type: "string", description: "Tool name on that server" },
      args: { type: "object", description: "Tool arguments", default: {} },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 120000, default: 60000 },
    },
    required: ["server", "name"],
    additionalProperties: false,
  },
  outputSchema: { type: "string" },
  execute: async (rawArgs, { signal } = {}) => {
    const args = rawArgs ?? {};
    const server = strArg(args.server, "server");
    const name = strArg(args.name, "name");
    for (const [k, v] of [["server", server], ["name", name]]) {
      if (!/^[A-Za-z0-9_.-]+$/.test(v)) throw new Error(`${k} contains invalid characters: ${v}`);
    }
    const toolArgs = args.args ?? {};
    if (typeof toolArgs !== "object" || toolArgs === null || Array.isArray(toolArgs)) {
      throw new Error("args must be an object");
    }
    const timeoutMs = intArg(args.timeoutMs, "timeoutMs", { min: 1000, max: 120000, def: 60000 });
    const res = await spawnWithTimeout(
      MCP_BIN,
      ["call-tool", "--server", server, "--name", name, "--args-json", JSON.stringify(toolArgs), "--llm"],
      { cwd: HOME, timeoutMs, shell: false, maxOutputBytes: 2 * 1024 * 1024, signal },
    );
    if (res.exitCode !== 0) {
      throw new Error(`mcp call-tool failed (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`);
    }
    return res.stdout;
  },
};

export function createTools() {
  return [readTool, writeTool, execTool, mcpTool];
}
