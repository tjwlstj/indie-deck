/** Presentation-only MTool state. No paths become executable authority here. */

const SUPPORTED_ENGINES = new Set(['rpgmaker-mv', 'rpgmaker-mz', 'rpgmaker-rgss']);

export function hasMToolIntegration(context) {
  return Boolean(context?.mtoolIntegration?.supported && SUPPORTED_ENGINES.has(context?.profile?.engineId));
}

export function mtoolPresentation(integration, blocked = false) {
  const status = ['ready', 'missing', 'disabled', 'invalid'].includes(integration?.status)
    ? integration.status
    : 'missing';
  const ready = status === 'ready';
  const gameExecutableKnown = typeof integration?.gameExecutable === 'string' && integration.gameExecutable.length > 0;
  return {
    status,
    statusKey: `ui.mtool.status.${status}`,
    tone: ready ? 'ok' : status === 'disabled' ? 'info' : 'warn',
    canLaunch: ready && gameExecutableKnown && !blocked,
    canOpen: ready && !blocked,
    canOpenFolder: ready,
    canLocateGame: gameExecutableKnown,
  };
}

/** Configuration updates carry global tool status, not another game's detail. */
export function withMToolStatus(context, status) {
  if (!hasMToolIntegration(context) || !status) return context;
  return {
    ...context,
    mtoolIntegration: {
      ...status,
      supported: true,
      gameExecutable: context.mtoolIntegration.gameExecutable,
      autoApply: false,
      docsUrl: context.mtoolIntegration.docsUrl,
    },
  };
}

/** Independent read requests can finish out of order. Only the newest probe
 * may replace the displayed status; config changes invalidate prior probes. */
export function beginMToolStatusRequest(state) {
  state.mtoolStatusRequestToken = (state.mtoolStatusRequestToken ?? 0) + 1;
  state.mtoolStatusLoading = true;
  return state.mtoolStatusRequestToken;
}

export function applyMToolStatus(state, status) {
  state.mtoolStatusRequestToken = (state.mtoolStatusRequestToken ?? 0) + 1;
  state.mtoolStatusLoading = false;
  state.mtoolStatus = status;
  state.detail = withMToolStatus(state.detail, status);
}

export function acceptMToolStatusResponse(state, token, status) {
  if (state.mtoolStatusRequestToken !== token) return false;
  state.mtoolStatusLoading = false;
  state.mtoolStatus = status;
  state.detail = withMToolStatus(state.detail, status);
  return true;
}

export function failMToolStatusRequest(state, token) {
  if (state.mtoolStatusRequestToken !== token) return false;
  return acceptMToolStatusResponse(state, token, {
    status: 'invalid',
    source: state.mtoolStatus?.source ?? 'default',
    ...(state.mtoolStatus?.root ? { root: state.mtoolStatus.root } : {}),
    reasonKey: 'ui.mtool.statusCheckFailed',
  });
}
