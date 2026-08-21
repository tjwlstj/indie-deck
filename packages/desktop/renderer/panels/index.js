/**
 * The detail column, as data.
 *
 * Adding a section to the launcher is one entry here plus a render function.
 * Each section gets `(panel, ctx, refresh, onInstall)` where `ctx` is whatever
 * `game:detail` returned, and `when` decides whether it appears at all.
 */

import { renderAudit, renderFacts, renderHeader, renderMods, renderPlans } from './detail.js';
import { renderConfigSection } from './config.js';

export const SECTIONS = [
  { id: 'header', render: renderHeader },
  { id: 'facts', render: renderFacts },
  { id: 'audit', render: renderAudit, when: (ctx) => ctx.audit.issues.length > 0 },
  { id: 'plans', render: renderPlans },
  {
    id: 'config',
    render: renderConfigSection,
    when: (ctx) => ctx.profile.installedTranslators.length > 0,
  },
  { id: 'mods', render: renderMods },
];
