import fs from 'node:fs/promises';

// This entry point replaces downloads only inside the disposable smoke app.
// Production main/core have no mock network or plan bypass.
const archive = await fs.readFile(process.env.INDIEDECK_SMOKE_ARCHIVE);
const fontArchive = await fs.readFile(process.env.INDIEDECK_SMOKE_FONT_ARCHIVE);
const version = process.env.INDIEDECK_SMOKE_VERSION;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith('https://api.github.com/repos/bbepis/XUnity.AutoTranslator/releases/')) {
    return new Response(JSON.stringify({ tag_name: `v${version}`, assets: [{
      name: `XUnity.AutoTranslator-BepInEx-${version}.zip`,
      browser_download_url: 'https://smoke.invalid/translator.zip', size: archive.length,
    }, {
      name: process.env.INDIEDECK_SMOKE_FONT_ASSET,
      browser_download_url: 'https://smoke.invalid/fonts.7z', size: fontArchive.length,
    }] }), { headers: { 'content-type': 'application/json' } });
  }
  if (url === 'https://smoke.invalid/fonts.7z') return new Response(fontArchive, { headers: { 'content-length': String(fontArchive.length) } });
  if (url === 'https://smoke.invalid/translator.zip') {
    let cursor = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const next = Math.min(cursor + 128 * 1024, archive.length);
        controller.enqueue(archive.subarray(cursor, next));
        cursor = next;
        if (cursor === archive.length) controller.close();
      },
    }), { headers: { 'content-length': String(archive.length) } });
  }
  throw new Error(`Unexpected network access in the offline desktop smoke: ${url}`);
};

await import('../packages/desktop/dist/main.js');
