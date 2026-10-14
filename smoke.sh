#!/usr/bin/env bash
# muse-codemode public smoke test.
#   ./smoke.sh                                # tests `codemode` from PATH
#   CODEMODE_BIN="node $PWD/cli.mjs" ./smoke.sh   # tests a fresh checkout
set -u

BIN_STR="${CODEMODE_BIN:-codemode}"
# Split on spaces so CODEMODE_BIN="node $PWD/cli.mjs" works; executed as an
# array (never `eval`) to stay safe.
# shellcheck disable=SC2206
BIN_ARR=($BIN_STR)
run() { "${BIN_ARR[@]}" "$@"; }

PASS=0; FAIL=0; SKIP=0
TMP="$(mktemp -d)"
SCRATCH="$HOME/.cache/muse-codemode-smoke-$$"
mkdir -p "$SCRATCH"
trap 'rm -rf "$TMP" "$SCRATCH"' EXIT

ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1 | $2"; }

# 1: basic text() + return
cat > "$TMP/t1.js" <<'EOF'
text("hello codemode");
return { answer: 40 + 2, msg: "done" };
EOF
out="$(run "$TMP/t1.js" 2>"$TMP/e1")"; ec=$?
if [ $ec -eq 0 ] && [[ "$out" == *"hello codemode"* ]] && [[ "$out" == *'"answer":42'* ]]; then
  ok "1 basic text()+return (exit 0)"
else bad "1 basic" "ec=$ec out=[$out]"; fi

# 2: read a real file (fixture under $HOME so the tool accepts it)
echo "fixture-data-123" > "$SCRATCH/fixture.txt"
cat > "$TMP/t2.js" <<EOF
const src = await tools.read({ path: "$SCRATCH/fixture.txt" });
text("bytes " + src.length);
return src.trim();
EOF
out="$(run "$TMP/t2.js" 2>"$TMP/e2")"; ec=$?
if [ $ec -eq 0 ] && [[ "$out" == *"bytes 17"* ]] && [[ "$out" == *"=> fixture-data-123"* ]]; then
  ok "2 tools.read real file (exit 0)"
else bad "2 read" "ec=$ec out=[$out]"; fi

# 2b: write then read back
cat > "$TMP/t2b.js" <<EOF
const w = await tools.write({ path: "$SCRATCH/out.txt", content: "written-ok" });
const back = await tools.read({ path: "$SCRATCH/out.txt" });
text("bytes=" + w.bytes);
return back;
EOF
out="$(run "$TMP/t2b.js" 2>"$TMP/e2b")"; ec=$?
if [ $ec -eq 0 ] && [[ "$out" == *"bytes=10"* ]] && [[ "$out" == *"=> written-ok"* ]]; then
  ok "2b tools.write+read roundtrip (exit 0)"
else bad "2b write" "ec=$ec out=[$out]"; fi

# 3: exec a real command
cat > "$TMP/t3.js" <<'EOF'
const r = await tools.exec({ command: "echo", args: ["hello-from-exec"] });
text("exit=" + r.exitCode);
return r.stdout.trim();
EOF
out="$(run "$TMP/t3.js" 2>"$TMP/e3")"; ec=$?
if [ $ec -eq 0 ] && [[ "$out" == *"exit=0"* ]] && [[ "$out" == *"=> hello-from-exec"* ]]; then
  ok "3 tools.exec real command (exit 0)"
else bad "3 exec" "ec=$ec out=[$out]"; fi

# 4: tool throw propagates out
cat > "$TMP/t4.js" <<EOF
await tools.read({ path: "$SCRATCH/does-not-exist.txt" });
EOF
out="$(run "$TMP/t4.js" 2>"$TMP/e4")"; ec=$?
if [ $ec -eq 1 ] && grep -q '\[script\]' "$TMP/e4" && grep -q 'ENOENT' "$TMP/e4"; then
  ok "4 tool throw -> error [script] (exit 1)"
else bad "4 throw" "ec=$ec stderr=[$(cat "$TMP/e4")]"; fi

# 5: infinite loop -> timeout, runner must not hang
cat > "$TMP/t5.js" <<'EOF'
// @options: {"timeout_ms": 2500}
while (true) {}
EOF
SECONDS=0
out="$(timeout 30 "${BIN_ARR[@]}" "$TMP/t5.js" 2>"$TMP/e5")"; ec=$?
elapsed=$SECONDS
if [ $ec -eq 2 ] && grep -q '\[timeout\]' "$TMP/e5" && [ "$elapsed" -lt 15 ]; then
  ok "5 infinite loop -> [timeout] in ${elapsed}s (exit 2)"
else bad "5 hang" "ec=$ec elapsed=${elapsed}s stderr=[$(cat "$TMP/e5")]"; fi

# 6a: // @options: max_output_tokens truncation applies
cat > "$TMP/t6a.js" <<'EOF'
// @options: {"max_output_tokens": 5}
text("abcdefghijklmnopqrstuvwxyz0123456789");
return "ok";
EOF
out="$(run "$TMP/t6a.js" 2>"$TMP/e6a")"; ec=$?
if [ $ec -eq 0 ] && [[ "$out" == *"[output truncated to max_output_tokens=5]"* ]] && [[ "$out" == *"=> ok"* ]]; then
  ok "6a max_output_tokens truncation applies (exit 0)"
else bad "6a options" "ec=$ec out=[$out]"; fi

# 6b: bad // @options: line -> exit 5
cat > "$TMP/t6b.js" <<'EOF'
// @options: {invalid json
return 1;
EOF
run "$TMP/t6b.js" >"$TMP/o6b" 2>"$TMP/e6b"; ec=$?
if [ $ec -eq 5 ] && grep -q 'bad options line' "$TMP/e6b"; then
  ok "6b invalid options line (exit 5)"
else bad "6b bad options" "ec=$ec stderr=[$(cat "$TMP/e6b")]"; fi

# 7: fresh login shell, empty env, no manual sourcing
out="$(env -i HOME="$HOME" CODEMODE_BIN="$BIN_STR" bash --login -c 'echo "text(\"via-login\"); return 7*6" | $CODEMODE_BIN' 2>"$TMP/e7")"; ec=$?
if [ $ec -eq 0 ] && [[ "$out" == *"via-login"* ]] && [[ "$out" == *"=> 42"* ]]; then
  ok "7 fresh login shell, empty env (exit 0)"
else bad "7 login shell" "ec=$ec out=[$out] stderr=[$(cat "$TMP/e7")]"; fi

# declarations sanity
if run --declarations 2>/dev/null | grep -q 'declare const tools'; then
  ok "declarations render"
else bad "declarations" "no 'declare const tools' in output"; fi

echo "----"
echo "smoke: $PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
