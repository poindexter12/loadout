import fs from 'node:fs';
import path from 'node:path';
import { resolveClaudeHome } from './claude-home.js';

// SQ-402: the Agent guard backgrounds every main-session Agent spawn that is not a Sidequest
// executor. The foreground list names agent types that keep running in the foreground instead.
//
// It lives in Claude Code's own settings files under a namespaced key:
//
//   { "sidequest": { "foregroundAgents": ["sg:spec-interviewer"] } }
//
// Claude Code 2.1.328 loads a settings file carrying an unknown top-level key without a
// validation error (verified 2026-11-18: a file with only an unknown key plus `env` loaded,
// while a control file with `"permissions": "not-an-object"` was reported as "did not load"),
// so the key can sit beside Claude Code's own settings.
//
// Precedence follows Claude Code's normal order, most specific first:
//   1. <project>/.claude/settings.local.json
//   2. <project>/.claude/settings.json
//   3. <claude home>/settings.json (CLAUDE_CONFIG_DIR, else ~/.claude): the user default
// Merge rule: REPLACE, not union. The most specific file that defines the key supplies the
// whole list, so a project can drop a type the user list names; an explicit empty array means
// "no extra foreground types here". A file whose value is not an array is treated as not
// defining the key. The built-in harness utilities below are always foreground whatever the
// configured list says.
export const BUILTIN_FOREGROUND_AGENT_TYPES: readonly string[] = Object.freeze(['Explore', 'claude-code-guide', 'statusline-setup']);
export const FOREGROUND_SETTINGS_NAMESPACE = 'sidequest';
export const FOREGROUND_SETTINGS_FIELD = 'foregroundAgents';

export type ForegroundSource = 'project-local' | 'project' | 'user' | 'none';

export interface ForegroundResolution {
  types: string[];
  source: ForegroundSource;
  path: string | null;
}

export interface ForegroundOptions {
  projectDir?: string | null;
  claudeHome?: string | null;
}

// Returns the list a settings file defines, or null when the file is missing, unreadable,
// not JSON, or does not define the key as an array.
export function readForegroundAgents(settingsPath: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const namespace = (parsed as Record<string, unknown>)[FOREGROUND_SETTINGS_NAMESPACE];
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) return null;
  const list = (namespace as Record<string, unknown>)[FOREGROUND_SETTINGS_FIELD];
  if (!Array.isArray(list)) return null;
  return [...new Set(list.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))];
}

export function foregroundSettingsCandidates(options: ForegroundOptions = {}): Array<{ source: Exclude<ForegroundSource, 'none'>; path: string }> {
  const candidates: Array<{ source: Exclude<ForegroundSource, 'none'>; path: string }> = [];
  const projectDir = String(options.projectDir || '').trim();
  if (projectDir) {
    candidates.push({ source: 'project-local', path: path.join(projectDir, '.claude', 'settings.local.json') });
    candidates.push({ source: 'project', path: path.join(projectDir, '.claude', 'settings.json') });
  }
  candidates.push({ source: 'user', path: path.join(resolveClaudeHome(options.claudeHome), 'settings.json') });
  return candidates;
}

export function resolveForegroundAgents(options: ForegroundOptions = {}): ForegroundResolution {
  for (const candidate of foregroundSettingsCandidates(options)) {
    const types = readForegroundAgents(candidate.path);
    if (types) return { types, source: candidate.source, path: candidate.path };
  }
  return { types: [], source: 'none', path: null };
}

export function isForegroundAgentType(type: string, resolution: ForegroundResolution): boolean {
  return BUILTIN_FOREGROUND_AGENT_TYPES.includes(type) || resolution.types.includes(type);
}
