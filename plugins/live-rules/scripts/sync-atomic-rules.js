'use strict';

const path = require('node:path');
const rules = require('../hooks/lib/rules');

function projectDirectory(args) {
  const index = args.indexOf('--project');
  if (index === -1) return process.cwd();
  if (!args[index + 1]) throw new Error('--project needs a directory path.');
  return path.resolve(args[index + 1]);
}

function check(projectDir) {
  const errors = rules.checkAtomicRuleSet(projectDir);
  if (errors.length) {
    for (const error of errors) process.stderr.write(`live-rules check failed: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Live-rules manifest matches rule files.\n');
}

try {
  const args = process.argv.slice(2);
  const projectDir = projectDirectory(args);
  if (args.includes('--check')) check(projectDir);
  else {
    const manifest = rules.syncAtomicRuleSet(projectDir);
    process.stdout.write(`Synced ${manifest.rules.length} live rule(s) from disk.\n`);
  }
} catch (error) {
  process.stderr.write(`live-rules sync failed: ${error.message}\n`);
  process.exitCode = 1;
}
