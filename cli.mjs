#!/usr/bin/node
// codemode CLI implementation. The installed launcher (~/.local/bin/codemode) imports this file.
import { promises as fs } from "node:fs";
import path from "node:path";
import { runScript, declarations, CodemodeSourceError, DEFAULT_TIMEOUT_MS } from "./runner.mjs";

const EXIT = { ok: 0, script: 1, timeout: 2, aborted: 3, sandbox: 4, source: 5, usage: 6 };

function usage() {
  return `codemode - run model-written JavaScript in a QuickJS sandbox (worker thread)

Usage:
  codemode [options] [script.js]     run script from file, or stdin when omitted
  codemode --declarations            print TypeScript declarations of the default tools

Options:
  --timeout-ms N   default deadline per run in ms (default ${DEFAULT_TIMEOUT_MS});
                   a script's "// @options: {\\"timeout_ms\\": N}" line overrides it
  --no-store       do not load/persist ~/.config/codemode/store.json for store()/load()
  --json           print a single machine-readable JSON result
  --help           this help

Script format: body of an async function (top-level await, return allowed).
First line may be: // @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
Available in scripts: tools.read/write/exec/mcp, ALL_TOOLS, text(), image(),
console.*, exit(), store(), load().

Exit codes: 0 ok, 1 script error, 2 timeout, 3 aborted, 4 sandbox/host failure,
            5 bad // @options: line, 6 usage error.`;
}

function parseArgv(argv) {
  const opts = { timeoutMs: undefined, useStore: true, json: false, declarations: false, help: false };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--timeout-ms") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      opts.timeoutMs = n;
    } else if (a === "--no-store") opts.useStore = false;
    else if (a === "--json") opts.json = true;
    else if (a === "--declarations") opts.declarations = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    else files.push(a);
  }
  if (files.length > 1) throw new Error("at most one script file");
  return { opts, file: files[0] };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function formatValue(value) {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function printHuman(result) {
  for (const item of result.output) {
    if (item.type === "text") process.stdout.write(item.text + (item.text.endsWith("\n") ? "" : "\n"));
    else process.stdout.write(`[image ${item.mimeType} ${item.data.length}b base64]\n`);
  }
  if (result.ok) {
    process.stdout.write(`=> ${formatValue(result.value)}\n`);
  }
}

function errorExitCode(kind) {
  return kind === "script" ? EXIT.script : kind === "timeout" ? EXIT.timeout : kind === "aborted" ? EXIT.aborted : EXIT.sandbox;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`codemode: ${err.message}\n${usage()}\n`);
    process.exit(EXIT.usage);
  }
  const { opts, file } = parsed;
  if (opts.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  if (opts.declarations) {
    process.stdout.write(declarations() + "\n");
    return;
  }
  let source;
  if (file) {
    try {
      source = await fs.readFile(path.resolve(process.cwd(), file), "utf8");
    } catch (err) {
      process.stderr.write(`codemode: cannot read ${file}: ${err.message}\n`);
      process.exit(EXIT.usage);
    }
  } else if (process.stdin.isTTY) {
    process.stderr.write(`codemode: no script given (pass a file or pipe via stdin)\n${usage()}\n`);
    process.exit(EXIT.usage);
  } else {
    source = await readStdin();
  }

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  let ran;
  try {
    ran = await runScript(source, { timeoutMs: opts.timeoutMs, store: opts.useStore, signal: controller.signal });
  } catch (err) {
    if (err instanceof CodemodeSourceError || err?.name === "CodemodeSourceError") {
      process.stderr.write(`codemode: bad options line: ${err.message}\n`);
      process.exit(EXIT.source);
    }
    process.stderr.write(`codemode: host failure: ${err?.message ?? err}\n`);
    process.exit(EXIT.sandbox);
  }

  const { result } = ran;
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    printHuman(result);
  }
  if (!result.ok) {
    process.stderr.write(`codemode error [${result.error.kind}]: ${result.error.message}\n`);
    if (result.error.stack) process.stderr.write(result.error.stack + "\n");
    process.exit(errorExitCode(result.error.kind));
  }
}

main().catch((err) => {
  process.stderr.write(`codemode: unexpected failure: ${err?.message ?? err}\n`);
  process.exit(EXIT.sandbox);
});
