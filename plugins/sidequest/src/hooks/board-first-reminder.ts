import './shared/sqlite-budget.js';
import { isSubagent, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { markSurfaced, projectSlugFor, promptQuestionRelay, unsurfacedQuestions } from './shared/questions.js';
import { readSessionState, sessionStateFile, writeSessionState } from './shared/session-state.js';

const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  projectDispatchAdmission: (slug: string) => { status: string };
}

function boardFor(input: HookInput): string | null {
  const store = require(runtimeModule('store')) as Store;
  const start = stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const found = store.findProject(store.nearestRepoRoot(start));
  if (!found.ok || !found.slug || store.projectDispatchAdmission(found.slug).status !== 'routed') return null;
  return found.slug;
}

// US-8 Q6: relays the newest open user question this session has not surfaced, read from the question
// log (never the board lock). It runs on automation prompts too: an executor's `<agent-message>` is
// exactly when a new question arrives. Only the relayed question is marked surfaced; the others stay
// for the next prompt or stop.
function questionRelay(input: HookInput, sessionId: string): string {
  try {
    const store = require(runtimeModule('store')) as Store;
    const slug = projectSlugFor(stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd(), store);
    if (!slug) return '';
    const pending = unsurfacedQuestions(slug, sessionId).reverse();
    const newest = pending[0];
    if (!newest) return '';
    const relay = promptQuestionRelay(pending);
    if (relay) markSurfaced(sessionId, [newest.qid]);
    return relay;
  } catch (_) {
    return '';
  }
}

function main(): void {
  const input = readStdin();
  if (!input || isSubagent(input)) return;

  const id = stringField(input, 'session_id', 'sessionId').trim();
  if (!id) return;
  const relay = questionRelay(input, id);
  if (relay) {
    // UserPromptSubmit carries one 1 KiB context; the question takes it, and the one-time board-first
    // reminder below waits for a prompt that has no question to relay.
    writeContext('UserPromptSubmit', relay);
    return;
  }

  const prompt = stringField(input, 'prompt').trim();
  if (!id || !prompt || AUTOMATION_TAG.test(prompt)) return;

  const file = sessionStateFile('board-first', id);
  const state = readSessionState(file);
  if (state.reminded || !boardFor(input)) return;
  state.reminded = true;
  writeSessionState(file, state);

  writeContext('UserPromptSubmit', 'sidequest: gather enough read-only evidence, using Explore only for a quick sweep (it inherits the session model; deep or fan-out investigation is a codebase-exploration spike), then write precise tickets and route implementation by default. Use informed inline judgment when it fits.');
}

try {
  main();
} catch (_) {
  process.exit(0);
}
