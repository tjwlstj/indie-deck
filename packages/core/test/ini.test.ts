import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyIni, parseIni } from '../src/util/ini.ts';

const SAMPLE = [
  '[Service]',
  'Endpoint=GoogleTranslate     ;Which translation service to use',
  'FallbackEndpoint=',
  '',
  '[General]',
  'Language=en',
  'FromLanguage=ja',
  '',
  '; a standalone comment',
  '[Behaviour]',
  'EnableUIResizing=True',
].join('\r\n');

test('parses sections, values and strips inline comments', () => {
  const data = parseIni(SAMPLE);
  assert.equal(data['Service']?.['Endpoint'], 'GoogleTranslate');
  assert.equal(data['General']?.['Language'], 'en');
  assert.equal(data['Behaviour']?.['EnableUIResizing'], 'True');
  assert.equal(data['Service']?.['FallbackEndpoint'], '');
});

test('edits values in place and keeps the inline comment', () => {
  const updated = applyIni(SAMPLE, { Service: { Endpoint: 'DeepLTranslate' }, General: { Language: 'ko' } });
  assert.match(updated, /Endpoint=DeepLTranslate\s+;Which translation service to use/);
  assert.match(updated, /Language=ko/);
  assert.match(updated, /; a standalone comment/, 'standalone comments survive');
  assert.match(updated, /FromLanguage=ja/, 'untouched keys survive');
  assert.equal(updated.includes('\r\n'), true, 'line endings are preserved');
});

test('adds missing keys to an existing section', () => {
  const updated = applyIni(SAMPLE, { Behaviour: { FallbackFontTextMeshPro: 'arialuni_sdf_u2021' } });
  const data = parseIni(updated);
  assert.equal(data['Behaviour']?.['FallbackFontTextMeshPro'], 'arialuni_sdf_u2021');
  assert.equal(data['Behaviour']?.['EnableUIResizing'], 'True');
});

test('appends a whole section when it does not exist yet', () => {
  const updated = applyIni(SAMPLE, { Texture: { EnableLegacyTextureLoading: 'True' } });
  assert.match(updated, /\[Texture\]/);
  assert.equal(parseIni(updated)['Texture']?.['EnableLegacyTextureLoading'], 'True');
});

test('writes into an empty file', () => {
  const updated = applyIni('', { Service: { Endpoint: 'PapagoTranslate' } });
  assert.equal(parseIni(updated)['Service']?.['Endpoint'], 'PapagoTranslate');
});

test('key matching is case-insensitive but keeps the original spelling', () => {
  const updated = applyIni(SAMPLE, { service: { endpoint: 'BingTranslate' } });
  assert.match(updated, /Endpoint=BingTranslate/);
  assert.equal((updated.match(/^Endpoint=/gm) ?? []).length, 1, 'no duplicate key is appended');
});
