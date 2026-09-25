'use strict';

import type { VerificationRequirement, VerificationResult } from '../kernel/verification.js';

const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

export type ProcessVerificationOptions = Readonly<{
  cwd?: string;
  timeoutMilliseconds?: number;
  logPath?: string;
  outputTailBytes?: number;
  environment?: NodeJS.ProcessEnv;
}>;

export type VerificationProcessPort = Readonly<{
  run(requirement: VerificationRequirement, options?: ProcessVerificationOptions): VerificationResult;
}>;

// Ordinary verification commands retain a short failure backstop. Full-suite capture opts into
// its capacity-derived timeout explicitly because that suite owns a calibrated phase budget.
export const defaultVerificationTimeoutMilliseconds = 10 * 60 * 1_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 16 * 1024;
const COMMAND_NOT_FOUND_EXIT_CODES = new Set([127, 9009]);

type ShellDefinition = Readonly<{
  executable: string;
  label: string;
  scriptExtension: '.cmd' | '.sh';
}>;

type ShellCommand = ShellDefinition & Readonly<{ arguments: readonly string[] }>;

function windowsPosixShell(): string | null {
  const programFilesDirectories = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((directory): directory is string => Boolean(directory));
  const candidates = [...new Set(programFilesDirectories.map((directory) => path.join(directory, 'Git', 'bin', 'sh.exe')))];
  const installedShell = candidates.find((candidate) => fs.existsSync(candidate));
  if (installedShell) return installedShell;
  const discovered = spawnSync('where.exe', ['sh.exe'], { encoding: 'utf8', windowsHide: true });
  if (discovered.status !== 0) return null;
  return String(discovered.stdout || '')
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => fs.existsSync(candidate)) || null;
}

function shellDefinition(platform = process.platform): ShellDefinition {
  if (platform === 'win32') {
    const posixShell = windowsPosixShell();
    if (posixShell) return Object.freeze({ executable: posixShell, label: `POSIX shell (${posixShell})`, scriptExtension: '.sh' });
    const commandPrompt = process.env.ComSpec || 'cmd.exe';
    return Object.freeze({ executable: commandPrompt, label: `Command Prompt (${commandPrompt})`, scriptExtension: '.cmd' });
  }
  const posixShell = process.env.SHELL || '/bin/sh';
  return Object.freeze({ executable: posixShell, label: `POSIX shell (${posixShell})`, scriptExtension: '.sh' });
}

function commandForShell(scriptPath: string, shell: ShellDefinition): ShellCommand {
  const arguments_ = shell.scriptExtension === '.cmd'
    ? Object.freeze(['/d', '/s', '/c', scriptPath])
    : Object.freeze([scriptPath]);
  return Object.freeze({ ...shell, arguments: arguments_ });
}

function shellCommand(scriptPath: string, platform = process.platform): ShellCommand {
  return commandForShell(scriptPath, shellDefinition(platform));
}

function shellScript(command: string, shell: ShellDefinition): string {
  if (shell.scriptExtension === '.cmd') {
    return [
      '@echo off',
      `"%ComSpec%" /d /s /c "${command}"`,
      'set "sidequestExitCode=%ERRORLEVEL%"',
      'echo __SIDEQUEST_VERIFY_EXIT__=%sidequestExitCode%',
      'exit /b %sidequestExitCode%',
      '',
    ].join('\r\n');
  }
  return `(\n${command}\n)\nsidequest_exit_code=$?\nprintf '\\n__SIDEQUEST_VERIFY_EXIT__=%s\\n' "$sidequest_exit_code"\nexit "$sidequest_exit_code"\n`;
}

function temporaryScript(command: string): Readonly<{ scriptPath: string; shell: ShellCommand }> {
  const shell = shellDefinition();
  const scriptPath = path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}${shell.scriptExtension}`);
  fs.writeFileSync(scriptPath, shellScript(command, shell), { encoding: 'utf8', flag: 'wx', mode: 0o700 });
  return Object.freeze({ scriptPath, shell: commandForShell(scriptPath, shell) });
}

function defaultLogPath(): string {
  return path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}.log`);
}

function markerExitCode(logPath: string): number | null {
  const output = fs.readFileSync(logPath, 'utf8');
  const matches = [...output.matchAll(/^__SIDEQUEST_VERIFY_EXIT__=(\d+)$/gm)];
  const marker = matches.at(-1);
  return marker ? Number(marker[1]) : null;
}

