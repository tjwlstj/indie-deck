import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function requireInstallerProbeRunner(environment, platform, arch) {
  assert.equal(platform, 'win32', 'Installer probe requires hosted Windows.');
  assert.equal(arch, 'x64');
  assert.equal(environment.GITHUB_ACTIONS, 'true');
  assert.equal(environment.CI, 'true');
  assert.equal(environment.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(environment.GITHUB_REPOSITORY, 'tjwlstj/indie-deck');
  assert.equal(environment.INDIEDECK_INSTALLER_READABILITY_CI, '1');
  assert.equal(typeof environment.RUNNER_TEMP, 'string');
  assert.ok(path.win32.isAbsolute(environment.RUNNER_TEMP));
  assert.notEqual(environment.NODE_TLS_REJECT_UNAUTHORIZED, '0');
}

export function installerProbeEnvironment(environment) {
  const clean = {};
  for (const [key,value] of Object.entries(environment)) {
    if (/^(path|pathext|systemroot|windir|comspec|systemdrive|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?|temp|tmp|appdata|localappdata|userprofile|username|number_of_processors|processor_architecture|GITHUB_ACTIONS|CI|RUNNER_ENVIRONMENT|GITHUB_REPOSITORY|RUNNER_TEMP|INDIEDECK_INSTALLER_READABILITY_CI)$/i.test(key)) clean[key]=value;
  }
  return clean;
}

async function main() {
  // Refuse local GUI work before reading, writing or creating any process.
  requireInstallerProbeRunner(process.env, process.platform, process.arch);
  assert.equal(process.argv.length, 2, 'Installer probe accepts no executable argument.');
  const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const executable = path.resolve('release', `IndieDeck-Setup-${version}-x64.exe`);
  assert.ok((await fs.lstat(executable)).isFile(), 'Current installer is missing.');
  const script = path.resolve('scripts', 'check-installer-readability.ps1');
  const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd: process.cwd(), windowsHide: true, stdio: 'inherit',
      env: { ...installerProbeEnvironment(process.env), INDIEDECK_INSTALLER_PROBE_EXE: executable },
    });
  let finish, timedOut=false;
  const completion=new Promise(resolve => {
    let settled=false;
    finish=value=>{ if(!settled){settled=true;resolve(value);} };
    child.once('error', error=>finish({code:null,error:error.message}));
    child.once('close',(code,signal)=>finish({code,signal}));
  });
  const timer=setTimeout(()=>{
    timedOut=true;
    if(Number.isSafeInteger(child.pid) && child.pid>0 && child.exitCode===null && child.signalCode===null) {
      spawnSync('C:\\Windows\\System32\\taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000,stdio:'ignore'});
    }
    finish({code:null,error:'Owned installer probe exceeded its time limit.'});
  },90000);
  let outcome;
  try { outcome=await completion; }
  finally { clearTimeout(timer); if(timedOut) child.unref(); }
  assert.equal(outcome.code, 0, 'Installer wizard font/DPI probe failed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error('[installer-readability] ' + error.message); process.exitCode = 1; });
}
