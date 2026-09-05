import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const source = await readFile(new URL('../dist/playlist-sort.user.js', import.meta.url), 'utf8');
const expected = ['past', 'current', 'short', 'tie', 'minute', 'long', 'live', 'unknown'];

async function fixture(page, mode = 'normal', extra = {}) {
  await page.goto('about:blank');
  await page.evaluate((mode, extra) => {
    const panel = document.createElement('ytd-playlist-panel-renderer');
    const items = document.createElement('div');
    items.id = 'items';
    panel.append(items);
    document.body.replaceChildren(panel);
    if (mode === 'trusted-types') {
      const csp = document.createElement('meta');
      csp.httpEquiv = 'Content-Security-Policy';
      csp.content = "require-trusted-types-for 'script'; trusted-types 'none'";
      document.head.append(csp);
    }
    const entries = [
      ['past', '9:00'], ['current', '10:00'], ['long', '4:00'],
      ['short', '0:15'], ['tie', '0:15'], ['live', 'LIVE'], ['unknown', ''], ['minute', '1:00'],
    ].map(([id, length]) => ({ playlistPanelVideoRenderer: {
      playlistSetVideoId: id, videoId: id === 'tie' ? 'short' : id,
      selected: id === 'current', lengthText: { simpleText: length },
      isLive: id === 'live',
    } }));
    const data = { contents: entries, playlistId: 'TLPQ-fixture', currentIndex: 1, totalVideos: entries.length, ...extra };
    const state = window.fixture = { moves: 0, playerNext: 'long', data };
    const render = () => {
      panel.querySelector('#items').replaceChildren(...data.contents.map(entry => {
        const row = document.createElement('ytd-playlist-panel-video-renderer');
        row.data = entry.playlistPanelVideoRenderer;
        row.textContent = row.data.playlistSetVideoId;
        if (row.data.selected) row.setAttribute('selected', '');
        return row;
      }));
      state.playerNext = data.contents[data.currentIndex + 1]?.playlistPanelVideoRenderer.playlistSetVideoId;
    };
    panel.polymerController = {
      data, canReorder: true, shuffleOn: extra.shuffleOn ?? false,
      ytReorderableController: { handleDrop({ currDragItem }) {
        if (mode === 'throw') throw new Error('fixture drop failure');
        if (mode === 'noop') return;
        const token = currDragItem.data.playlistSetVideoId;
        const destination = [...currDragItem.parentNode.childNodes].indexOf(currDragItem);
        const original = data.contents.findIndex(entry => entry.playlistPanelVideoRenderer.playlistSetVideoId === token);
        const moved = data.contents.splice(original, 1)[0];
        data.contents.splice(destination, 0, moved);
        state.moves++;
        if (mode === 'concurrent') data.contents.push({ playlistPanelVideoRenderer: { playlistSetVideoId: 'new', lengthText: { simpleText: '0:01' } } });
        if (mode === 'advance') {
          data.contents[data.currentIndex].playlistPanelVideoRenderer.selected = false;
          data.currentIndex++;
          data.contents[data.currentIndex].playlistPanelVideoRenderer.selected = true;
        }
        render();
      } },
    };
    render();
  }, mode, extra);
  // Evaluate through the test debugger so the userscript runs with the page's
  // Trusted Types checks, without creating a blocked inline <script> element.
  await page.evaluate(source);
}

const click = page => page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button').click());
const settled = page => page.waitForFunction(() => !document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button').dataset.running, { timeout: 12000 });
const result = page => page.evaluate(() => ({
  order: window.fixture.data.contents.map(entry => entry.playlistPanelVideoRenderer.playlistSetVideoId),
  visible: [...document.querySelectorAll('#items > *')].map(row => row.data.playlistSetVideoId),
  next: window.fixture.playerNext, moves: window.fixture.moves,
  status: document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[role=status]').textContent,
  detail: document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button').title,
}));

for (const [browserName, executablePath] of [
  ['firefox', process.env.FIREFOX_BIN || '/usr/bin/firefox'],
  ['chrome', process.env.CHROMIUM_BIN || '/usr/bin/chromium'],
]) {
  const browser = await puppeteer.launch({ browser: browserName, executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await fixture(page);
    await click(page); await settled(page);
    let actual = await result(page);
    assert.deepEqual(actual.order, expected);
    assert.deepEqual(actual.visible, expected);
    assert.equal(actual.next, 'short'); // Independent player state must also update.
    assert.match(actual.status, /^Sorted loaded/);
    const moves = actual.moves;
    await click(page); await settled(page);
    assert.equal((await result(page)).moves, moves);

    for (const mode of ['throw', 'noop']) {
      await fixture(page, mode); await click(page); await settled(page);
      actual = await result(page);
      assert.equal(actual.order[2], 'long');
      assert.deepEqual(actual.visible, actual.order);
      assert.doesNotMatch(actual.status, /^Sorted/);
    }
    for (const mode of ['concurrent', 'advance']) {
      await fixture(page, mode); await click(page); await settled(page);
      actual = await result(page);
      assert.equal(actual.moves, 1);
      assert.match(actual.status, /changed|change/);
    }
    await fixture(page, 'normal', { shuffleOn: true }); await click(page); await settled(page);
    assert.equal((await result(page)).moves, 0);
    assert.match((await result(page)).status, /shuffle/);

    await fixture(page); await click(page); await click(page); await settled(page);
    assert.match((await result(page)).status, /^Stopped/);
    assert.equal((await result(page)).moves, 1);

    await fixture(page, 'noop'); await click(page); await click(page); await settled(page);
    actual = await result(page);
    assert.match(actual.status, /^Stopped/);
    assert.deepEqual(actual.visible, actual.order);

    await fixture(page, 'normal', { playlistId: 'PL-owned', totalVideos: 100 });
    actual = await result(page);
    assert.match(actual.detail, /Loaded 8 of 100/);
    assert.match(actual.detail, /saved playlist order/);
    await page.addScriptTag({ content: source });
    assert.equal(await page.$$('yt-up-next-duration-sort').then(hosts => hosts.length), 1);

    await fixture(page, 'trusted-types');
    // Confirm that this regression test really enforces Trusted Types.
    assert.equal(await page.evaluate(() => {
      try { document.createElement('div').innerHTML = '<b>blocked</b>'; return false; }
      catch { return true; }
    }), true);
    const bounds = await page.evaluate(() => {
      const button = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button');
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert.ok(bounds.width > 0 && bounds.height > 0);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, expected);
    assert.equal(actual.next, 'short');
    assert.match(actual.status, /^Sorted loaded/);
    console.log(`${browserName}: 11 browser fixture scenarios passed`);
  } finally {
    await browser.close();
  }
}