function outputTail(logPath: string, maximumBytes: number): string {
  const size = fs.statSync(logPath).size;
  const length = Math.min(size, maximumBytes);
  if (!length) return '';
  const file = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(file, buffer, 0, length, size - length);
    return `${size > length ? '[output truncated]\n' : ''}${buffer.toString('utf8')}`.trim();
  } finally {
    fs.closeSync(file);
  }
}

function commandNotFound(logPath: string, exitCode: number): boolean {
  if (COMMAND_NOT_FOUND_EXIT_CODES.has(exitCode)) return true;
  if (process.platform !== 'win32' || exitCode !== 1) return false;
  return /^'[^']+' is not recognized as an internal or external command,$/m.test(fs.readFileSync(logPath, 'utf8'));
}

function missingCommandName(logPath: string): string | null {
  const output = fs.readFileSync(logPath, 'utf8');
  const windowsMatch = output.match(/^'([^']+)' is not recognized as an internal or external command,$/m);
  if (windowsMatch?.[1]) return windowsMatch[1];
  for (const line of output.split(/\r?\n/)) {
    const posixMatch = line.match(/(?:^|:\s)([^:\s]+): (?:command )?not found$/);
    if (posixMatch?.[1]) return posixMatch[1];
  }
  return null;
}

function shellCannotParsePosixSyntax(logPath: string, exitCode: number, shell: ShellCommand): boolean {
  if (exitCode !== 1 || shell.scriptExtension !== '.cmd') return false;
  return /^'!' is not recognized as an internal or external command,$/m.test(fs.readFileSync(logPath, 'utf8'));
}

function processTimedOut(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT';
}

// spawnSync's timeout signals only the shell it started. A verify command's own children (for
// example per-file `node --test` runners) share the shell's process group, so they would keep
// running after the timeout and starve the next verification. POSIX verification therefore runs
// in its own process group, and a timeout terminates that whole group.
const PROCESS_GROUP_TERMINATE_GRACE_MILLISECONDS = 5_000;
const PROCESS_GROUP_KILL_SETTLE_MILLISECONDS = 1_000;
const PROCESS_GROUP_POLL_MILLISECONDS = 50;
const ownsProcessGroup = process.platform !== 'win32';

