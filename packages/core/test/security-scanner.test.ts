import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createSecurityScanner, fingerprintSecurityTarget, type SecurityProcessRequest, type SecurityProcessResult, type SecurityScannerOptions } from '../../desktop/src/security-scanner.ts';

const parent = path.resolve(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(parent, 'indiedeck-security-scanner-'));
after(() => { assert.equal(path.dirname(temporary), parent); fs.rmSync(temporary, { recursive: true, force: true }); });
let sequence = 0;
const healthy = {
  BinaryTrusted: true, AMServiceEnabled: true, AntivirusEnabled: true, AMRunningMode: 'Normal',
  AMEngineVersion: '1.1.26090.1', AntivirusSignatureVersion: '1.463.115.0', AntivirusSignatureAge: 0,
  RealTimeProtectionEnabled: true,
};
function fixture(extra: Partial<SecurityScannerOptions> = {}, handler?: (request: SecurityProcessRequest, calls: SecurityProcessRequest[]) => Promise<SecurityProcessResult> | SecurityProcessResult) {
  const root = path.join(temporary, String(++sequence)); fs.mkdirSync(root);
  const executable = path.join(root, 'MpCmdRun.exe'), target = path.join(root, 'sample.bin');
  fs.writeFileSync(executable, 'synthetic signed engine'); fs.writeFileSync(target, 'ordinary harmless fixture');
  const calls: SecurityProcessRequest[] = [];
  const scanner = createSecurityScanner({
    platform: 'win32', discoverCandidates: async () => [executable],
    run: async (request) => {
      calls.push(request);
      return handler ? handler(request, calls) : { code: 0, stdout: request.args.includes('-EncodedCommand') ? JSON.stringify(healthy) : 'scan complete' };
    }, ...extra,
  });
  return { root, executable, target, calls, scanner };
}
const statusResponse = (values = {}) => ({ code: 0, stdout: JSON.stringify({ ...healthy, ...values }) });

test('unsupported platforms never discover an engine, inspect a target or run a native command', async () => {
  let touched = false;
  const scanner = createSecurityScanner({ platform: 'linux', discoverCandidates: async () => { touched = true; return []; }, run: async () => { touched = true; throw Error('must not run'); } });
  assert.equal((await scanner.status()).reason, 'unsupported-platform');
  assert.equal((await scanner.scanTarget('/nonexistent/unused')).reason, 'unsupported-platform');
  assert.equal((await scanner.updateSignatures()).reason, 'unsupported-platform');
  assert.equal(touched, false);
});

