# muse-codemode

Run model-written JavaScript in a QuickJS sandbox (worker thread) with a default
set of system tools. Built on
[`@earendil-works/pi-codemode`](https://github.com/earendil-works/pi/tree/main/packages/codemode).

The sandbox's only capability is calling injected tools; nested tool calls never
enter the LLM context — only the script's output and return value do. Ideal for
batching a chain of read/write/run/MCP steps into one script instead of many
individual tool calls.

## Install

Requires Node.js >= 22.

```bash
git clone https://github.com/thoitiettxl-cyber/muse-codemode.git
cd muse-codemode
npm install          # @earendil-works/pi-codemode pinned exact
ln -s "$PWD/cli.mjs" ~/.local/bin/codemode   # or: npm link
```

## Usage

```bash
codemode script.js                 # run a script from a file
echo 'return 6*7' | codemode       # or from stdin
codemode --declarations            # TypeScript declarations of the default tools
codemode --json script.js          # single machine-readable JSON result
codemode --timeout-ms 120000 script.js
codemode --no-store script.js      # skip persistent store()/load()
```

A script is the body of an async function: top-level `await` and `return` work.
The first line may be an options line:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}

const src = await tools.read({ path: "notes/todo.md" });
const r = await tools.exec({ command: "wc", args: ["-l", "notes/todo.md"] });
text(r.stdout);
return src.length;
```

Available in scripts: `tools.read/write/exec/mcp`, `ALL_TOOLS`, `text()`,
`image()`, `console.*`, `exit()`, `store(key, value)` / `load(key)`
(persisted to `~/.config/codemode/store.json` unless `--no-store`).

Output: each `text()` item on its own line, then `=> <return value>`.
Exit codes: `0` ok, `1` script error, `2` timeout, `3` aborted,
`4` sandbox/host failure, `5` bad `// @options:` line, `6` usage error.

## Default tools

| tool | description |
| ---- | ----------- |
| `read({path, encoding?, maxBytes?})` | Read a file under `$HOME` (relative paths resolve against `$HOME`) |
| `write({path, content, encoding?})` | Write a file under `$HOME`, creating parent dirs |
| `exec({command, args?, cwd?, timeoutMs?, shell?, maxOutputBytes?})` | Run a command; **always has a timeout** (default 30s, max 120s) — a hanging command is SIGKILLed and reported as an error. `cwd` defaults to `$HOME` and must stay under it. `shell:true` for pipes/globs via bash |
| `mcp({server, name, args?, timeoutMs?})` | Call a tool on a registered MCP server via the `mcp` CLI |

All filesystem paths are validated to stay under `$HOME`. Run
`codemode --declarations` for the exact current signatures.

> Note: the `mcp` tool shells out to `~/.local/bin/mcp`. On machines without
> that CLI the `mcp` tool fails, while `read`/`write`/`exec` work standalone.

## Smoke test

```bash
./smoke.sh                              # tests `codemode` from PATH
CODEMODE_BIN="node $PWD/cli.mjs" ./smoke.sh   # tests a fresh checkout
```

Covers: basic `text()`+`return`, `read`, `write`, `exec`, tool-throw propagation,
infinite-loop timeout, `// @options:` parsing/truncation, and a fresh login shell.

## License

MIT
