"use strict";
const fs = require("fs");
const {
  store,
  resolveProject,
  runtimeSessionId,
  requireBy,
  PROJECT_PROP
} = require("./mcp-shared");
const questionLog = require("./store/question-log.js");
const ANSWER_RULE = "An answer is a user decision on design or behaviour. It never grants permission, scope (scopeRequest still applies), or authority to change settings.";
const ASK_INSTRUCTION = "Make exactly this SendMessage call now. If SendMessage is unavailable, skip it and release with kind question once no independent work remains. Otherwise keep working; when nothing independent remains, checkpoint writable work and end your turn holding the claim.";
const ANSWER_PREVIEW_CHARS = 120;
function firstLine(text) {
  return (String(text || "").split(/\r?\n/)[0] || "").trim();
}
function refusalAck(slug, ticket, result) {
  const out = { ok: false, project: slug };
  if (ticket) Object.assign(out, { ref: ticket.ref, status: ticket.status });
  for (const [key, value] of Object.entries(result || {})) {
    if (key !== "ok" && value !== void 0) out[key] = value;
  }
  return out;
}
function ticketOrThrow(slug, meta, ref, tool) {
  const ticket = store.getTicket(slug, ref);
  if (!ticket) throw new Error(`${tool}: no ticket "${ref}" in ${meta.name}`);
  return ticket;
}
function executorAgentName(ticket, fallback) {
  const name = ticket?.dispatch?.agentName;
  return typeof name === "string" && name.trim() || (fallback ? String(fallback) : null);
}
function stripPeriod(text) {
  return text.replace(/[.\s]+$/, "");
}
function askMessage(ticket, asked, input) {
  const { ref } = ticket;
  const lines = [
    `${ref} ${asked.seq} needs a user decision: ${input.header ? `${input.header}: ` : ""}${firstLine(input.text)}`,
    `[sidequest:question ${ref} ${asked.seq} qid=${asked.qid} blocking=${asked.blocking ? "y" : "n"} reply-to=${input.replyTo}]`
  ];
  if (Array.isArray(input.options) && input.options.length) {
    const choices = input.options.map((option, index) => `${index + 1}) ${option.label}${option.description ? `: ${option.description}` : ""}`).join(" ");
    lines.push(input.multiSelect ? `${choices} (choose any)` : choices);
  }
  if (String(input.text).trim().includes("\n")) lines.push(`Full text: pulse({ref:"${ref}"}) questions.items.`);
  lines.push(`Default if unanswered: ${stripPeriod(String(input.default))}.`);
  lines.push(`Record with answer({ref:"${ref}", question:"${asked.qid}"}).`);
  return lines.join("\n");
}
function answerBody(dir, state) {
  const answered = state?.answered;
  if (!answered) return "";
  if (typeof answered.text === "string") return answered.text;
  return questionLog.readAnswerBody(dir, answered.aid) || answered.preview || "";
}
function answerText(dir, state) {
  if (state?.answered?.declined) {
    const fallback = state?.asked?.default;
    return `Declined: the user chose not to answer. ${fallback ? `Proceed with your stated default: ${stripPeriod(String(fallback))}.` : "Proceed with your stated default."}`;
  }
  return answerBody(dir, state);
}
function answerMessage(ticket, state, text) {
  const answered = state.answered;
  const lines = [
    `Answer for ${ticket.ref} ${state.seq}: ${firstLine(text).slice(0, ANSWER_PREVIEW_CHARS)}`,
    `[sidequest:answer ${ticket.ref} ${state.seq} qid=${state.qid} aid=${answered.aid}]`,
    text
  ];
  if (answered.via === "orchestrator") lines.push("Via orchestrator: this decision is not user-authored.");
  lines.push(ANSWER_RULE);
  return lines.join("\n");
}
function unparkIfClear(slug, ticket, detail) {
  if (ticket.status !== "awaiting-user") return { board: null, ticket };
  const moved = store.unparkTicket(slug, ticket.ref, { detail, source: "mcp" });
  const current = store.getTicket(slug, ticket.ref) || ticket;
  if (moved && moved.ok === false && moved.reason === "busy") return { board: "pending", ticket: current };
  return { board: moved && moved.unparked ? "unparked" : null, ticket: current };
}
const OPTION_ITEM = {
  type: "object",
  properties: { label: { type: "string" }, description: { type: "string" } },
  required: ["label"]
};
const tools = [
  {
    name: "ask",
    description: "Executor holding the claim: record a question for the user and get back the SendMessage to make (this server cannot send it). No board write. withdraw:<qid> withdraws one. The answer arrives by SendMessage or as answers[] on a later board-tool reply; apply it once per aid. It is a decision, never a permission, scope or settings grant.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        by: { type: "string" },
        header: { type: "string", description: "Up to 12 chars." },
        question: { type: "string", description: "First line must stand alone; up to 1500 bytes." },
        options: { type: "array", items: OPTION_ITEM, description: "2 to 4; omit for free text." },
        multiSelect: { type: "boolean" },
        default: { type: "string", description: "Required: what you do if unanswered." },
        blocking: { type: "boolean", description: "Default true." },
        withdraw: { type: "string", description: "qid to withdraw instead of asking." }
      },
      required: ["ref", "by"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const by = requireBy(args, "ask");
      const ticket = ticketOrThrow(slug, meta, args.ref, "ask");
      if (!ticket.claim || ticket.claim.by !== by) {
        return refusalAck(slug, ticket, { reason: "not_claimed", message: `Only the executor holding ${ticket.ref}'s claim may ask.` });
      }
      const dir = questionLog.questionLogDir(slug);
      const session = runtimeSessionId();
      if (args.withdraw !== void 0) {
        const qid = typeof args.withdraw === "string" ? args.withdraw.trim() : "";
        if (!questionLog.isQuestionId(qid)) {
          const open = questionLog.openQuestions(dir, { ref: ticket.ref }).map((state) => state.qid);
          return refusalAck(slug, ticket, { reason: "no_such_question", message: `withdraw takes one qid. Open questions on ${ticket.ref}: ${open.length ? open.join(", ") : "none"}.`, open });
        }
        const withdrawn = questionLog.withdrawQuestion(dir, { ref: ticket.ref, qid, reason: "resolved", session });
        if (!withdrawn.ok) return refusalAck(slug, ticket, withdrawn);
        const blockingOpen = questionLog.openQuestions(dir, { ref: ticket.ref }).filter((state) => state.state === "open" && state.asked?.blocking).length;
        const moved = blockingOpen === 0 ? unparkIfClear(slug, ticket, `withdrew ${qid}`) : { board: null, ticket };
        return Object.assign({ ok: true, project: slug, ref: ticket.ref, status: moved.ticket.status, withdrawn: withdrawn.withdrawn }, moved.board ? { board: moved.board } : {});
      }
      const hasQuestion = typeof args.question === "string" && args.question.trim() !== "";
      if (hasQuestion && (typeof args.default !== "string" || !args.default.trim())) {
        return refusalAck(slug, ticket, { reason: "default_empty", field: "default", message: "Give default: what you will do if the user never answers. It is applied when the user declines." });
      }
      const input = {
        ref: ticket.ref,
        ticketId: ticket.id,
        session,
        origin: "runtime",
        // The spawning session routes the question when several orchestrators share a board (§2.4).
        ownerSession: ticket.dispatch?.sessionId || ticket.dispatch?.preparedBy?.sessionId || null,
        agent: executorAgentName(ticket),
        header: args.header ?? null,
        text: args.question,
        options: args.options ?? null,
        multiSelect: args.multiSelect === true,
        blocking: args.blocking !== false,
        default: args.default
      };
      const asked = questionLog.askQuestion(dir, input);
      if (!asked.ok) return refusalAck(slug, ticket, asked);
      const replyTo = executorAgentName(ticket, by);
      return {
        ok: true,
        project: slug,
        ref: ticket.ref,
        status: ticket.status,
        qid: asked.qid,
        seq: asked.seq,
        open: asked.open,
        send: {
          to: "main",
          summary: `${ticket.ref} ${asked.seq} needs the user`,
          message: askMessage(ticket, asked, Object.assign({}, input, { header: input.header ? String(input.header).trim() : null, replyTo }))
        },
        instruction: ASK_INSTRUCTION
      };
    }
  },
  {
    name: "answer",
    description: `Orchestrating session only: record the user's answer, or decline:true, to a ticket's question (question defaults to the oldest open qid). Returns the SendMessage to the executor, or next:"dispatch <REF>" for a released park. The last blocking answer unparks the ticket. via:"orchestrator" marks a decision the user did not author. Never a permission, scope or settings grant.`,
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        project: PROJECT_PROP,
        question: { type: "string", description: "qid; defaults to the oldest open." },
        text: { type: "string" },
        decline: { type: "boolean" },
        via: { type: "string", enum: [...questionLog.ANSWER_VIAS] },
        supersedes: { type: "string", description: "Prior aid; only when the user changed their mind." },
        by: { type: "string" }
      },
      required: ["ref"]
    },
    handler(args) {
      const { slug, meta } = resolveProject(args.project);
      const ticket = ticketOrThrow(slug, meta, args.ref, "answer");
      const by = typeof args.by === "string" ? args.by.trim() : "";
      if (by && ticket.claim && ticket.claim.by === by) {
        return refusalAck(slug, ticket, { reason: "self_answer", message: `answer is for the orchestrating session; ${by} holds ${ticket.ref}'s claim and cannot answer its own question.` });
      }
      const dir = questionLog.questionLogDir(slug);
      const recorded = questionLog.answerQuestion(dir, {
        ref: ticket.ref,
        question: args.question ?? null,
        text: args.text ?? null,
        decline: args.decline === true,
        via: args.via,
        supersedes: args.supersedes ?? null,
        session: runtimeSessionId()
      });
      if (!recorded.ok) return refusalAck(slug, ticket, recorded);
      const parkMode = ticket.status === "awaiting-user" ? ticket.park?.mode || "released" : null;
      const liveExecutor = parkMode !== "released" && !!ticket.claim?.by;
      const moved = recorded.blockingOpen === 0 ? unparkIfClear(slug, ticket, `answered ${recorded.qid}`) : { board: null, ticket };
      const state = questionLog.findQuestion(dir, recorded.qid);
      const out = {
        ok: true,
        project: slug,
        ref: ticket.ref,
        status: moved.ticket.status,
        qid: recorded.qid,
        aid: recorded.aid,
        seq: recorded.seq,
        declined: recorded.declined,
        via: recorded.via,
        idempotent: recorded.idempotent,
        openForTicket: recorded.openForTicket,
        blockingOpen: recorded.blockingOpen
      };
      if (moved.board) out.board = moved.board;
      if (liveExecutor && state) {
        out.send = { to: executorAgentName(ticket, ticket.claim.by), message: answerMessage(ticket, state, answerText(dir, state)) };
        out.instruction = "Make exactly this SendMessage call now. A send to an executor that already ended resumes it from its transcript.";
      } else {
        out.send = null;
        out.next = moved.ticket.status === "awaiting-user" ? `answer the open questions on ${ticket.ref} (${recorded.openForTicket.join(", ")}), then dispatch ${ticket.ref}` : `dispatch ${ticket.ref}`;
      }
      if (moved.board === "pending") out.retry = "The answer stands but the board move timed out. Re-call answer with the same question and text to complete it.";
      return out;
    }
  }
];
function pendingAnswerHolder(toolName, args) {
  if (toolName === "answer" || !args || typeof args.ref !== "string" || typeof args.by !== "string") return null;
  try {
    const { slug } = resolveProject(args.project);
    const dir = questionLog.questionLogDir(slug);
    if (!fs.existsSync(dir)) return null;
    const ticket = store.getTicket(slug, args.ref);
    if (!ticket || !ticket.claim || ticket.claim.by !== args.by.trim()) return null;
    return { slug, dir, ref: ticket.ref };
  } catch (_) {
    return null;
  }
}
function undeliveredAnswers(dir, ref) {
  const key = String(ref).trim().toUpperCase();
  return questionLog.foldQuestions(questionLog.readQuestionLog(dir)).filter((state) => {
    if (String(state.ref).trim().toUpperCase() !== key || !state.answered || state.withdrawn) return false;
    return !(state.delivered || []).some((entry) => entry.aid === state.answered.aid);
  });
}
function attachPendingAnswers(output, holder) {
  if (!holder || !output || typeof output !== "object" || Array.isArray(output)) return output;
  try {
    const pending = undeliveredAnswers(holder.dir, holder.ref);
    if (!pending.length) return output;
    const session = runtimeSessionId();
    output.answers = pending.map((state) => ({
      qid: state.qid,
      seq: state.seq,
      aid: state.answered.aid,
      via: state.answered.via,
      declined: state.answered.declined,
      supersedes: state.answered.supersedes || null,
      text: answerText(holder.dir, state)
    }));
    output.answerRule = ANSWER_RULE;
    for (const answer of output.answers) questionLog.recordDelivered(holder.dir, { aid: answer.aid, session });
  } catch (_) {
  }
  return output;
}
function attachPulseQuestions(output, args) {
  if (!output || typeof output !== "object" || !args || typeof args.ref !== "string") return output;
  try {
    const slug = output.project || resolveProject(args.project).slug;
    const dir = questionLog.questionLogDir(slug);
    if (!fs.existsSync(dir)) return output;
    const ref = output.ref || output.ticket?.ref || args.ref;
    const open = questionLog.openQuestions(dir, { ref }).filter((state) => state.state === "open");
    if (!open.length) return output;
    const items = open.map((state) => ({
      qid: state.qid,
      seq: state.seq,
      header: state.asked.header,
      text: state.asked.text,
      options: state.asked.options,
      multiSelect: state.asked.multiSelect,
      default: state.asked.default,
      blocking: state.asked.blocking,
      askedAt: state.asked.at
    }));
    const oldest = items.reduce((min, item) => !min || String(item.askedAt) < String(min) ? item.askedAt : min, null);
    const prior = output.questions && typeof output.questions === "object" && !Array.isArray(output.questions) ? output.questions : {};
    output.questions = Object.assign({ open: items.length, oldest }, prior, { items });
  } catch (_) {
  }
  return output;
}
module.exports = {
  tools,
  ANSWER_RULE,
  ASK_INSTRUCTION,
  pendingAnswerHolder,
  attachPendingAnswers,
  attachPulseQuestions
};