test('status exposes only verified bounded Defender metadata, never raw diagnostics or machine identity', async () => {
  const item = fixture({}, () => statusResponse({ Secret: 'never-send', ComputerID: 'private-host', ExtraPath: 'private-path' }));
  const state = await item.scanner.status();
  assert.deepEqual(state, { provider: 'microsoft-defender', state: 'ready', engineVersion: healthy.AMEngineVersion,
    signatureVersion: healthy.AntivirusSignatureVersion, signatureAgeDays: 0, realTimeProtectionEnabled: true, policy: 'existing-defender-policy' });
  assert.doesNotMatch(JSON.stringify(state), /never-send|private-host|private-path|MpCmdRun/);
  const inspection = item.calls[0]!;
  assert.match(inspection.executable, /^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.deepEqual(inspection.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(inspection.args[4]!, 'base64').toString('utf16le');
  assert.match(script, /Get-AuthenticodeSignature -LiteralPath \$env:INDIEDECK_DEFENDER_ENGINE/);
  assert.match(script, /O=Microsoft Corporation/);
  assert.doesNotMatch(script, /Set-MpPreference|Get-MpPreference|Add-MpPreference|Remove-MpPreference|ExecutionPolicy/);
  assert.equal(inspection.env?.INDIEDECK_DEFENDER_ENGINE, item.executable);
});

test('unsigned, inactive, stale or malformed status never starts a scan', async () => {
  for (const fields of [{ BinaryTrusted: false }, { AMRunningMode: 'Passive' }, { AntivirusEnabled: false }, { AntivirusSignatureAge: 8 }, { AMEngineVersion: 'private-text' }]) {
    const item = fixture({}, (request) => request.args.includes('-EncodedCommand') ? statusResponse(fields) : { code: 0, stdout: '' });
    const result = await item.scanner.scanTarget(item.target);
    assert.equal(result.verdict, 'not-checked');
    assert.equal(item.calls.filter((call) => call.args.includes('-Scan')).length, 0);
  }
  const invalid = fixture({}, () => ({ code: 0, stdout: 'invalid private diagnostics' }));
  assert.equal((await invalid.scanner.status()).reason, 'status-error');
});

test('a successful custom file scan is bound to unchanged bytes and fresh engine/signature metadata', async () => {
  const item = fixture();
  const result = await item.scanner.scanTarget(item.target);
  assert.equal(result.verdict, 'clean');
  assert.equal(result.fingerprint?.sha256, crypto.createHash('sha256').update(fs.readFileSync(item.target)).digest('hex'));
  assert.equal(result.fingerprint?.scope, 'file'); assert.equal(result.fingerprint?.files, 1);
  assert.equal(result.signatureVersion, healthy.AntivirusSignatureVersion);
  assert.equal(item.calls.filter((call) => call.args.includes('-EncodedCommand')).length, 2);
  const native = item.calls.find((call) => call.args.includes('-Scan'))!;
  assert.equal(native.executable, item.executable);
  assert.deepEqual(native.args, ['-Scan', '-ScanType', '3', '-File', item.target, '-DisableRemediation']);
  assert.doesNotMatch(JSON.stringify(result), /sample\.bin|synthetic signed engine|scan complete/);
});

test('metacharacters in a filename remain one literal native argument', async () => {
  const item = fixture();
  const target = path.join(item.root, "ordinary ' quote ; & name.bin"); fs.writeFileSync(target, 'harmless fixture');
  assert.equal((await item.scanner.scanTarget(target)).verdict, 'clean');
  assert.equal(item.calls.find((call) => call.args.includes('-Scan'))!.args[4], target);
});

test('return code 2 stays ambiguous attention while access, timeout and output failures cannot be clean', async () => {
  const outcomes: [SecurityProcessResult, string, string][] = [
    [{ code: 2, stdout: 'private threat or scan error' }, 'attention', 'engine-attention'],
    [{ code: 5, stdout: 'private access error' }, 'not-checked', 'permission-denied'],
    [{ code: 0, stdout: '', timedOut: true }, 'not-checked', 'timed-out'],
    [{ code: 0, stdout: '', aborted: true }, 'not-checked', 'cancelled'],
    [{ code: 0, stdout: '', truncated: true }, 'not-checked', 'output-limit'],
    [{ code: null, stdout: 'native failure' }, 'not-checked', 'engine-error'],
  ];
  for (const [native, verdict, why] of outcomes) {
    const item = fixture({}, (request) => request.args.includes('-EncodedCommand') ? statusResponse() : native);
    const result = await item.scanner.scanTarget(item.target);
    assert.equal(result.verdict, verdict); assert.equal(result.reason, why); assert.equal(result.fingerprint, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private|native failure/);
  }
});

test('file edits, engine replacement and signature updates during scan invalidate a nominal success', async () => {
  for (const mutation of ['target', 'engine', 'signature']) {
    let item: ReturnType<typeof fixture>;
    let scanned = false;
    item = fixture({}, (request) => {
      if (request.args.includes('-EncodedCommand')) return statusResponse(mutation === 'signature' && scanned ? { AntivirusSignatureVersion: '1.463.116.0' } : {});
      scanned = true;
      if (mutation === 'target') fs.writeFileSync(item.target, 'edited after native scan began');
      if (mutation === 'engine') fs.writeFileSync(item.executable, 'changed engine binary');
      return { code: 0, stdout: '' };
    });
    const result = await item.scanner.scanTarget(item.target);
    assert.equal(result.verdict, 'not-checked'); assert.equal(result.reason, mutation === 'target' ? 'target-changed' : 'engine-changed');
    assert.equal(result.fingerprint, undefined);
  }
});

test('directory fingerprints include nested content and names while imposing explicit count/byte bounds', async () => {
  const item = fixture(), folder = path.join(item.root, 'game'); fs.mkdirSync(path.join(folder, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.bin'), 'a'); fs.writeFileSync(path.join(folder, 'nested', 'b.bin'), 'bb');
  const first = await fingerprintSecurityTarget(folder);
  assert.equal(first.files, 2); assert.equal(first.bytes, 3); assert.equal(first.scope, 'directory');
  fs.writeFileSync(path.join(folder, 'nested', 'b.bin'), 'cc');
  assert.notEqual((await fingerprintSecurityTarget(folder)).sha256, first.sha256);
  await assert.rejects(fingerprintSecurityTarget(folder, { maxFiles: 1 }), /scan-limit/);
  await assert.rejects(fingerprintSecurityTarget(folder, { maxBytes: 2 }), /scan-limit/);
  assert.equal((await item.scanner.scanTarget(folder)).verdict, 'clean');
  const constrained = fixture({ maxBytes: 2 });
  assert.equal((await constrained.scanner.scanTarget(constrained.target)).reason, 'scan-limit');
  assert.equal(constrained.calls.some((call) => call.args.includes('-Scan')), false);
});

test('linked ancestry and hard-linked targets are rejected without invoking a native scan or reading outside', async () => {
  const item = fixture(), external = path.join(item.root, 'external'), game = path.join(item.root, 'game');
  fs.mkdirSync(external); fs.mkdirSync(game); fs.writeFileSync(path.join(external, 'file.bin'), 'untouched outside fixture');
  const linked = path.join(game, 'redirect');
  fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await item.scanner.scanTarget(game)).reason, 'unsafe-target');
  assert.equal(item.calls.some((call) => call.args.includes('-Scan')), false);
  const hardlink = path.join(item.root, 'alias.bin'); fs.linkSync(item.target, hardlink);
  assert.equal((await item.scanner.scanTarget(item.target)).reason, 'unsafe-target');
  assert.equal(fs.readFileSync(path.join(external, 'file.bin'), 'utf8'), 'untouched outside fixture');
});

test('directory edits made during native scanning invalidate the whole manifest', async () => {
  let item: ReturnType<typeof fixture>;
  item = fixture({}, (request) => {
    if (request.args.includes('-EncodedCommand')) return statusResponse();
    fs.writeFileSync(path.join(folder, 'added.bin'), 'new file'); return { code: 0, stdout: '' };
  });
  const folder = path.join(item.root, 'game'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'existing.bin'), 'old');
  assert.equal((await item.scanner.scanTarget(folder)).reason, 'target-changed');
});

test('cancellation and a total scan timeout produce no verdict and do not globally cancel Defender', async () => {
  const cancelled = fixture(); const controller = new AbortController(); controller.abort();
  assert.equal((await cancelled.scanner.scanTarget(cancelled.target, { signal: controller.signal })).reason, 'cancelled');
  assert.equal(cancelled.calls.length, 0);
  const slow = fixture({ timeoutMs: 25 }, async (request) => {
    if (request.args.includes('-EncodedCommand')) return statusResponse();
    return await new Promise((resolve) => request.signal!.addEventListener('abort', () => resolve({ code: null, stdout: '', aborted: true }), { once: true }));
  });
  assert.equal((await slow.scanner.scanTarget(slow.target)).reason, 'timed-out');
  assert.equal(slow.calls.some((call) => call.args.includes('-Cancel')), false);
});

test('signature refresh is explicit, accepts stale intelligence and verifies fresh status after the update', async () => {
  let updated = false;
  const item = fixture({}, (request) => {
    if (request.args.includes('-EncodedCommand')) return statusResponse(updated ? { AntivirusSignatureVersion: '1.463.116.0' } : { AntivirusSignatureAge: 9 });
    assert.deepEqual(request.args, ['-SignatureUpdate']); updated = true; return { code: 0, stdout: '' };
  });
  assert.equal((await item.scanner.status()).state, 'stale'); assert.equal(updated, false);
  const result = await item.scanner.updateSignatures();
  assert.equal(result.state, 'updated'); assert.equal(result.changed, true); assert.equal(result.status.state, 'ready');
  assert.equal(item.calls.some((call) => call.args.includes('-Scan')), false);
  const stillStale = fixture({}, (request) => request.args.includes('-EncodedCommand') ? statusResponse({ AntivirusSignatureAge: 9 }) : { code: 0, stdout: '' });
  assert.equal((await stillStale.scanner.updateSignatures()).state, 'not-updated');
});

test('only one scan/update is active at a time and a completed scan releases the busy reservation', async () => {
  let entered!: () => void, finish!: (value: SecurityProcessResult) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const item = fixture({}, async (request) => {
    if (request.args.includes('-EncodedCommand')) return statusResponse();
    entered(); return await new Promise<SecurityProcessResult>((resolve) => { finish = resolve; });
  });
  const scan = item.scanner.scanTarget(item.target); await started;
  assert.equal((await item.scanner.scanTarget(item.target)).reason, 'busy');
  assert.equal((await item.scanner.updateSignatures()).reason, 'busy');
  finish({ code: 0, stdout: '' }); assert.equal((await scan).verdict, 'clean');
  assert.equal((await item.scanner.status()).state, 'ready');
});
