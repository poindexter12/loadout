'use strict';

// SQ-251: the home-delete guard tokenizes each delete's arguments. A recursive flag must be
// an option token (not `-r` inside `pr-reviews`), and a protected target must resolve to the
// home directory, home/.claude, an ancestor of home, or a filesystem root (not any `~/...`).
// SQ-260: an ssh payload is scanned as a remote shell command against a distinct remote set.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'guard-home-delete.js');
const HOME = os.homedir();

const LOCAL_REASON = /recursive delete aimed at the user profile or \.claude root/;
const REMOTE_REASON = /recursive delete of remote profile root \(matched /;

function decision(command: string, toolName = 'Bash', reason: RegExp = LOCAL_REASON): 'deny' | 'allow' {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  const out = result.stdout.trim();
  if (!out) return 'allow';
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', out);
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, reason, command);
  return 'deny';
}

function assertDecisions(cases: Array<[string, 'deny' | 'allow', string?, RegExp?]>) {
  for (const [command, expected, toolName, reason] of cases) {
    assert.equal(decision(command, toolName, reason), expected, `${expected.toUpperCase()} expected for: ${command}`);
  }
}

test('home-delete guard: the 2026-09-30 false positives are allowed', () => {
  assertDecisions([
    ['rmdir ~/.cache/pr-reviews/git.lock', 'allow'],
    ['rm ~/.cache/pr-reviews/blocked', 'allow'],
    ['rmdir ~/.cache/myapp/git.lock', 'allow'],
    ['rm -rf ~/.cache/myapp', 'allow'],
    ['cat notes.md; rmdir ~/.cache/pr-reviews/git.lock', 'allow'],
    ["cat > rules/release-lock.md <<'EOF'\nRelease the lock with `rmdir ~/.cache/pr-reviews/git.lock`.\nEOF", 'allow'],
  ]);
});

test('home-delete guard: a hyphenated path segment is not a recursive flag', () => {
  assertDecisions([
    ['rm ~/foo-repo', 'allow'],
    ['rm ~/my-rust', 'allow'],
    ['rm -f ~/.cache/pr-reviews', 'allow'],
    ['rm -rf ./my-repo', 'allow'],
    ['rm -rf ~/.claude/plugins/cache/x', 'allow'],
    ['rm -rf "$HOME/.cache/pr-reviews"', 'allow'],
    ['rm -rf ${HOME}/.cache/x', 'allow'],
    ['Remove-Item -Recurse -Force $env:USERPROFILE\\.cache\\x', 'allow', 'PowerShell'],
    ['rm -rf ~/.cache/*', 'allow'],
    ['rm -rf "$tmp/build"', 'allow'],
    ['rm -r -- -reviews', 'allow'],
  ]);
});

test('home-delete guard: recursive deletes of the profile, .claude, a parent, or the root stay denied', () => {
  assertDecisions([
    ['rm -rf ~', 'deny'],
    ['rm -rf ~/', 'deny'],
    ['rm -rf $HOME', 'deny'],
    ['rm -rf "$HOME"', 'deny'],
    ['rm -rf ${HOME}', 'deny'],
    ['rm -r ~/.claude', 'deny'],
    ['rm -fr ~/.claude/', 'deny'],
    ['rm -R ~/.claude', 'deny'],
    ['rm --recursive ~', 'deny'],
    ['rm -rf /', 'deny'],
    ['rm -rf ~/..', 'deny'],
    ['rm -rf ~/*', 'deny'],
    ['rm -rf ~/.c*', 'deny'],
    ['rm -rf /*', 'deny'],
    [`rm -rf ${HOME}`, 'deny'],
    [`rm -rf "${path.dirname(HOME)}"`, 'deny'],
    [`rm -rf ${path.join(HOME, '.claude', 'plugins', '..', '..')}`, 'deny'],
    ['rm -rf ~/.cache/pr-reviews ~', 'deny'],
    ['cat notes.md; rm -rf ~', 'deny'],
    ['Remove-Item -Recurse -Force $env:USERPROFILE', 'deny', 'PowerShell'],
    ['Remove-Item -Path ~ -Recurse', 'deny', 'PowerShell'],
    ['Remove-Item -Recurse -Force $home', 'deny', 'PowerShell'],
    ['rd /s %USERPROFILE%', 'deny', 'PowerShell'],
    ['rd /s /q %USERPROFILE%\\', 'deny', 'PowerShell'],
  ]);
});

// Ported from SQ-121. Every deny below is allowed by SQ-251's delivered guard except the two
// unquoted forms, which it denies as a LOCAL wipe; quoting is what hides a payload from the
// local scan, so these cases fail on the base guard and pass on the port.
test('home-delete guard scans ssh payloads as remote shell commands', () => {
  assertDecisions([
    ["ssh host 'rm -rf ~'", 'deny', 'Bash', REMOTE_REASON],
    ['ssh host "rm -rf ~"', 'deny', 'Bash', REMOTE_REASON],
    ['ssh host rm -rf ~', 'deny', 'Bash', REMOTE_REASON],
    ["ssh host 'rm -rf ~/'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh host 'rm -rf ~/.claude'", 'deny', 'Bash', REMOTE_REASON],
    ['ssh host rm -rf ~/.claude', 'deny', 'Bash', REMOTE_REASON],
    ["ssh host 'rm -rf $HOME'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh host 'rm -rf /'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh host 'rm -rf /home/remote'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh host 'rm -rf /home/remote/.claude'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh host 'rm -rf /root'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh host 'rm -rf /home/*'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh -p 2222 host 'rm -rf ~'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh -o StrictHostKeyChecking=no host 'rm -rf ~'", 'deny', 'Bash', REMOTE_REASON],
    ["ssh host '\nrm -rf ~\n'", 'deny', 'Bash', REMOTE_REASON],
    ["cat notes.md; ssh host 'rm -rf ~'", 'deny', 'Bash', REMOTE_REASON],
    ['ssh a \'ssh b "rm -rf ~"\'', 'deny', 'Bash', REMOTE_REASON],
  ]);
});

// The remote set is distinct from the local one and must not reintroduce SQ-251's false
// positives: an ordinary remote subdirectory stays deletable, recursively or not.
test('home-delete guard allows ordinary remote targets', () => {
  assertDecisions([
    ["ssh host 'rm ~/subdir'", 'allow'],
    ["ssh host 'rm -rf ~/subdir'", 'allow'],
    ['ssh host rm -rf ~/subdir', 'allow'],
    ["ssh host 'rm -rf ~/mainsail'", 'allow'],
    ["ssh host 'rm -rf ~/.cache/pr-reviews'", 'allow'],
    ["ssh host 'rm -rf $HOME/mainsail'", 'allow'],
    ["ssh host 'rm -rf /home/remote/mainsail'", 'allow'],
    ["ssh host 'rm -rf /tmp/build'", 'allow'],
    ["ssh host 'rmdir ~/.cache/pr-reviews/git.lock'", 'allow'],
    ['ssh host uptime', 'allow'],
  ]);
});

test('home-delete guard: unexpandable variables stay conservative when they could be a protected root', () => {
  assertDecisions([
    ['rm -rf "$target"', 'deny'],
    ['rm -rf $TARGET/', 'deny'],
    ['rm -rf "$(dirname "$x")"', 'deny'],
    ['rm -rf "$base/.claude"', 'deny'],
    ['rm -rf "$x/.."', 'deny'],
    ['rm -rf ~someone', 'deny'],
    ['rm -f "$target"', 'allow'],
  ]);
});
