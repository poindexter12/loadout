import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { generateBundledAgents } from './generate-bundled-agents.mjs';

const require = createRequire(import.meta.url);

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const budgetReportRequested = process.argv.includes('--mcp-tools-list-budget');

function mcpToolsListBudgetReport() {
  const mcp = require(path.join(pluginRoot, 'lib', 'mcp.js'));
  return mcp.toolDescriptorByteReport();
}

export const nonBundledBuildDirectories = ['lib', 'bin'];
export const bundledBuildOutputs = [{
  sourceDirectory: 'src/hooks',
  outputDirectory: 'hooks',
  sourceExtension: '.ts',
  outputExtension: '.js',
}, {
  sourceDirectory: 'src/hooks/fn',
  outputDirectory: 'hooks/fn',
  sourceExtension: '.ts',
  outputExtension: '.js',
}];

// Classic hooks are node processes (cjs). Function-hook modules (hooks.json "modules") run in the
// hooks host, which gives a module no Node: ESM for a neutral platform, and nothing external, so
// a node:* import fails the build instead of the host. Keep each bundledBuildOutputs entry to its
// four keys: src/lib/store/warnings.ts parses them to map a source path to its compiled twin.
const bundledBuildOptions = {
  hooks: { platform: 'node', format: 'cjs', target: 'node22', external: ['node:*'] },
  'hooks/fn': { platform: 'neutral', format: 'esm', target: 'es2022', external: [] },
};

// Only lib and bin mirror nested sources into output. Hook entry points stay top-level:
// src/hooks/shared/* are bundled into each hook, and emitting them would flatten distinct
// nested paths onto colliding basenames in hooks/.
async function sourceEntries(directory, { recursive = true } = {}) {
  const absolute = path.join(pluginRoot, 'src', directory);
  async function collectEntries(root) {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const collected = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return recursive ? collectEntries(entryPath) : [];
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    }));
    return collected.flat();
  }
  try {
    return (await collectEntries(absolute)).sort();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function buildNonBundled(directory, banner) {
  const entryPoints = await sourceEntries(directory);
  if (!entryPoints.length) return;
  await build({
    entryPoints,
    outdir: path.join(pluginRoot, directory),
    outbase: path.join(pluginRoot, 'src', directory),
    bundle: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    banner: banner ? { js: banner } : undefined,
  });
}

async function buildHooks() {
  for (const { sourceDirectory, outputDirectory, outputExtension } of bundledBuildOutputs) {
    const entryPoints = await sourceEntries(sourceDirectory.replace(/^src\//, ''), { recursive: false });
    for (const entryPoint of entryPoints) {
      await build({
        entryPoints: [entryPoint],
        outfile: path.join(pluginRoot, outputDirectory, `${path.basename(entryPoint, '.ts')}${outputExtension}`),
        bundle: true,
        ...bundledBuildOptions[outputDirectory],
        charset: 'utf8',
        legalComments: 'none',
        sourcemap: false,
      });
    }
  }
}

for (const directory of nonBundledBuildDirectories) {
  await buildNonBundled(directory, directory === 'bin' ? '#!/usr/bin/env node' : undefined);
}
await generateBundledAgents(pluginRoot);
await buildHooks();

if (budgetReportRequested) process.stdout.write(`${JSON.stringify(mcpToolsListBudgetReport(), null, 2)}\n`);
