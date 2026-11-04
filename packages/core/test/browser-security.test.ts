import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTrustedAppSender, safeExternalUrl } from '../../desktop/src/browser-security.ts';

const documentURL = 'file:///C:/IndieDeck/resources/app.asar/packages/desktop/renderer/index.html';
function sender(url = documentURL) {
  const frame = { url, detached: false };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  return { contents, event: { sender: contents, senderFrame: frame } };
}

test('only the exact application WebContents and top-level frame can invoke privileged IPC', () => {
  const { contents, event } = sender();
  assert.equal(isTrustedAppSender(event, contents, documentURL), true);
  assert.equal(isTrustedAppSender({ ...event, sender: { ...contents } }, contents, documentURL), false);
  assert.equal(isTrustedAppSender({ ...event, senderFrame: { ...event.senderFrame } }, contents, documentURL), false);
  assert.equal(isTrustedAppSender({ ...event, senderFrame: null }, contents, documentURL), false);
  assert.equal(isTrustedAppSender(event, undefined, documentURL), false);
});

test('file URL lookalikes, remote frames, queries and fragments do not inherit the bridge', () => {
  for (const url of [
    'https://github.com/', documentURL + '.backup', documentURL + '?extra=1', documentURL + '#fragment',
    documentURL.replace('/renderer/', '/other-renderer/'), documentURL.replace('/index.html', '/index%2ehtml'),
  ]) {
    const { contents, event } = sender(url);
    assert.equal(isTrustedAppSender(event, contents, documentURL), false, url);
  }
  const { contents, event } = sender();
  assert.equal(isTrustedAppSender(event, contents, 'https://github.com/'), false);
  assert.equal(isTrustedAppSender(event, contents, documentURL + '#fragment'), false);
});

test('only tilde encoding in the fixed pathname is equivalent across Node and Chromium', () => {
  const encoded = documentURL.replace('/IndieDeck/', '/DOCUME%7E1/');
  const literal = encoded.replace('%7E', '~');
  const lowerEncoded = encoded.replace('%7E', '%7e');
  for (const [expected, actual] of [[encoded, literal], [literal, encoded], [encoded, lowerEncoded]]) {
    const { contents, event } = sender(actual);
    assert.equal(isTrustedAppSender(event, contents, expected), true);
    assert.equal(isTrustedAppSender({ ...event, sender: { ...contents } }, contents, expected), false);
    assert.equal(isTrustedAppSender({ ...event, senderFrame: { ...event.senderFrame } }, contents, expected), false);
  }
});

test('tilde compatibility does not broaden fixed-document path, query or host authority', () => {
  const expected = documentURL.replace('/IndieDeck/', '/DOCUME%7E1/');
  const literal = expected.replace('%7E', '~');
  for (const actual of [literal + '?', literal + '#', literal + '?query=1', literal + '#fragment',
    literal.replace('DOCUME~1', 'DOCUME~2'), literal.replace('DOCUME~1', 'DOCUME%257E1'),
    literal.replace('/renderer/index.html', '/renderer%2findex.html'),
    literal.replace('/renderer/index.html', '/renderer%5cindex.html'),
    literal.replace('/index.html', '/index%2ehtml'),
    literal.replace('/renderer/index.html', '/renderer/../renderer/index.html'),
    literal.replace('/renderer/index.html', '/renderer/%2e%2e/renderer/index.html'),
    literal.replace('file:///', 'file://other-host/'),
  ]) {
    const { contents, event } = sender(actual);
    assert.equal(isTrustedAppSender(event, contents, expected), false, actual);
  }
  const { contents, event } = sender(literal);
  assert.equal(isTrustedAppSender(event, contents, expected + '?'), false);
  assert.equal(isTrustedAppSender(event, contents, expected + '#'), false);
});

test('destroyed, detached and throwing Electron frame access fails closed', () => {
  const destroyed = sender(); destroyed.contents.isDestroyed = () => true;
  assert.equal(isTrustedAppSender(destroyed.event, destroyed.contents, documentURL), false);
  const detached = sender(); detached.event.senderFrame.detached = true;
  assert.equal(isTrustedAppSender(detached.event, detached.contents, documentURL), false);
  const throwing = { get mainFrame() { throw new Error('destroyed frame'); } };
  assert.equal(isTrustedAppSender({ sender: throwing, senderFrame: {} }, throwing, documentURL), false);
  const inaccessible = { get senderFrame() { throw new Error('navigation'); }, sender: {} };
  assert.equal(isTrustedAppSender(inaccessible, inaccessible.sender, documentURL), false);
});

test('external links match the canonical declared URL including path, query and fragment', () => {
  const declared = new Set(['https://github.com/tjwlstj/indie-deck', 'https://docs.example.com/page?view=public#part']);
  assert.equal(safeExternalUrl('HTTPS://GITHUB.COM/tjwlstj/indie-deck', declared), 'https://github.com/tjwlstj/indie-deck');
  assert.equal(safeExternalUrl('https://docs.example.com/page?view=public#part', declared), 'https://docs.example.com/page?view=public#part');
  for (const url of ['https://github.com/tjwlstj/indie-deck/other', 'https://github.com/tjwlstj/indie-deck.evil',
    'https://github.com/tjwlstj/indie-deck?token=private', 'https://docs.example.com/page?view=public#other',
    'https://docs.example.com/page?view=private#part', 'https://github.com.evil.test/tjwlstj/indie-deck']) {
    assert.equal(safeExternalUrl(url, declared), undefined, url);
  }
});

test('credentials, explicit ports and ambiguous URL forms are refused even when declared', () => {
  for (const url of ['http://github.com/', 'file:///C:/private.html', 'javascript:alert(1)', 'windowsdefender:',
    'https://user:password@github.com/', 'https://@github.com/', 'https://github.com:443/', 'https://github.com:8443/',
    ' https://github.com/', 'https://git\thub.com/', 'https://github.com/\nprivate', 'https://github.com\\@evil.test/',
    'https://github.com/path%0aprivate', '//github.com/', 'https://github.com./']) {
    assert.equal(safeExternalUrl(url, new Set([url])), undefined, url);
  }
});

test('literal, encoded-loopback and private hostnames cannot become external links', () => {
  for (const url of ['https://localhost/', 'https://service.localhost/', 'https://intranet/', 'https://server.local/',
    'https://server.internal/', 'https://router.home/', 'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/',
    'https://0x7f000001/', 'https://0177.0.0.1/', 'https://192.168.1.1/', 'https://10.0.0.1/',
    'https://169.254.169.254/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fc00::1]/',
    'https://8.8.8.8/']) {
    assert.equal(safeExternalUrl(url, [url]), undefined, url);
  }
});

test('invalid declarations and failing iterators cannot broaden the link policy', () => {
  assert.equal(safeExternalUrl('https://github.com/', ['http://github.com/', 'https://user@github.com/', 'not-a-url']), undefined);
  assert.equal(safeExternalUrl('https://github.com/', 'https://github.com/'), undefined);
  assert.equal(safeExternalUrl('https://github.com/', { *[Symbol.iterator]() { throw new Error('bad policy'); } }), undefined);
  assert.equal(safeExternalUrl(null, ['https://github.com/']), undefined);
  assert.equal(safeExternalUrl('https://github.com/', ['https://github.com/']), 'https://github.com/');
});
