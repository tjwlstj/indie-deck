/** Renderer-only choices. Paths and install steps remain privileged in main. */
export function fontChoiceKey(gameId, plan) {
  return JSON.stringify([gameId, plan.translatorId, plan.variantId, plan.version]);
}

/** Select one of the two opaque, separately validated plans from main. */
export function selectedFontPlan(plan, includeFont) {
  if (includeFont || !plan.withoutFontPlanId) return plan;
  return {
    ...plan,
    id: plan.withoutFontPlanId,
    fontBundle: undefined,
    installBlockReason: plan.withoutFontInstallBlockReason,
  };
}
