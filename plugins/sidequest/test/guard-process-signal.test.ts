'use strict';

// SQ-224: on 2026-09-28 one executor, clearing what it took to be its own stuck `cargo test`, killed a
// different ticket's verify run in another worktree. Nothing refused it: eight PreToolUse Bash guards x
// four process-signal commands were 32/32 silent-allow. The mechanism is target SELECTION, not the signal,
// so the guard denies a kill that picks its targets by pattern or by search and allows one that names a pid
// or job spec this shell owns.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'guard-process-signal.js');

function decide(command: string, toolName = 'Bash'): { decision: 'deny' | 'allow'; reason: string } {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  const out = result.stdout.trim();
  if (!out) return { decision: 'allow', reason: '' };
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse', out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', out);
  return { decision: 'deny', reason: String(parsed.hookSpecificOutput.permissionDecisionReason) };
}

function assertDecisions(cases: Array<[string, 'deny' | 'allow', string?]>): void {
  for (const [command, expected, toolName] of cases) {
    assert.equal(decide(command, toolName).decision, expected, `${expected.toUpperCase()} expected for: ${command}`);
  }
}

test('process-signal guard: the 2026-09-28 cross-worktree kill forms are denied', () => {
  assertDecisions([
    ['pkill -f cargo', 'deny'],
    ['pkill -9 -f "npm run test:full"', 'deny'],
    ['killall -9 node', 'deny'],
    ['killall node', 'deny'],
    ['pgrep -f cargo | xargs kill', 'deny'],
    ["ps -ax | grep test:full | awk '{print $1}' | xargs kill -9", 'deny'],
    ['xargs -n 1 kill -9', 'deny'],
    ['kill $(pgrep -f cargo)', 'deny'],
    ['kill -9 "$(pgrep -f \'npm run test:full\')"', 'deny'],
    ['pids=$(pgrep -f cargo); kill $pids', 'deny'],
    ['for p in $(pgrep -f cargo); do kill $p; done', 'deny'],
    ['sudo pkill node', 'deny'],
    ['timeout 600 pkill -f cargo', 'deny'],
    ['bash -c "pkill -f cargo"', 'deny'],
    ['/usr/bin/pkill -f cargo', 'deny'],
    ['cargo build && pkill -f cargo', 'deny'],
    ['taskkill /IM node.exe /F', 'deny', 'PowerShell'],
    ['taskkill /FI "IMAGENAME eq node.exe"', 'deny', 'PowerShell'],
    ['Stop-Process -Name node -Force', 'deny', 'PowerShell'],
    ['Get-Process node | Stop-Process -Force', 'deny', 'PowerShell'],
  ]);
});

test('process-signal guard: an own-shell kill and a read-only process listing stay allowed', () => {
  assertDecisions([
    ['kill %1', 'allow'],
    ['kill $!', 'allow'],
    ['kill -TERM "$pid"', 'allow'],
    ['kill -9 "$(cat run.pid)"', 'allow'],
    // A literal pid is not pattern-selected, so the guard cannot tell it from one this attempt spawned;
    // the "Sibling liveness" instruction covers it instead. Denying it here would block own cleanup.
    ['kill -9 48213', 'allow'],
    ['taskkill /PID 4821 /F', 'allow', 'PowerShell'],
    ['Stop-Process -Id 4821', 'allow', 'PowerShell'],
    ['pgrep -f cargo', 'allow'],
    ['ps -ax | grep cargo', 'allow'],
    ['docker ps -q | xargs docker kill', 'allow'],
  ]);
});

test('process-signal guard: naming a kill in data or in another command is not killing', () => {
  assertDecisions([
    ['grep -rn pkill plugins/sidequest/src', 'allow'],
    ['man pkill', 'allow'],
    ['echo "use pkill -f cargo" > notes.md', 'allow'],
    ["cat > notes.md <<'EOF'\npkill -f cargo\nkillall node\nEOF", 'allow'],
    ['npm run test:files test/guard-process-signal.test.ts', 'allow'],
    ['git log --oneline -1', 'allow'],
  ]);
});

test('process-signal guard: the denial names the wrapper and TaskStop and fits its context budget', () => {
  const { reason } = decide('pkill -f cargo');
  assert.match(reason, /verify wrapper itself, which kills the process group it spawned/);
  assert.match(reason, /stopped with TaskStop/);
  assert.match(reason, /kill "\$pid"/);
  assert.match(reason, /SQ-224/);
  for (const command of ['pkill -f cargo', 'killall node', 'pgrep -f x | xargs kill', 'Stop-Process -Name node']) {
    const bytes = Buffer.byteLength(decide(command, 'PowerShell').reason, 'utf8');
    assert.ok(bytes > 0 && bytes <= 768, `${command}: denial is ${bytes} bytes, past the PreToolUse budget`);
  }
});

test('process-signal guard: a non-shell tool and an empty command are left alone', () => {
  assert.equal(decide('pkill -f cargo', 'Write').decision, 'allow');
  assert.equal(decide('', 'Bash').decision, 'allow');
});

export {};
