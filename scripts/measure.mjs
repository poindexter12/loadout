#!/usr/bin/env node
// Promoted from the SQ-11 spike. Estimates context volume, not dollar savings.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const DEFAULTS = { minTurns: 5, minChars: 8000 };
const KINDS = ['bulk-read', 'targeted-read', 'search', 'subagent', 'other', 'unmatched'];
const HELP = `Usage: node scripts/measure.mjs [options] <file.jsonl|directory> ...

Measure local Claude Code transcripts. Directories are shallow: only immediate
.jsonl files are read. Pass subagent directories explicitly to include them.
No network calls, transcript writes, raw content, commands or session IDs emitted.

  --min-turns N  Minimum usage-bearing assistant messages per file (default 5)
  --min-chars N  Minimum text characters for a bulk-read candidate (default 8000)
  --json         Emit aggregate JSON instead of text
  --help         Show this help
  --             End options (for paths starting with a dash)

Payload estimate: ceil(JS string length / 4), text only.
Carried estimate: payload tokens x later usage-bearing assistant messages until
an explicit compact_boundary or EOF, counted from result arrival, not tool call.
Message IDs deduplicate usage snapshots; the last snapshot wins. Missing IDs
fall back to record UUID, then line number. Duplicate UUID records are skipped.
Read offset/limit/pages and all piped/redirected Bash are classified as targeted;
only bare cat/head/tail/less/more commands otherwise qualify as bulk reads.
Candidates exclude error results. Malformed lines and unmatched results are counted.
These heuristics cannot establish avoidable cost, exact tokens or dollar savings.
See docs/src/content/docs/architecture/transcript-measurement.md for limitations.
`;

export function classify({ name, input = {} }) {
  input ??= {};
  if (name === 'Read') {
    return ['offset', 'limit', 'pages'].some((key) => input[key] != null)
      ? 'targeted-read' : 'bulk-read';
  }
  if (name === 'Bash' || name === 'BashOutput') {
    const command = String(input.command ?? '');
    if (/[|>]/.test(command)) return 'targeted-read';
    return /^\s*(cat|head|tail|less|more)\s/.test(command) ? 'bulk-read' : 'other';
  }
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'Agent' || name === 'Task') return 'subagent';
  return 'other';
}

function textChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0);
}

function emptyTotals() {
  return {
    assistantTurns: 0, inputTokens: 0, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, outputTokens: 0, observedInputTokens: 0,
    allResultOneShot: 0, allResultCarried: 0,
    candidateCount: 0, candidateOneShot: 0, candidateCarried: 0,
    malformedLines: 0, duplicateRecords: 0, missingMessageIds: 0,
    unmatchedResults: 0, nonTextBlocks: 0, compactionBoundaries: 0,
    byKind: Object.fromEntries(KINDS.map((kind) => [kind, { count: 0, oneShot: 0, carried: 0 }])),
  };
}

export async function analyseSession(file, { minChars = DEFAULTS.minChars } = {}) {
  const totals = emptyTotals();
  const uuids = new Set();
  const messages = new Map();
  const toolUses = new Map();
  let turns = 0;
  let results = [];
  let lineNumber = 0;
  const finishSegment = () => {
    for (const result of results) {
      const tokens = Math.ceil(result.chars / 4);
      const carried = tokens * Math.max(0, turns - result.arrivedAt);
      const kind = totals.byKind[result.kind];
      kind.count++;
      kind.oneShot += tokens;
      kind.carried += carried;
      totals.allResultOneShot += tokens;
      totals.allResultCarried += carried;
      if (result.kind === 'bulk-read' && !result.error && result.chars >= minChars) {
        totals.candidateCount++;
        totals.candidateOneShot += tokens;
        totals.candidateCarried += carried;
      }
    }
    results = [];
    turns = 0;
  };

  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { totals.malformedLines++; continue; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        totals.malformedLines++;
        continue;
      }
      if (record.uuid) {
        if (uuids.has(record.uuid)) { totals.duplicateRecords++; continue; }
        uuids.add(record.uuid);
      }
      if (record.type === 'system' && record.subtype === 'compact_boundary') {
        finishSegment();
        totals.compactionBoundaries++;
      }
      const message = record.message;
      const content = Array.isArray(message?.content) ? message.content : [];
      if (record.type === 'assistant') {
        const usage = message?.usage;
        if (usage && typeof usage === 'object') {
          const key = message.id || record.uuid || `line:${lineNumber}`;
          if (!messages.has(key)) {
            turns++;
            if (!message.id) totals.missingMessageIds++;
          }
          messages.set(key, usage);
        }
        for (const block of content) {
          if (block?.type === 'tool_use') toolUses.set(block.id, classify(block));
        }
      } else if (record.type === 'user') {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const kind = toolUses.get(block.tool_use_id) ?? 'unmatched';
          if (kind === 'unmatched') totals.unmatchedResults++;
          if (Array.isArray(block.content)) {
            totals.nonTextBlocks += block.content.filter((item) => typeof item?.text !== 'string').length;
          }
          results.push({ kind, chars: textChars(block.content), arrivedAt: turns, error: block.is_error === true });
        }
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  finishSegment();
  totals.assistantTurns = messages.size;
  for (const usage of messages.values()) {
    for (const [target, source] of [
      ['inputTokens', 'input_tokens'], ['cacheCreationInputTokens', 'cache_creation_input_tokens'],
      ['cacheReadInputTokens', 'cache_read_input_tokens'], ['outputTokens', 'output_tokens'],
    ]) {
      const value = usage[source];
      if (Number.isFinite(value) && value >= 0) totals[target] += value;
    }
  }
  totals.observedInputTokens = totals.inputTokens + totals.cacheCreationInputTokens + totals.cacheReadInputTokens;
  return totals;
}

