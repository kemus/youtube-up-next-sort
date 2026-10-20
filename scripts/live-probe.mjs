// Live probe: builds a signed-out temporary queue on YouTube in headless
// Chromium, injects dist/playlist-sort.user.js with in-memory GM storage,
// then runs a steps module. Without one it screenshots the row and settings.
// Usage: npm run probe -- [steps.mjs] [outDir]
// Env: SETTINGS (JSON for the script's storage), QUEUE (videos to queue, 8),
// CHROMIUM_BIN. A steps module default-exports
// async ({ page, root, queue, shot, sleep, log }) => {}.
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const [stepsPath, outArg] = process.argv.slice(2);
const outDir = outArg ?? await mkdtemp(join(tmpdir(), 'playlist-sort-probe-'));
await mkdir(outDir, { recursive: true });

// Screenshot the row, then the open settings panel.
const look = async ({ page, queue, shot, sleep, log }) => {
  log(await queue());
  log(await shot('row'));
  await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-action=settings]').click());
  await sleep(300);
  log(await shot('settings'));
};
const count = Number(process.env.QUEUE ?? 8);
const browser = await puppeteer.launch({
  browser: 'chrome', executablePath: process.env.CHROMIUM_BIN || '/usr/bin/chromium', headless: true,
  args: ['--autoplay-policy=user-gesture-required', '--mute-audio', '--window-size=1400,1000'],
  defaultViewport: { width: 1400, height: 1000, deviceScaleFactor: 2 },
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const page = await browser.newPage();
  await page.goto('https://www.youtube.com/@kurzgesagt/videos', { waitUntil: 'networkidle2', timeout: 60000 });
  const added = await page.evaluate(async count => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let added = 0;
    for (const button of document.querySelectorAll('button[aria-label="More actions"]')) {
      if (added >= count) break;
      button.click(); await sleep(600);
      const item = [...document.querySelectorAll('yt-list-item-view-model, ytd-menu-service-item-renderer, tp-yt-paper-item')]
        .find(element => element.getClientRects().length && /add to queue/i.test(element.textContent));
      if (item) { (item.querySelector('button, [role=menuitem]') ?? item).click(); added++; } else document.body.click();
      await sleep(700);
    }
    return added;
  }, count);
  // Open the queue on the watch page through the miniplayer's expand control.
  await page.evaluate(() => {
    const expand = [...document.querySelectorAll('button, [role=button]')]
      .find(element => element.getClientRects().length && /expand/i.test(element.getAttribute('aria-label') ?? element.title ?? ''));
    expand?.click();
  });
  await page.waitForFunction(() => {
    const panel = [...document.querySelectorAll('ytd-playlist-panel-renderer')].find(element => element.getClientRects().length);
    const controller = panel?.polymerController ?? panel?.inst ?? panel;
    return controller?.canReorder === true && controller.data?.contents?.length > 1;
  }, { timeout: 30000 });
  await page.evaluate(() => { const video = document.querySelector('video'); video?.pause(); });
  const source = await readFile(new URL('../dist/playlist-sort.user.js', import.meta.url), 'utf8');
  await page.evaluate(settings => {
    const store = window.gmStore = { ...settings };
    window.GM_getValue = (name, fallback) => name in store ? store[name] : fallback;
    window.GM_setValue = (name, value) => { store[name] = value; };
    // Open the closed shadow root so steps can reach inside.
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) { return attachShadow.call(this, { ...init, mode: 'open' }); };
  }, JSON.parse(process.env.SETTINGS ?? '{}'));
  await page.evaluate(source);
  await page.waitForFunction(() => document.querySelector('yt-up-next-duration-sort'), { timeout: 10000 });
  await sleep(500);
  const root = () => page.evaluateHandle(() => document.querySelector('yt-up-next-duration-sort').shadowRoot);
  const queue = () => page.evaluate(() => {
    const panel = [...document.querySelectorAll('ytd-playlist-panel-renderer')].find(element => element.getClientRects().length);
    const controller = panel.polymerController ?? panel.inst ?? panel;
    return { current: controller.data.currentIndex, items: controller.data.contents.map(entry => {
      const data = entry.playlistPanelVideoRenderer;
      return `${data.videoId} ${data.lengthText?.simpleText ?? ''} ${(data.title?.simpleText ?? data.title?.runs?.[0]?.text ?? '').slice(0, 30)}`;
    }) };
  });
  const shot = async name => {
    const panel = await page.$('ytd-playlist-panel-renderer:not([hidden])') ?? await page.$('ytd-playlist-panel-renderer');
    const box = await panel.boundingBox();
    const path = `${outDir}/${name}.png`;
    await page.screenshot({ path, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 520) } });
    return path;
  };
  console.log(JSON.stringify({ added }));
  const run = stepsPath ? (await import(pathToFileURL(stepsPath).href)).default : look;
  await run({ page, root, queue, shot, sleep, log: value => console.log(typeof value === 'string' ? value : JSON.stringify(value)) });
} finally {
  await browser.close();
}
