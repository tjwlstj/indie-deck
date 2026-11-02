import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonRowGroups, comparisonValue, credentialProviderGroups, providerComparisonValue, providerFieldControl } from '../../desktop/renderer/config-model.js';

test('provider controls show saved non-secret values and compare edits against that baseline', () => {
  const pending = new Map<string, string>();
  assert.deepEqual(providerFieldControl({ type: 'boolean', value: 'True' }, 'provider:p:flag', pending),
    { value: 'True', original: 'True', placeholder: undefined, configured: true, secret: false });
  pending.set('provider:p:flag', 'False');
  assert.equal(providerFieldControl({ type: 'boolean', value: 'True' }, 'provider:p:flag', pending).value, 'False');
  assert.equal(providerFieldControl({ type: 'number', value: '2.5' }, 'provider:p:delay', pending).original, '2.5');
  assert.equal(providerFieldControl({ type: 'string', value: '/existing/path' }, 'provider:p:path', pending).value, '/existing/path');
});

test('saved secret masks stay placeholders and never become replacement values', () => {
  const field = { type: 'secret', isSecret: true, value: '••••1234' };
  const blank = providerFieldControl(field, 'provider:p:key');
  assert.equal(blank.value, ''); assert.equal(blank.original, ''); assert.equal(blank.placeholder, '••••1234');
  const edited = providerFieldControl(field, 'provider:p:key', new Map([['provider:p:key', 'synthetic replacement']]));
  assert.equal(edited.value, 'synthetic replacement'); assert.equal(edited.original, '');
});

test('primary and fallback settings both render while the same provider is deduplicated', () => {
  const current = {
    values: [{ id: 'xunity.endpoint', value: 'primary' }, { id: 'xunity.fallbackEndpoint', value: 'fallback' }],
    providers: [{ provider: { id: 'primary' }, fields: [] }, { provider: { id: 'fallback' }, fields: [] }],
  };
  assert.deepEqual(credentialProviderGroups(current).map((group) => [group.provider.id, group.roles]),
    [['primary', ['primary']], ['fallback', ['fallback']]]);
  const same = credentialProviderGroups(current, new Map([['xunity.fallbackEndpoint', 'primary']]));
  assert.deepEqual(same.map((group) => [group.provider.id, group.roles]), [['primary', ['primary', 'fallback']]]);
  assert.equal(credentialProviderGroups(current, new Map([['xunity.fallbackEndpoint', '']])).length, 1);
});

test('reinstall comparison prioritizes common and customized options without losing advanced rows', () => {
  const rows = [{ id: 'language', category: 'basic' }, { id: 'font', category: 'font', customValue: true }, { id: 'debug', category: 'debug' }];
  const groups = comparisonRowGroups({ rows });
  assert.deepEqual(groups.main.map((row) => row.id), ['language', 'font']);
  assert.deepEqual(groups.advanced.map((row) => row.id), ['debug']);
});

test('comparison never displays populated secret fields and distinguishes absent settings from defaults', () => {
  const secret = { isSecret: true, configured: true, currentValue: 'synthetic-private-value', targetDefault: 'private-default' };
  assert.deepEqual(comparisonValue(secret), { key: 'secretConfigured' });
  assert.deepEqual(comparisonValue(secret, true), { key: 'secretReference' });
  assert.deepEqual(comparisonValue({ currentPresent: false, currentValue: 'en' }), { key: 'notInFile', value: 'en' });
  assert.deepEqual(comparisonValue({ currentValue: '' }), { key: 'empty' });
  assert.deepEqual(comparisonValue({ currentValue: 'ko' }), { value: 'ko' });
  assert.deepEqual(comparisonValue({ currentValue: 'ko' }, true), { key: 'unknownValue' });
});

test('provider comparison exposes only safe boolean and numeric current values', () => {
  assert.equal(providerComparisonValue({ type: 'boolean', currentValue: 'True' }), 'True');
  assert.equal(providerComparisonValue({ type: 'number', currentValue: '2.5' }), '2.5');
  assert.equal(providerComparisonValue({ type: 'integer', currentValue: '10' }), '10');
  for (const field of [{ type: 'string', currentValue: 'https://private.invalid/?token=secret' },
    { type: 'secret', currentValue: 'synthetic-private-value' }, { type: 'number', isSecret: true, currentValue: '12345' },
    { type: 'number', currentValue: 'Infinity' }, { type: 'boolean', currentValue: '/private/path' }]) {
    assert.equal(providerComparisonValue(field), undefined);
  }
});
