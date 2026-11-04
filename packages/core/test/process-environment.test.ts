import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gameProcessEnvironment } from '../../desktop/src/process-environment.ts';

test('game and tool environments omit credential-name families without changing the source', () => {
  const source = {
    GITHUB_TOKEN: 'synthetic-github', GH_TOKEN: 'synthetic-gh', OPENAI_API_KEY: 'synthetic-api',
    AnthropicApiKey: 'synthetic-api', 'service.api-key': 'synthetic-api', SERVICE_SECRET: 'synthetic-secret',
    password: 'synthetic-password', ServicePassWd: 'synthetic-password', PRIVATE_KEY: 'synthetic-key',
    signingPrivateKey: 'synthetic-key', GOOGLE_APPLICATION_CREDENTIALS: 'synthetic-file-path',
    HTTP_AUTHORIZATION: 'synthetic-bearer', proxyAuthentication: 'synthetic-auth', AWS_ACCESS_KEY_ID: 'synthetic-access-id',
    PATH: 'C:\\Windows\\System32',
  };
  const original = { ...source };
  assert.deepEqual(gameProcessEnvironment(source), { PATH: 'C:\\Windows\\System32' });
  assert.deepEqual(source, original);
});

test('Node and Electron injection controls are omitted case insensitively', () => {
  const source = {
    NODE_OPTIONS: '--require synthetic-loader', Node_Path: 'synthetic-module-path',
    NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_EXTRA_CA_CERTS: 'synthetic-ca', NODE_ENV: 'development',
    ELECTRON_RUN_AS_NODE: '1', Electron_No_Asar: '1', ELECTRON_OVERRIDE_DIST_PATH: 'synthetic-runtime',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ELECTRON_ENABLE_LOGGING: '1',
    LANG: 'ko_KR.UTF-8',
  };
  assert.deepEqual(gameProcessEnvironment(source), { LANG: 'ko_KR.UTF-8' });
});

test('ordinary game, OS, localization and graphics environment values remain usable', () => {
  const source = {
    Path: 'C:\\Windows\\System32;C:\\Tools', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
    USERPROFILE: 'C:\\Users\\Synthetic', APPDATA: 'C:\\Users\\Synthetic\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Synthetic\\AppData\\Local', SteamAppId: '12345', SteamGameId: '12345',
    LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', DISPLAY: ':0', XAUTHORITY: '/synthetic/display-cookie',
    SDL_GAMECONTROLLERCONFIG: 'synthetic-controller', NUMBER_OF_PROCESSORS: '8', EMPTY_VALUE: '',
  };
  const result = gameProcessEnvironment(source);
  assert.deepEqual(result, source);
  assert.notEqual(result, source);
  result.LANG = 'en_US.UTF-8';
  assert.equal(source.LANG, 'ko_KR.UTF-8');
});

test('undefined and invalid native environment entries are removed without coercing values', () => {
  const source: NodeJS.ProcessEnv = { unset: undefined, valid: 'value', empty: '', '': 'invalid', 'bad=name': 'invalid',
    'bad\0name': 'invalid', invalidValue: 'value\0suffix' };
  assert.deepEqual(gameProcessEnvironment(source), { valid: 'value', empty: '' });
});

test('environment dictionary names cannot mutate the returned object prototype', () => {
  const source: NodeJS.ProcessEnv = Object.fromEntries([['__proto__', 'synthetic'], ['PATH', '/synthetic/bin']]);
  const result = gameProcessEnvironment(source);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__, 'synthetic');
});
