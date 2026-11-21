<script lang="ts">
  import { onMount } from 'svelte';
  import type { BoardState } from '../../state/board.svelte';
  import type { ActivityItem, QuestionDetail, QuestionRow } from '../../types';
  import { answerRefusal, answerRequest, canAnswer, togglePick } from './answer';

  let { state: board }: { state: BoardState } = $props();
  let tab = $state<'questions' | 'activity'>('questions');
  let questions = $state<QuestionRow[]>([]);
  let activity = $state<ActivityItem[]>([]);
  let loading = $state(true);
  let error = $state('');
  let selected = $state<QuestionDetail | null>(null);
  let selectedQid = $state<string | null>(null);
  let detailLoading = $state(false);
  let answer = $state<string | null>(null);
  let answerLoading = $state(false);
  let picked = $state<string[]>([]);
  let note = $state('');
  let submitting = $state(false);
  let submitError = $state('');
  let delivery = $state('');

  const project = $derived(board.selectedProject === 'all' ? 'all' : board.selectedProject);

  function ago(value?: string | null) {
    if (!value) return '—';
    const elapsed = Date.now() - Date.parse(value);
    if (!Number.isFinite(elapsed)) return value;
    if (elapsed < 60_000) return 'now';
    if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
    return `${Math.round(elapsed / 86_400_000)}d ago`;
  }

  function duration(value: number | null) {
    if (value == null) return 'Awaiting answer';
    if (value < 60_000) return 'Answered in under a minute';
    if (value < 3_600_000) return `Answered in ${Math.round(value / 60_000)}m`;
    return `Answered in ${Math.round(value / 3_600_000)}h`;
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const [questionResponse, activityResponse] = await Promise.all([
        board.api.questions({ project, state: 'all' }),
        board.api.activity({ project, limit: 100 })
      ]);
      questions = questionResponse.questions;
      activity = activityResponse.activity;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not load questions.';
    } finally {
      loading = false;
    }
  }

  function resetForm() {
    picked = [];
    note = '';
    submitError = '';
    delivery = '';
  }

  async function reloadSelected() {
    if (!selected) return;
    selected = (await board.api.question(selected.qid, selected.project)).question;
  }

  async function submitAnswer(decline: boolean) {
    if (!selected || submitting) return;
    const body = decline ? { decline: true as const } : answerRequest(picked, note);
    if (!body) { submitError = 'Pick an option or write an answer first.'; return; }
    submitting = true;
    submitError = '';
    try {
      const recorded = await board.api.answerQuestion(selected.qid, selected.project, body);
      delivery = recorded.delivery;
      picked = [];
      note = '';
      await reloadSelected();
      void load();
    } catch (caught) {
      const refusal = answerRefusal(caught);
      submitError = refusal.message;
      if (refusal.answeredElsewhere) { await reloadSelected().catch(() => {}); void load(); }
    } finally {
      submitting = false;
    }
  }

  async function openQuestion(row: QuestionRow) {
    selectedQid = row.qid;
    detailLoading = true;
    answer = null;
    resetForm();
    try {
      selected = (await board.api.question(row.qid, row.project)).question;
      globalThis.location.hash = `/questions/${row.qid}`;
    } catch (caught) {
      board.toast(caught instanceof Error ? caught.message : 'Could not load question.');
      selected = null;
    } finally {
      detailLoading = false;
    }
  }

  function closeDetail() {
    selected = null;
    selectedQid = null;
    answer = null;
    resetForm();
    globalThis.location.hash = '/questions';
  }

  async function revealAnswer() {
    if (!selected?.answerUrl) return;
    answerLoading = true;
    try {
      answer = (await board.api.questionAnswer(selected.qid, selected.project)).text;
    } catch (caught) {
      board.toast(caught instanceof Error ? caught.message : 'Could not load answer.');
    } finally {
      answerLoading = false;
    }
  }

  onMount(() => {
    void load();
    const qid = globalThis.location.hash.match(/^#\/questions\/([^/]+)$/)?.[1];
    if (!qid) return;
    const openFromHash = async () => {
      try {
        const detail = await board.api.question(qid, project);
        selected = detail.question;
        selectedQid = qid;
      } catch { /* A deleted or inaccessible deep link leaves the list available. */ }
    };
    void openFromHash();
  });
</script>

<section class="questions-view" aria-label="Questions and activity">
  <header class="view-header">
    <div><p class="eyebrow">Decision trail</p><h2>Questions & activity</h2></div>
    <button onclick={() => void load()} disabled={loading}>Refresh</button>
  </header>
  <div class="tabs" role="tablist" aria-label="Questions and activity">
    <button class:active={tab === 'questions'} role="tab" aria-selected={tab === 'questions'} onclick={() => tab = 'questions'}>Questions</button>
    <button class:active={tab === 'activity'} role="tab" aria-selected={tab === 'activity'} onclick={() => tab = 'activity'}>Activity</button>
  </div>

  {#if error}<p class="error">{error}</p>{/if}
  {#if loading}<p class="empty">Loading…</p>
  {:else if tab === 'questions'}
    <div class="question-list">
      {#each questions as question (question.qid)}
        <button class="question-row" onclick={() => void openQuestion(question)}>
          <span class="question-copy"><strong>{question.header ?? question.seq} · {question.text}</strong><span>{question.ref} · {question.asker ?? 'filing'} · {question.blocking ? 'Blocking' : 'Non-blocking'}</span></span>
          <span class="question-state"><b class:open={question.state === 'open'}>{question.state}</b><time title={question.askedAt}>{ago(question.askedAt)}</time></span>
        </button>
      {:else}<p class="empty">No questions match this board.</p>{/each}
    </div>
  {:else}
    <div class="activity-list">
      {#each activity as item (item.id)}
        <article><time title={item.at}>{ago(item.at)}</time><div><strong>{item.title}</strong><p>{item.detail}</p></div></article>
      {:else}<p class="empty">No activity yet.</p>{/each}
    </div>
  {/if}
</section>

{#if selectedQid}
  <aside class="detail panel" aria-label="Question detail">
    <header><div><p class="eyebrow">{selected?.ref ?? 'Question'} {selected?.seq ?? ''}</p><h2>{selected?.header ?? 'Question'}</h2></div><button onclick={closeDetail}>Close</button></header>
    {#if detailLoading}<p class="empty">Loading question…</p>
    {:else if selected}
      <p class="question-text">{selected.text}</p>
      {#if selected.options?.length}<ul>{#each selected.options as option}<li><strong>{option.label}</strong>{#if option.description} · {option.description}{/if}</li>{/each}</ul>{/if}
      {#if selected.default}<p class="meta">Default: {selected.default}</p>{/if}
      <p class="meta">Asked by {selected.asker ?? 'filing'} · {ago(selected.askedAt)} · {duration(selected.timeToAnswerMs)}</p>
      {#if selected.answer}
        <section class="answer"><h3>Answer</h3>
          {#if answer !== null}<p>{answer}</p>
          {:else}<button onclick={() => void revealAnswer()} disabled={answerLoading}>{answerLoading ? 'Loading answer…' : 'Show answer'}</button>{/if}
        </section>
      {/if}
      {#if delivery}<p class="delivery" role="status">{delivery}</p>{/if}
      {#if canAnswer(selected)}
        <form class="answer-form" aria-label="Answer this question" onsubmit={(event) => { event.preventDefault(); void submitAnswer(false); }}>
          <h3>Answer</h3>
          {#if selected.options?.length}
            <div class="choices" role="group" aria-label="Options">
              {#each selected.options as option (option.label)}
                <label class="choice"><input type={selected.multiSelect ? 'checkbox' : 'radio'} name="answer-option" checked={picked.includes(option.label)} onchange={() => picked = togglePick(picked, option.label, selected?.multiSelect ?? false)} disabled={submitting} /><span><strong>{option.label}</strong>{#if option.description}<small>{option.description}</small>{/if}</span></label>
              {/each}
            </div>
          {/if}
          <label class="note"><span>{selected.options?.length ? 'Add a note (optional)' : 'Your answer'}</span><textarea bind:value={note} rows="4" disabled={submitting}></textarea></label>
          {#if submitError}<p class="error" role="alert">{submitError}</p>{/if}
          <div class="actions">
            <button type="submit" class="primary" disabled={submitting}>{submitting ? 'Sending…' : 'Send answer'}</button>
            <button type="button" onclick={() => void submitAnswer(true)} disabled={submitting} title={selected.default ? `The executor proceeds with its default: ${selected.default}` : 'The executor proceeds with its stated default'}>Decline</button>
          </div>
          <p class="meta">The first answer stands. A running executor gets it on its next board call.</p>
        </form>
      {:else if submitError}<p class="error" role="alert">{submitError}</p>{/if}
    {/if}
  </aside>
{/if}

<style>
  .questions-view { max-width: 68rem; } .view-header, .detail header { display:flex; justify-content:space-between; gap:1rem; align-items:start; } h2, p { margin:0; } .eyebrow { color:var(--text-muted); font-size:.75rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; } h2 { margin-top:.2rem; font-family:var(--font-serif); font-size:1.5rem; } button { font:inherit; cursor:pointer; } .view-header > button, .detail header > button, .answer button { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); color:var(--text); padding:.45rem .65rem; } .tabs { display:flex; gap:.25rem; margin:1.25rem 0 .75rem; border-bottom:1px solid var(--border); } .tabs button { border:0; border-bottom:2px solid transparent; background:transparent; color:var(--text-muted); padding:.55rem .8rem; } .tabs button.active { border-color:var(--accent); color:var(--accent); font-weight:700; } .question-list, .activity-list { border-top:1px solid var(--border); } .question-row { width:100%; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:1rem; padding:1rem .25rem; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); text-align:left; } .question-row:hover { background:var(--surface-muted); } .question-copy { display:grid; gap:.3rem; min-width:0; } .question-copy strong { line-height:1.35; } .question-copy span, .meta, .activity-list p { color:var(--text-muted); font-size:.84rem; line-height:1.4; } .question-state { display:grid; justify-items:end; align-content:start; gap:.35rem; color:var(--text-muted); font-size:.78rem; text-transform:capitalize; } .question-state b.open { color:var(--accent); } time { color:var(--text-muted); font-size:.78rem; white-space:nowrap; } .activity-list article { display:grid; grid-template-columns:5rem minmax(0,1fr); gap:1rem; padding:1rem .25rem; border-bottom:1px solid var(--border); } .activity-list strong { line-height:1.35; } .activity-list p { margin-top:.25rem; } .empty, .error { color:var(--text-muted); padding:1.2rem .25rem; } .error { color:var(--danger, #b64747); } .detail { position:fixed; z-index:12; right:1rem; top:1rem; bottom:1rem; width:min(34rem, calc(100vw - 2rem)); overflow:auto; padding:1.25rem; background:var(--bg-deep); border:1px solid var(--border-strong); box-shadow:0 1rem 3rem color-mix(in srgb, var(--bg) 55%, transparent); } .question-text { margin:1.25rem 0; line-height:1.55; white-space:pre-wrap; } ul { padding-left:1.2rem; line-height:1.5; } .meta { margin-top:1rem; } .answer { margin-top:1.25rem; padding-top:1rem; border-top:1px solid var(--border); } .answer h3 { margin:0 0 .6rem; } .answer p { white-space:pre-wrap; line-height:1.55; } .answer-form { display:grid; gap:.75rem; margin-top:1.25rem; padding-top:1rem; border-top:1px solid var(--border); } .answer-form h3 { margin:0; } .choices { display:grid; gap:.4rem; } .choice { display:grid; grid-template-columns:auto minmax(0,1fr); gap:.6rem; align-items:start; padding:.55rem .65rem; border:1px solid var(--border); border-radius:var(--radius); cursor:pointer; } .choice:has(input:checked) { border-color:var(--accent); } .choice span { display:grid; gap:.2rem; } .choice small { color:var(--text-muted); font-size:.82rem; } .note { display:grid; gap:.35rem; font-size:.84rem; color:var(--text-muted); } .note textarea { font:inherit; color:var(--text); background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:.5rem .6rem; resize:vertical; } .actions { display:flex; gap:.5rem; } .actions button { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); color:var(--text); padding:.45rem .75rem; } .actions button.primary { background:var(--accent); border-color:var(--accent); color:var(--bg); font-weight:700; } .actions button:disabled { opacity:.6; cursor:default; } .delivery { margin-top:1rem; padding:.6rem .7rem; border-left:3px solid var(--accent); background:var(--surface-muted); font-size:.86rem; line-height:1.45; } @media (max-width:640px) { .question-row { grid-template-columns:1fr; } .question-state { justify-items:start; grid-auto-flow:column; justify-content:start; } }
</style>
