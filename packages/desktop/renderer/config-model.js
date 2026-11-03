/** Presentation helpers only. Main owns config mappings and privileged writes. */
export function providerFieldControl(field, id, pending = new Map()) {
  const secret = field?.isSecret === true || field?.type === 'secret';
  const original = secret ? '' : String(field?.value ?? '');
  return {
    original,
    value: pending.has(id) ? pending.get(id) : original,
    // A saved redacted secret is a placeholder, never a replacement value.
    placeholder: secret && field?.value ? String(field.value) : undefined,
    configured: Boolean(field?.value),
    secret,
  };
}

/** Both selected engines need visible settings; one provider renders once. */
export function credentialProviderGroups(current, pending = new Map()) {
  const groups = new Map();
  for (const [settingId, role] of [['xunity.endpoint', 'primary'], ['xunity.fallbackEndpoint', 'fallback']]) {
    const value = pending.has(settingId) ? pending.get(settingId)
      : current?.values?.find((setting) => setting.id === settingId)?.value;
    if (!value) continue;
    const selected = current?.providers?.find((entry) => entry.provider.id === value);
    if (!selected) continue;
    const group = groups.get(value) ?? { ...selected, roles: [] };
    group.roles.push(role);
    groups.set(value, group);
  }
  return [...groups.values()];
}

export function comparisonRowGroups(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const important = (row) => row.category === 'basic' || row.customValue === true || row.introduced === true ||
    row.status === 'relocated' || row.status === 'unsupported';
  return { main: rows.filter(important), advanced: rows.filter((row) => !important(row)) };
}

/** Defensive presentation: even an accidentally populated secret DTO cannot
 * reveal a value, a mask suffix or an example default in a comparison table. */
export function comparisonValue(row, target = false, hiddenValueIds = []) {
  if (Array.isArray(hiddenValueIds) && hiddenValueIds.includes(row?.id)) return { key: 'history.savedValueHidden' };
  if (row?.isSecret) return { key: target ? 'secretReference' : row.configured ? 'secretConfigured' : 'secretMissing' };
  const value = target ? row?.targetDefault : row?.currentValue;
  if (!target && row?.currentPresent === false) return { key: 'notInFile', value: value ?? '?' };
  if (value === undefined || value === null) return { key: 'unknownValue' };
  return value === '' ? { key: 'empty' } : { value: String(value) };
}

/** Provider URLs, identifiers and paths never become comparison values. */
export function providerComparisonValue(field) {
  if (field?.isSecret || field?.currentValue === undefined) return undefined;
  const value = String(field.currentValue);
  if (field.type === 'boolean') return /^(true|false)$/i.test(value) ? value : undefined;
  if (['integer', 'number'].includes(field.type) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) return value;
  return undefined;
}
