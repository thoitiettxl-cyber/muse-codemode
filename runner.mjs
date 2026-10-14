// codemode runner: executes a model-written script in a QuickJS sandbox (worker thread)
// with the default system tools. Used by cli.mjs; also importable.
import { CodemodeSandbox, renderDeclarations } from "@earendil-works/pi-codemode";
import { parseCodemodeSource, CodemodeSourceError } from "@earendil-works/pi-codemode/source";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "./tools.mjs";

export { CodemodeSourceError };
export const TOOLS = createTools();
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
export const STORE_PATH = path.join(os.homedir(), ".config", "codemode", "store.json");

/** TypeScript declarations of the default tools, for model-facing prompts / --declarations. */
export function declarations() {
  return renderDeclarations({ tools: TOOLS });
}

export async function loadStore(storePath = STORE_PATH) {
  try {
    return JSON.parse(await fs.readFile(storePath, "utf8"));
  } catch {
    return {};
  }
}

export async function saveStore(store, storePath = STORE_PATH) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2) + "\n");
}

/** Truncate output text to ~4 chars per token budget; returns { output, truncated }. */
export function applyOutputBudget(output, maxOutputTokens) {
  if (maxOutputTokens === undefined || maxOutputTokens === null) return { output, truncated: false };
  const budget = Math.max(1, Math.floor(Number(maxOutputTokens))) * 4;
  let used = 0;
  let truncated = false;
  const out = [];
  for (const item of output) {
    if (item.type !== "text") {
      out.push(item);
      continue;
    }
    if (used >= budget) {
      truncated = true;
      continue;
    }
    const rest = budget - used;
    if (item.text.length > rest) {
      out.push({ ...item, text: item.text.slice(0, rest) });
      truncated = true;
      used = budget;
    } else {
      out.push(item);
      used += item.text.length;
    }
  }
  if (truncated) {
    out.push({ type: "text", text: `[output truncated to max_output_tokens=${maxOutputTokens}]` });
  }
  return { output: out, truncated };
}

/**
 * Run a codemode source string. Handles the `// @options:` line itself.
 * Returns { result, options, storePath } where result is a CodemodeResult.
 * Never throws for script failures (they come back as result.error); throws
 * CodemodeSourceError for a bad options line and on host-level failures.
 */
export async function runScript(source, { timeoutMs, store: useStore = true, signal } = {}) {
  const { code, options } = parseCodemodeSource(source);
  let deadline = options.timeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS;
  deadline = Number(deadline);
  if (!Number.isFinite(deadline) || deadline < 1 || deadline > MAX_TIMEOUT_MS) {
    throw new Error(`timeout must be within [1, ${MAX_TIMEOUT_MS}] ms`);
  }
  const store = useStore ? await loadStore() : {};
  const sandbox = new CodemodeSandbox({
    tools: TOOLS,
    timeoutMs: deadline,
    memoryLimitBytes: MEMORY_LIMIT_BYTES,
  });
  try {
    const raw = await sandbox.execute(code, { store, signal });
    if (useStore && raw.ok) {
      for (const key of raw.storeWrites.delete) delete store[key];
      Object.assign(store, raw.storeWrites.set);
      if (raw.storeWrites.delete.length > 0 || Object.keys(raw.storeWrites.set).length > 0) {
        await saveStore(store);
      }
    }
    const { output, truncated } = applyOutputBudget(raw.output, options.maxOutputTokens);
    return { result: { ...raw, output }, options, truncated, storePath: useStore ? STORE_PATH : null };
  } finally {
    await sandbox.close();
  }
}