export function collectFiles(inputs) {
  const files = new Set();
  for (const input of inputs) {
    const stat = fs.statSync(input);
    const candidates = stat.isDirectory()
      ? fs.readdirSync(input, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => path.join(input, entry.name))
      : [input];
    for (const file of candidates) {
      if (!file.endsWith('.jsonl') || !fs.statSync(file).isFile()) {
        throw new Error(`Expected a .jsonl file or directory: ${file}`);
      }
      files.add(fs.realpathSync(file));
    }
  }
  return [...files].sort();
}

export async function measure(inputs, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const totals = emptyTotals();
  const files = collectFiles(inputs);
  let sessions = 0;
  let skippedMalformedLines = 0;
  for (const file of files) {
    const row = await analyseSession(file, settings);
    if (!row.assistantTurns || row.assistantTurns < settings.minTurns) {
      skippedMalformedLines += row.malformedLines;
      continue;
    }
    sessions++;
    for (const key of Object.keys(totals)) {
      if (key !== 'byKind') totals[key] += row[key];
    }
    for (const kind of KINDS) {
      for (const key of ['count', 'oneShot', 'carried']) totals.byKind[kind][key] += row.byKind[kind][key];
    }
  }
  if (!sessions) throw new Error(`No usable sessions in ${files.length} files (minimum ${settings.minTurns} usage-bearing messages; ${skippedMalformedLines} malformed lines).`);
  return {
    schemaVersion: 1,
    method: 'text-chars/4; result-arrival carry to explicit compaction or EOF; not dollar savings',
    minTurns: settings.minTurns, minChars: settings.minChars,
    files: files.length, sessions, skippedSessions: files.length - sessions, skippedMalformedLines,
    ...totals,
  };
}

const pct = (n, d) => d ? `${(100 * n / d).toFixed(2)}%` : 'n/a';
export function formatReport(report) {
  const number = (value) => value.toLocaleString('en-US');
  const share = (value) => `${number(value)} (${pct(value, report.observedInputTokens)} of observed input)`;
  return [
    `Sessions: ${report.sessions}/${report.files} (minimum ${report.minTurns} messages)`,
    `Assistant messages: ${number(report.assistantTurns)}`,
    `Observed input tokens: ${number(report.observedInputTokens)} (input + cache creation + cache read)`,
    `Output tokens: ${number(report.outputTokens)}`,
    '',
    `All tool results, one-shot estimate: ${share(report.allResultOneShot)}`,
    `All tool results, carried estimate: ${share(report.allResultCarried)}`,
    `Bulk-read candidates: ${report.candidateCount} (>=${report.minChars} text chars, no error)`,
    `  One-shot estimate: ${share(report.candidateOneShot)}`,
    `  Carried estimate: ${share(report.candidateCarried)}`,
    '',
    'Tool-result estimates by kind (count / one-shot / carried):',
    ...Object.entries(report.byKind).map(([kind, row]) => `  ${kind}: ${row.count} / ${number(row.oneShot)} / ${number(row.carried)}`),
    '',
    `Diagnostics: ${report.malformedLines} malformed lines (${report.skippedMalformedLines} in skipped files), ${report.duplicateRecords} duplicate records, ${report.missingMessageIds} messages without IDs, ${report.unmatchedResults} unmatched results, ${report.nonTextBlocks} non-text blocks, ${report.compactionBoundaries} compaction boundaries.`,
    'Approximation only, not avoidable cost or dollar savings. See --help for assumptions.',
  ].join('\n');
}

async function main(args) {
  const options = {};
  const inputs = [];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg === '--help') { console.log(HELP); return; }
    if (!positional && arg === '--json') { options.json = true; continue; }
    if (!positional && ['--min-turns', '--min-chars'].includes(arg)) {
      const value = Number(args[++i]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${arg} requires a positive integer`);
      options[arg === '--min-turns' ? 'minTurns' : 'minChars'] = value;
    } else if (!positional && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else inputs.push(arg);
  }
  if (!inputs.length) throw new Error('Provide at least one .jsonl file or directory. Use --help for usage.');
  const report = await measure(inputs, options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`measure: ${error.message}`);
    process.exitCode = 1;
  });
}
