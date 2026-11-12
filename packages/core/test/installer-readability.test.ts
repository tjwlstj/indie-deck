import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { requireInstallerProbeRunner, installerProbeEnvironment } from '../../../scripts/check-installer-readability.mjs';

const hosted = { GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_REPOSITORY: 'tjwlstj/indie-deck', INDIEDECK_INSTALLER_READABILITY_CI: '1', RUNNER_TEMP: 'C:\\runner\\temp' };
test('installer readability probe cannot create a local or foreign-runner GUI', () => {
  requireInstallerProbeRunner(hosted,'win32','x64');
  for (const change of [{ GITHUB_ACTIONS: undefined }, { CI: undefined }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_REPOSITORY: 'other/repo' }, { INDIEDECK_INSTALLER_READABILITY_CI: undefined },
    { RUNNER_TEMP: 'relative' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) {
    assert.throws(() => requireInstallerProbeRunner({ ...hosted,...change },'win32','x64'));
  }
  assert.throws(() => requireInstallerProbeRunner(hosted,'linux','x64'));
  assert.throws(() => requireInstallerProbeRunner(hosted,'win32','arm64'));
  const env = { ...process.env }; delete env.INDIEDECK_INSTALLER_READABILITY_CI;
  const result=spawnSync(process.execPath,['scripts/check-installer-readability.mjs'],{env,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,1); assert.match(result.stderr,/installer-readability/);
});

test('wizard inspection does not inherit credentials or unrelated application controls', () => {
  const clean=installerProbeEnvironment({ PATH:'runtime',SystemRoot:'C:\\Windows',CI:'true',
    INDIEDECK_INSTALLER_READABILITY_CI:'1',GH_TOKEN:'private',GITHUB_TOKEN:'private',
    NODE_OPTIONS:'unwanted',INDIEDECK_SMOKE:'unwanted',CSC_KEY_PASSWORD:'private' });
  assert.deepEqual(clean,{ PATH:'runtime',SystemRoot:'C:\\Windows',CI:'true',INDIEDECK_INSTALLER_READABILITY_CI:'1' });
});

test('NSIS customization applies native DPI/font policy after language setup and preserves upgrade initialization', () => {
  const root=new URL('../../../',import.meta.url);
  const include=fs.readFileSync(new URL('build/installer.nsh',root),'utf8');
  const template=fs.readFileSync(new URL('node_modules/app-builder-lib/templates/nsis/installer.nsi',root),'utf8');
  const header=/!macro customHeader\b([\s\S]*?)!macroend/.exec(include)?.[1] ?? '';
  assert.match(header,/ManifestDPIAware true/); assert.match(header,/SetFont "Malgun Gothic" 10/);
  assert.equal((include.match(/!macro customHeader\b/g) ?? []).length,1);
  assert.ok(template.indexOf('!insertmacro addLangs') < template.indexOf('!insertmacro customHeader'));
  assert.match(include,/!macro customInit[\s\S]*ReadRegStr \$R0 HKCU[\s\S]*StrCpy \$INSTDIR "\$R0"/);
});