type ProcessGroupTermination = Readonly<{
  groupId: number;
  signals: readonly NodeJS.Signals[];
  survivors: boolean;
}>;

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function waitForProcessGroupExit(groupId: number, milliseconds: number): boolean {
  const deadline = Date.now() + milliseconds;
  while (processGroupAlive(groupId)) {
    if (Date.now() >= deadline) return false;
    sleepSynchronously(PROCESS_GROUP_POLL_MILLISECONDS);
  }
  return true;
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessGroup(groupId: number | undefined): ProcessGroupTermination | null {
  // A group id of 0 or 1 would address this process's own group or every process; never signal it.
  if (!ownsProcessGroup || typeof groupId !== 'number' || !Number.isInteger(groupId) || groupId <= 1 || groupId === process.pid) return null;
  const signals: NodeJS.Signals[] = [];
  if (!signalProcessGroup(groupId, 'SIGTERM')) return Object.freeze({ groupId, signals: Object.freeze(signals), survivors: false });
  signals.push('SIGTERM');
  if (!waitForProcessGroupExit(groupId, PROCESS_GROUP_TERMINATE_GRACE_MILLISECONDS) && signalProcessGroup(groupId, 'SIGKILL')) {
    signals.push('SIGKILL');
    waitForProcessGroupExit(groupId, PROCESS_GROUP_KILL_SETTLE_MILLISECONDS);
  }
  return Object.freeze({ groupId, signals: Object.freeze(signals), survivors: processGroupAlive(groupId) });
}

function processGroupTerminationNote(termination: ProcessGroupTermination | null): string {
  if (termination === null) return 'The verify process tree was not signalled beyond the shell (no owned process group on this platform).';
  if (termination.signals.length === 0) return `Process group ${termination.groupId} had already exited; no descendants survived.`;
  const sequence = termination.signals.includes('SIGKILL')
    ? `SIGTERM, then SIGKILL after a ${PROCESS_GROUP_TERMINATE_GRACE_MILLISECONDS}ms grace period`
    : 'SIGTERM';
  return termination.survivors
    ? `Killed process group ${termination.groupId} (${sequence}), but descendants were still present afterwards.`
    : `Killed process group ${termination.groupId} (${sequence}); no descendants survived.`;
}

function recordProcessGroupTermination(logPath: string, note: string): void {
  try {
    fs.appendFileSync(logPath, `\n[sidequest] Verification timed out. ${note}\n`);
  } catch {
    // The returned evidence still carries the note when the log cannot be appended.
  }
}

function failedResult(requirement: VerificationRequirement, status: 'failed_suite' | 'toolchain_missing' | 'could_not_run' | 'timeout', command: string, logPath: string, reason: string, exitCode: number | null, tail: string, timeoutMilliseconds?: number, shell?: string): VerificationResult {
  const identity = exitCode == null ? status : `${status}:exit-${exitCode}`;
  return Object.freeze({
    kind: requirement.kind,
    status,
    evidence: reason,
    command,
    logPath,
    exitCode,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    ...(shell === undefined ? {} : { shell }),
    outputTail: tail || null,
    failureIdentities: Object.freeze([identity]),
  });
}

export function runProcessVerification(requirement: VerificationRequirement, options: ProcessVerificationOptions = {}): VerificationResult {
  const command = String(requirement.command || '').trim();
  if (!command) {
    return Object.freeze({
      kind: requirement.kind,
      status: 'could_not_run',
      evidence: 'The required command verifier has no pinned command.',
      command: null,
      failureIdentities: Object.freeze(['could_not_run:missing-command']),
    });
  }
  const logPath = options.logPath || defaultLogPath();
  const timeoutMilliseconds = options.timeoutMilliseconds || defaultVerificationTimeoutMilliseconds;
  const outputTailBytes = options.outputTailBytes || DEFAULT_OUTPUT_TAIL_BYTES;
  const temporary = temporaryScript(command);
  const { scriptPath, shell } = temporary;
  let outcome: import('node:child_process').SpawnSyncReturns<Buffer> | null = null;
  try {
    const log = fs.openSync(logPath, 'w');
    try {
      outcome = spawnSync(shell.executable, shell.arguments, {
        cwd: options.cwd || process.cwd(),
        env: options.environment,
        windowsHide: true,
        detached: ownsProcessGroup,
        timeout: timeoutMilliseconds,
        stdio: ['ignore', log, log],
      });
    } finally {
      fs.closeSync(log);
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return failedResult(requirement, 'could_not_run', command, logPath, reason, 2, fs.existsSync(logPath) ? outputTail(logPath, outputTailBytes) : '', undefined, shell.label);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
  if (processTimedOut(outcome?.error)) {
    const note = processGroupTerminationNote(terminateProcessGroup(outcome?.pid));
    recordProcessGroupTermination(logPath, note);
    return failedResult(requirement, 'timeout', command, logPath, `Verification timed out after ${timeoutMilliseconds}ms; partial output captured. ${note}`, 2, outputTail(logPath, outputTailBytes), timeoutMilliseconds, shell.label);
  }
  const tail = outputTail(logPath, outputTailBytes);
  const exitCode = markerExitCode(logPath);
  if (exitCode === null) {
    const shellExitCode = outcome?.status ?? (outcome?.error ? 2 : null);
    return failedResult(requirement, 'could_not_run', command, logPath, `The ${shell.label} exited ${shellExitCode ?? 'without a code'} before reporting the suite exit code.`, shellExitCode, tail, undefined, shell.label);
  }
  if (shellCannotParsePosixSyntax(logPath, exitCode, shell)) {
    return failedResult(requirement, 'could_not_run', command, logPath, `The ${shell.label} fallback could not parse POSIX syntax while running ${JSON.stringify(command)} (exit code ${exitCode}).`, exitCode, tail, undefined, shell.label);
  }
  if (commandNotFound(logPath, exitCode)) {
    const missingCommand = missingCommandName(logPath);
    const missingCommandEvidence = missingCommand ? `command ${JSON.stringify(missingCommand)}` : 'a command';
    return failedResult(requirement, 'toolchain_missing', command, logPath, `The verification environment could not find ${missingCommandEvidence} while running ${JSON.stringify(command)} (exit code ${exitCode}).`, exitCode, tail, undefined, shell.label);
  }
  if (exitCode === 0) {
    return Object.freeze({ kind: requirement.kind, status: 'passed', evidence: requirement.evidenceContract, command, logPath, exitCode, shell: shell.label });
  }
  return failedResult(requirement, 'failed_suite', command, logPath, `The required command exited ${exitCode}.`, exitCode, tail, undefined, shell.label);
}

export function createProcessPort(): VerificationProcessPort {
  return Object.freeze({ run: runProcessVerification });
}

export { shellCommand };
