/**
 * The detail column, as data.
 *
 * Adding a section to the launcher is one entry here plus a render function.
 * Each section gets `(panel, ctx, refresh, onInstall, onUninstall)` where
 * `ctx` is whatever `game:detail` returned, and `when` decides whether it
 * appears at all.
 */

import { renderAudit, renderFacts, renderFontRecommendation, renderHeader, renderMods, renderPlans } from './detail.js';
import { renderConfigSection } from './config.js';
import { renderMToolIntegration } from './mtool.js';
import { hasMToolIntegration } from '../mtool-model.js';
import { renderComparisonHistory, renderTranslatorMaintenance } from './maintenance.js';
import { hasTranslatorMaintenance } from '../maintenance-model.js';

export const SECTIONS = [
  { id: 'header', render: renderHeader },
  { id: 'facts', render: renderFacts },
  {
    id: 'config',
    render: renderConfigSection,
    when: (ctx) => ctx.profile.installedTranslators.length > 0,
  },
  { id: 'audit', render: renderAudit, when: (ctx) => ctx.audit.issues.length > 0 },
  { id: 'comparison-history', render: renderComparisonHistory,
    when: (ctx) => Boolean(ctx.comparisonHistory?.record) || ctx.comparisonHistory?.state === 'unavailable' },
  { id: 'translator-maintenance', render: renderTranslatorMaintenance, when: hasTranslatorMaintenance },
  { id: 'font', render: renderFontRecommendation, when: (ctx) => Boolean(ctx.fontRecommendation) },
  { id: 'mtool', render: renderMToolIntegration, when: hasMToolIntegration },
  { id: 'plans', render: renderPlans },
  { id: 'mods', render: renderMods },
];
