---
title: Transcript read-cost measurement
description: Estimate tool-result context volume from local transcripts without enabling telemetry.
---

`scripts/measure.mjs` estimates how much input context comes from tool results and large file reads. It runs locally with Node 22, needs no dependencies or credentials, and makes no network calls. It does not modify transcripts or configuration.

## Run it

From a checkout of Loadout:

```bash
node scripts/measure.mjs --help
node scripts/measure.mjs /path/to/project-transcripts
node scripts/measure.mjs --json /path/to/session.jsonl
node scripts/measure.mjs --min-turns 1 --min-chars 4000 /path/to/project-transcripts
```

Claude Code stores project transcripts under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`. Select the project directories or files explicitly. There is no automatic home-directory scan. Directories are shallow, so subagent transcripts are excluded unless their directories or files are supplied explicitly. Repeated input paths are resolved and deduplicated. Copies of the same transcript at different paths are not deduplicated.

By default, a file needs at least five usage-bearing assistant messages to qualify. `--min-turns` and `--min-chars` accept positive integers. Use `--` before a path starting with a dash. Missing paths, unreadable files, invalid arguments, and an empty usable sample fail with a nonzero exit code. Malformed JSON lines are skipped and counted, including those in files excluded by the minimum-turn filter.

Successful text and JSON reports contain aggregates only, not transcript text, tool inputs, file paths, or session IDs. Filesystem errors can include the input path. Keep real transcripts and investigation outputs out of commits; tests use synthetic records only.

## What the numbers mean

- **Observed input tokens** sum `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` from transcript usage. These are token volumes, not equally priced billing units. Output tokens are reported separately.
- **Assistant messages** count unique usage-bearing `message.id` values per file. Repeated snapshots of a message use its last usage object. Missing IDs fall back to the record UUID, then line position, and are counted in diagnostics. Repeated record UUIDs are skipped.
- **One-shot payload** estimates each tool result as `ceil(text characters / 4)`. Characters here means JavaScript string length (UTF-16 code units), not UTF-8 bytes or tokenizer output. Text blocks are summed before rounding. Image and other non-text blocks contribute no estimated tokens and are counted separately.
- **Carried payload** multiplies that estimate by the number of later usage-bearing assistant messages, starting when the result arrives, and stopping at an explicit `system` / `compact_boundary` record or end of file. A result after the final assistant message has zero carried volume.
- **Bulk-read candidates** are non-error results classified as bulk reads with at least 8,000 returned text characters by default. “Candidate” describes the heuristic, not proof that a worker could replace the result safely.

The report includes one-shot and carried estimates for all results and for candidates. The percentages divide those estimates by observed input tokens. JSON (`schemaVersion: 1`) includes the thresholds, separate cache counters, diagnostics, and per-kind counts and estimates. Diagnostics describe included sessions, except `skippedMalformedLines`, which covers excluded files.

## Classification

| Tool or input | Kind |
| --- | --- |
| `Read` without `offset`, `limit`, or `pages` | `bulk-read` |
| `Read` with any of those fields set | `targeted-read` |
| `Bash` or `BashOutput` command containing `\|` or `>` | `targeted-read` |
| Otherwise, shell command starting with `cat`, `head`, `tail`, `less`, or `more` followed by whitespace | `bulk-read` |
| `Grep`, `Glob` | `search` |
| `Agent`, `Task` | `subagent` |
| Other tools | `other` |
| Result without a preceding matching tool-use ID | `unmatched` |

This is not a shell parser. `head` and `tail` can be bounded reads but still land in the bulk bucket. Piped output may contain entire files but lands in the targeted bucket. Commands prefixed by `cd`, wrappers, or absolute executable paths can be missed. Quoted pipe characters still trigger the targeted heuristic. Tool aliases are not normalized. Unmatched and error results count toward all-result volume, but unmatched results and errors cannot become candidates.

## Limits

The transcript is not the exact request sent to the provider. The tool reads file order and does not reconstruct `parentUuid` branches, retries, fork ancestry, or hidden harness pruning. Explicit compaction ends carry of old payloads entirely, though summaries may retain some information. Missing compaction records can overstate carry; hidden context edits and history replay can distort it in either direction. Missing or nonstandard usage can distort both the message count and denominator. Provider-reported usage is accepted as recorded, not independently verified.

The all-result carried number is calculated directly for each result. It is NOT the SQ-11 sensitivity extrapolation that applied the bulk-read carry ratio to all result payloads, and neither number is a proven savings ceiling. Estimates may even exceed observed input when transcript retention differs from actual context. No dollar conversion is attempted: cache rates, model pricing, worker overhead, retained summaries, and whether exact content was needed are outside this measurement.

Adding subagent directories includes their input consumption as separate sessions as well as any summaries returned to the parent. That can be useful for total context-volume analysis, but it changes the sample and does not prove offload savings.

## Why not observability?

Observability deliberately does not retain tool inputs such as a Read's `file_path`. Its reports do not support per-file causal allocation. This tool instead pairs transcript tool uses with results locally and discards the inputs from its output. It neither requires nor enables observability.

The script originated in the SQ-11 no-go investigation and was promoted in SQ-20. The original scratchpad counted every usage-bearing record, carried from the requesting call, and ignored compaction boundaries. The maintained version corrects those assumptions and treats page-limited reads as targeted. Its results are not numerically interchangeable with the original spike. The historical 1% estimate and roughly 13% extrapolation are not built-in assertions or regression targets. This tooling does not reopen the rejected shunt-alike or codebase-mapper experiments, or change the separate eval-harness work.

## Tests

```bash
node --test scripts/test/measure.test.mjs
```

The repository Test workflow runs this suite alongside the release-engine tests. No live accounts, settings, transcripts, or telemetry stores are used.
