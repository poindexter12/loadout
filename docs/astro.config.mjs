import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://poindexter12.github.io',
  base: '/loadout',
  redirects: {
    '/getting-started/codex-gateway': '/loadout/getting-started/model-gateway',
    '/reference/codex-gateway': '/loadout/reference/model-gateway',
  },
  integrations: [
    starlight({
      title: 'Loadout',
      description: 'Independent Claude Code plugins for project context, work tracking, model routing, and local usage observability.',
      customCss: ['./src/styles/custom.css'],
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap',
          },
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/poindexter12/loadout',
        },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Overview', slug: 'index' },
            { label: 'Getting started', slug: 'getting-started' },
          ],
        },
        {
          label: 'Use the plugins',
          items: [
            { label: 'Quartermaster', slug: 'getting-started/quartermaster' },
            { label: 'Model Gateway', slug: 'getting-started/model-gateway' },
            { label: 'Sidequest', slug: 'getting-started/sidequest' },
            { label: 'Codebase Mapper', slug: 'getting-started/codebase-mapper' },
            { label: 'Live Rules', slug: 'getting-started/live-rules' },
            { label: 'Experiment loops', slug: 'getting-started/experiments' },
          ],
        },
        {
          label: 'Observability',
          items: [
            { label: 'Overview', slug: 'observability' },
            { label: 'Setup', slug: 'observability/setup' },
            { label: 'Dashboard', slug: 'observability/dashboard' },
            { label: 'Per-project opt-in', slug: 'observability/project-opt-in' },
          ],
        },
        {
          label: 'Maintainer docs',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Modular Loadout', slug: 'architecture/modular-architecture' },
            { label: 'Contributing to the docs', slug: 'contributing' },
            { label: 'Release process', slug: 'release-process' },
          ],
        },
        {
          label: 'Plugin reference',
          items: [
            { label: 'Overview', slug: 'reference' },
            { label: 'Observability', slug: 'reference/observability' },
            { label: 'Model Gateway', slug: 'reference/model-gateway' },
            { label: 'Codebase Mapper', slug: 'reference/codebase-mapper' },
            { label: 'Live Rules', slug: 'reference/live-rules' },
            { label: 'Sidequest', slug: 'reference/sidequest' },
            { label: 'Quartermaster', slug: 'reference/quartermaster' },
            { label: 'Marketplace versions', slug: 'reference/marketplace' },
          ],
        },
        {
          label: 'Support',
          items: [{ label: 'Support and attribution', slug: 'support' }],
        },
      ],
    }),
  ],
});
