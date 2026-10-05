import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const main = fs.readFileSync(new URL('../../desktop/src/main.ts', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../../desktop/preload.cjs', import.meta.url), 'utf8');
const cliCommands = fs.readFileSync(new URL('../../cli/src/commands.ts', import.meta.url), 'utf8');
const builder = fs.readFileSync(new URL('../../../electron-builder.yml', import.meta.url), 'utf8');

test('the desktop preload cannot request unredacted translator credentials', () => {
  assert.match(
    preload,
    /read: \(gameId, translatorId\) => call\('config:read', gameId, translatorId\)/,
  );

  const start = main.indexOf("handle('config:read'");
  const end = main.indexOf("handle('config:plan'", start);
  assert.ok(start >= 0 && end > start, 'config:read handler exists');
  assert.doesNotMatch(main.slice(start, end), /revealSecrets/);

  const planStart = main.indexOf("handle('config:plan'");
  const planEnd = main.indexOf("handleMutation('config:write'", planStart);
  assert.match(main.slice(planStart, planEnd), /return redactConfigPlan\(plan\)/);

  const writeStart = planEnd;
  const writeEnd = main.indexOf("handle('shell:openGameFolder'", writeStart);
  assert.match(main.slice(writeStart, writeEnd), /plan: redactConfigPlan\(plan\)/);
  assert.doesNotMatch(main.slice(writeStart, writeEnd), /return \{ plan, result:/);
});

test('the desktop window keeps the renderer inside the packaged document', () => {
  assert.match(main, /sandbox: true/);
  assert.match(main, /window\.webContents\.on\('will-navigate', \(event\) => event\.preventDefault\(\)\)/);
  assert.match(main, /if \(\/\^https:/);
  assert.doesNotMatch(main, /\^https\?:/);
});

test('the Windows notification identity matches the installer identity', () => {
  const appId = builder.match(/^appId:\s*(\S+)$/m)?.[1];
  assert.equal(appId, 'io.github.tjwlstj.indiedeck');
  assert.match(main, /const APP_ID = 'io\.github\.tjwlstj\.indiedeck'/);
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
});

test('CLI JSON config plans cannot expose executable patches or credentials', () => {
  const configCommand = cliCommands.slice(cliCommands.indexOf('export async function cmdConfig'));
  assert.match(configCommand, /const publicPlan = redactConfigPlan\(plan\)/);
  assert.match(configCommand, /JSON\.stringify\(\{ plan: publicPlan, written: false \}/);
  assert.match(configCommand, /out\(ctx, \{ plan: publicPlan, result \}/);
  assert.doesNotMatch(configCommand, /JSON\.stringify\(\{ plan, written: false \}/);
  assert.doesNotMatch(configCommand, /out\(ctx, \{ plan, result \}/);
});

test('normal quit cannot interrupt a queued filesystem mutation', () => {
  assert.match(main, /let pendingMutations = 0/);
  assert.match(main, /function handleMutation/);
  assert.match(main, /window\.on\('close', \(event\) => \{/);
  assert.match(main, /if \(pendingMutations === 0\) return;\s+event\.preventDefault\(\)/);

  for (const channel of [
    'config:set',
    'root:remove',
    'root:pick',
    'library:scan',
    'game:refresh',
    'mods:toggle',
    'mods:add',
    'config:write',
  ]) {
    assert.match(main, new RegExp(`handleMutation\\('${channel.replace(':', '\\:')}'`));
  }
  assert.match(main, /enqueue: \(work\) => \{ void enqueueMutation\(work\); \}/);
  assert.match(main, /function enqueueMutation[\s\S]*pendingMutations \+= 1/);
  assert.match(main, /operations\.start\(request,/);
});

test('maintenance keeps opaque targets, rejects concurrent writes and revalidates plans before applying', () => {
  assert.match(preload, /start: \(request\) => call\('maintenance:start', request\)/);
  assert.doesNotMatch(preload, /game:install|game:uninstall|install:bytes|install:progress/);
  assert.match(main, /requirePlan\(request\.gameId, request\.planId\)/);
  assert.match(main, /planFingerprint\(candidate\) === planFingerprint\(plan\)/);
  assert.match(main, /if \(operations\.isActive\(\)\) throw/);
  assert.match(main, /if \(pendingMutations > 0\) throw/);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /r\.storageId !== `\$\{r\.kind\}-\$\{r\.componentId\}\.json`/);
  const removalStart = main.indexOf('const receipts = await readSafeRemovalReceipts(');
  const removalEnd = main.indexOf('} catch (err)', removalStart);
  assert.ok(removalStart >= 0 && removalEnd > removalStart, 'desktop removal uses the strict one-read receipt guard');
  assert.match(main.slice(removalStart, removalEnd), /profile\.executable \? \[profile\.executable\] : \[\]/);
  assert.doesNotMatch(main.slice(removalStart, removalEnd), /readReceipts\(|readReceiptEvidence\(/);
  assert.match(main.slice(removalStart, removalEnd), /uninstallReceipt\(receipts\[index\]!/);
});

test('standalone font requests cannot execute a normal translator plan or change its payload', () => {
  assert.match(main, /\(request\.kind === 'install-font'\) !== \(plan\.purpose === 'font'\)/);
  assert.match(main, /resolveFontPlan\(registry, profile, installedFontOptions\(options, fontConfig\)\)/);
  assert.match(main, /planFingerprint\(fresh\) !== planFingerprint\(plan\)/);
  assert.match(main, /fontWriteBlockKey\(profile, fresh, receiptsEvidence, installations, fontConfig\)/);
  assert.match(main, /receipts\.sort\(\(a, b\) => Number\(b\.kind === 'font'\) - Number\(a\.kind === 'font'\)\)/);
});
