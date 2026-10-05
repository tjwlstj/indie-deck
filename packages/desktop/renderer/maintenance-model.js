/** Presentation only. Main owns cleanup scope, fingerprints and plan authority. */
export function hasTranslatorMaintenance(context) {
  return context?.profile?.engineId === 'unity' && context?.translatorMaintenance?.supported === true;
}

export function translatorMaintenancePresentation(context, blocked = false) {
  const preview = context?.translatorMaintenance;
  const supported = hasTranslatorMaintenance(context);
  const hasPreview = typeof preview?.previewId === 'string' && preview.previewId.length > 0;
  return {
    supported,
    canRemove: supported && hasPreview && preview.canRemove === true && !blocked,
    canReinstall: supported && hasPreview && preview.canReinstall === true && !blocked,
    files: Array.isArray(preview?.files) ? preview.files : [],
    preservedPaths: Array.isArray(preview?.preservedPaths) ? preview.preservedPaths : [],
  };
}

/** Capture the shown authority before opening confirmation; never rebuild it from DOM paths. */
export function captureTranslatorMaintenance(context, kind, blocked = false) {
  const presentation = translatorMaintenancePresentation(context, blocked);
  if (kind !== 'remove-translator' && kind !== 'reinstall-translator') return null;
  if (!(kind === 'remove-translator' ? presentation.canRemove : presentation.canReinstall)) return null;
  return {
    gameId: context.profile.id,
    kind,
    planId: context.translatorMaintenance.previewId,
    files: presentation.files.map((file) => ({ ...file })),
    preservedPaths: [...presentation.preservedPaths],
    targetVersion: context.translatorMaintenance.targetVersion,
  };
}

export function canConfirmTranslatorMaintenance(state, captured) {
  return Boolean(captured && state.selected === captured.gameId &&
    state.detail?.profile?.id === captured.gameId &&
    state.detail?.translatorMaintenance?.previewId === captured.planId);
}
