'use strict';

// A first word that is shell syntax or a wrapper says nothing about which
// command was granted, so no rule may be keyed on it.
const UNLEARNABLE_FIRST_WORD = /^(?:for|while|until|if|case|select|function|do|then|else|elif|fi|done|esac|time|!|\[\[?|command|builtin|eval|exec|env)$/i;
const REDIRECT = /^(?:\d*|&)[<>]/;

// Derive the rule key from the shell's own view of the command. A command
// with more than one statement (chain, pipe, newline, `$(...)`, backticks,
// subshell or group) is refused outright: a rule keyed on one statement would
// grant every statement chained after it.
function normalizedCommandPrefix(command) {
  // Lazy: permission-allowlist.js requires this module at load time.
  const { simpleCommands, commandBody, hasUnmatchedQuote } = require('./permission-allowlist.js');
  const source = String(command ?? '').trim();
  // A leading operator or an unterminated quote marks a fragment of a larger command.
  if (!source || /^[({;&|]/.test(source) || hasUnmatchedQuote(source)) return null;
  const statements = simpleCommands(source);
  if (statements.length !== 1) return null;
  const words = commandBody(statements[0]);
  if (!words.length) return null;
  const [first, second] = words;
  if (first.text.startsWith('-') || (!first.quoted && (REDIRECT.test(first.text) || UNLEARNABLE_FIRST_WORD.test(first.text)))) return null;
  if (second && !second.quoted && REDIRECT.test(second.text)) return null;
  const executable = first.text.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (!executable || UNLEARNABLE_FIRST_WORD.test(executable)) return null;
  const subcommand = second && !second.text.startsWith('-') && !/\s/.test(second.text) && second.text
    ? (/[\\/]/.test(second.text) ? second.text : second.text.toLowerCase())
    : null;
  return subcommand ? `${executable} ${subcommand}` : executable;
}

function fingerprintFor(name, input) {
  if (!name) return null;
  if (name === 'Bash') {
    const prefix = normalizedCommandPrefix(input?.command);
    return prefix ? `permission:Bash:${prefix}` : null;
  }
  return `permission:${name}`;
}

function ruleFor(fingerprint) {
  const match = /^permission:Bash:(.+)$/.exec(fingerprint);
  return match ? `Bash(${match[1]}:*)` : fingerprint.slice('permission:'.length);
}

module.exports = { fingerprintFor, normalizedCommandPrefix, ruleFor };
