'use strict';

function normalizedCommandPrefix(command) {
  const words = String(command ?? '').trim().replace(/\s+/g, ' ').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, '').split(' ');
  if (!words[0]) return null;
  const executable = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  const subcommand = words[1] && !words[1].startsWith('-')
    ? (/[\\/]/.test(words[1]) ? words[1] : words[1].toLowerCase())
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
