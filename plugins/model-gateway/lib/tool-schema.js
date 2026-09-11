'use strict';

// OpenAI-shaped backends (Codex, Grok) validate function-schema `pattern`
// values against JSON Schema format: regex (ECMA-262) and reject Unicode
// property escapes and lookbehind. One tool carrying `\p{Cc}` 400s the entire
// request before it reaches the model, and Claude Code's Artifact tool does
// exactly that. `pattern` is an advisory hint rather than semantics, so
// dropping an unsupported one costs a malformed argument caught at the tool
// instead of at the API, while keeping it costs every request. Patterns the
// backend can parse are left intact, and Anthropic-bound requests never reach
// this function — they must stay byte-identical.
const UNSUPPORTED_PATTERN_SYNTAX = /\\[pP]\{|\(\?<[=!]/;

function sanitizeToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  let stripped = 0;
  const scrub = (node) => {
    if (Array.isArray(node)) return node.map(scrub);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      // A property literally named "pattern" carries a schema object, not a
      // regex string, so the string check keeps it out of the strip path.
      if (key === 'pattern' && typeof value === 'string' && UNSUPPORTED_PATTERN_SYNTAX.test(value)) {
        stripped++;
        continue;
      }
      out[key] = scrub(value);
    }
    return out;
  };
  const sanitized = tools.map((tool) => (
    tool && typeof tool === 'object' && tool.input_schema
      ? { ...tool, input_schema: scrub(tool.input_schema) }
      : tool
  ));
  return stripped ? sanitized : tools;
}

module.exports = { UNSUPPORTED_PATTERN_SYNTAX, sanitizeToolSchemas };
