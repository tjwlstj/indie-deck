import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function requireBrowserPanelRunner(environment, platform, arch) {
  assert.equal(platform, 'linux', 'Browser integration probe requires hosted Linux.');
  assert.equal(arch, 'x64');
  assert.equal(environment.GITHUB_ACTIONS, 'true'); assert.equal(environment.CI, 'true');
  assert.equal(environment.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(environment.GITHUB_REPOSITORY, 'tjwlstj/indie-deck');
  assert.equal(environment.INDIEDECK_BROWSER_PANEL_CI, '1');
  assert.ok(typeof environment.RUNNER_TEMP === 'string' && path.posix.isAbsolute(environment.RUNNER_TEMP));
  assert.notEqual(environment.NODE_TLS_REJECT_UNAUTHORIZED, '0');
}

async function main() {
  // Never start a developer's browser or use a personal browser profile.
  requireBrowserPanelRunner(process.env, process.platform, process.arch);
  assert.equal(process.argv.length, 2);
  const { chromium } = await import('playwright-core');
  const parent = await fs.realpath(process.env.RUNNER_TEMP);
  const fixture = await fs.mkdtemp(path.join(parent, 'indiedeck-browser-panel-'));
  const extension = path.join(fixture, 'extension'), evidence = path.resolve('out/browser-panel');
  await fs.mkdir(evidence, { recursive: true });
  const source = path.resolve('extensions/browser-companion');
  let context, page;
  const pageErrors = [];
  const safeError = value => String(value).replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 600);
  const result = { passed: false, fixtureOnly: true, personalProfileUsed: false,
    initialPermissionDialogTested: false, grantedTestOrigin: 'https://store.steampowered.com', checks: [] };
  const watchdog = setTimeout(() => { console.error('[browser-panel] integration probe exceeded 180 seconds'); process.exit(1); }, 180000);
  try {
    await fs.cp(source, extension, { recursive: true, dereference: false });
    const manifestFile = path.join(extension, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    assert.equal(manifest.host_permissions, undefined, 'Shipped extension must not pregrant hosts.');
    // Only this disposable test copy pregrants one synthetic origin. Production
    // still requests optional site access from a real user gesture.
    manifest.host_permissions = ['https://store.steampowered.com/*'];
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    context = await chromium.launchPersistentContext(path.join(fixture, 'profile'), {
      channel: 'chromium', headless: true, chromiumSandbox: true, locale: 'ko-KR',
      viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
    });
    context.setDefaultTimeout(15000);
    const unexpected = [], downloads = [];
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://store.steampowered.com') {
        unexpected.push(url.origin); await route.abort(); return;
      }
      const product = url.pathname.startsWith('/app/');
      await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html lang="ko"><head>
        <title>${product ? 'IndieDeck CI 게임' : 'Private fixture'}</title>
        <meta property="og:image" content="https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg">
        </head><body><h1>${product ? '격리된 상품 페이지' : '격리된 비공개 경로'}</h1></body></html>` });
    });
    let worker = context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://'));
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    assert.ok(worker.url().startsWith('chrome-extension://'));
    const extensionId = new URL(worker.url()).hostname;
    page = await context.newPage(); page.on('download', download => downloads.push(download));
    page.on('pageerror', error => { if (pageErrors.length < 10) pageErrors.push(safeError(error.message)); });
    page.on('console', message => { if (['error', 'warning'].includes(message.type()) && pageErrors.length < 10) pageErrors.push(safeError(message.text())); });
    const cdp = await context.newCDPSession(page);
    const find = (node, predicate) => {
      if (predicate(node)) return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
        const found = find(child, predicate); if (found) return found;
      }
      return null;
    };
    const hasId = (node, id) => { const at = (node.attributes ?? []).indexOf('id'); return at >= 0 && node.attributes[at + 1] === id; };
    async function panelNode(id) {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const host = find(root, node => hasId(node, 'indiedeck-product-panel-host'));
      return host && (id === 'indiedeck-product-panel-host' ? host : find(host, node => hasId(node, id)));
    }
    async function until(check, label) {
      const end = Date.now() + 15000;
      while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('Browser integration condition failed: ' + label);
    }
    async function visible(id) {
      const node = await panelNode(id); if (!node) return false;
      return cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).then(value => value.model.width > 0 && value.model.height > 0, () => false);
    }
    async function click(id) {
      await until(() => visible(id), 'visible ' + id);
      const node = await panelNode(id);
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId });
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
      const quad = model.border;
      await page.mouse.click((quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2);
    }
    await page.goto('https://store.steampowered.com/app/440/Fixture/?tracking=fixture');
    assert.equal(await panelNode('indiedeck-product-panel-host'), null, 'Automatic panels start disabled.');
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ indiedeckAutoPanel: { schemaVersion: 1,
        enabledOrigins: ['https://store.steampowered.com'], collapsedOrigins: [] } });
    });
    await until(async () => (await worker.evaluate(async () => chrome.scripting.getRegisteredContentScripts()))
      .some(script => script.id === 'indiedeck-product-panel-v1'), 'registered granted origin');
    await page.reload();
    await until(() => visible('panelCollapse'), 'automatic public product panel');
    assert.equal(downloads.length, 0, 'Automatic display must not export or download.');
    await page.screenshot({ path: path.join(evidence, 'automatic-panel-ko.png') });
    result.checks.push('Real Chromium MV3 service worker registered a granted origin and automatically displayed the product panel.');
    await click('panelCollapse'); await until(() => visible('panelReopen'), 'collapsed reopen button');
    await page.reload(); await until(() => visible('panelReopen'), 'collapse persists after reload');
    await click('panelReopen'); await until(() => visible('panelHide'), 'reopened panel');
    const downloadEvent = page.waitForEvent('download'); await click('saveLink');
    const downloaded = await downloadEvent, file = await downloaded.path();
    const text = await fs.readFile(file, 'utf8'); assert.ok(Buffer.byteLength(text) <= 8192);
    const link = JSON.parse(text); assert.equal(link.provider, 'steam'); assert.equal(link.productId, '440');
    assert.equal(link.kind, 'indiedeck-store-link'); assert.equal(link.schemaVersion, 1);
    assert.doesNotMatch(text, /tracking|fixture\?/, 'URL tracking information cannot be exported.');
    result.checks.push('Collapse/reopen persistence and explicit public-metadata file export passed.');
    await page.evaluate(() => history.pushState({}, '', '/login/?fixture=private'));
    await until(async () => !(await panelNode('indiedeck-product-panel-host')), 'SPA navigation cannot retain a public product panel on private routes');
    assert.equal(downloads.length, 1);
    await page.goto('https://store.steampowered.com/app/440/Fixture/');
    await until(() => visible('panelHide'), 'public navigation restores enabled panel');
    await click('panelHide'); await until(() => visible('panelReopen'), 'hide leaves reopen button');
    await page.goto('https://store.steampowered.com/login/?fixture=private');
    await page.waitForTimeout(500);
    assert.equal(await panelNode('indiedeck-product-panel-host'), null, 'Private routes cannot mount a panel.');
    await page.evaluate(() => history.pushState({}, '', '/app/440/Fixture/'));
    await until(() => visible('panelReopen'), 'hidden state persists for next product');
    result.checks.push('Initial private page can soft-navigate to a public product using URL-only routing.');
    await click('panelReopen'); await click('panelDisableSite');
    await until(async () => !(await worker.evaluate(async () => chrome.scripting.getRegisteredContentScripts()))
      .some(script => script.id === 'indiedeck-product-panel-v1'), 'site disable unregisters content script');
    await page.reload(); await page.waitForTimeout(500);
    assert.equal(await panelNode('indiedeck-product-panel-host'), null);
    assert.deepEqual(unexpected, [], 'Page-level requests must stay inside synthetic fixtures.');
    result.checks.push('Hide/reopen, private-route exclusion and explicit site disable/unregistration passed.');
    result.extensionId = extensionId; result.extensionVersion = manifest.version;
    result.browserVersion = context.browser()?.version(); result.passed = true;
    console.log('[browser-panel] PASS: real isolated Chromium auto panel, hide/reopen, private-route exclusion and metadata export.');
  } catch (error) { result.error = safeError(error.message); throw error; }
  finally {
    result.pageErrors = pageErrors;
    if (!result.passed && page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    if (context) await context.close(); clearTimeout(watchdog);
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    assert.equal(path.dirname(path.resolve(fixture)), parent);
    assert.ok(path.basename(fixture).startsWith('indiedeck-browser-panel-'));
    assert.equal(await fs.realpath(fixture), path.resolve(fixture));
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error('[browser-panel] ' + error.message); process.exitCode = 1; });
}
