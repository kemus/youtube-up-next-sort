import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';

const source = await readFile(new URL('../dist/playlist-sort.user.js', import.meta.url), 'utf8');
const expected = ['past', 'current', 'short', 'tie', 'minute', 'long', 'live', 'unknown'];
const original = ['past', 'current', 'long', 'short', 'tie', 'live', 'unknown', 'minute'];
const descending = ['past', 'current', 'long', 'minute', 'short', 'tie', 'live', 'unknown'];

// An empty page on a real origin, so fixtures can change the address bar like YouTube does.
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>fixture</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const blank = `http://127.0.0.1:${server.address().port}/`;

// options: settings (manager storage contents; dedupe is off unless set or freshStorage),
// freshStorage (empty storage, for defaults), noStorage, watched ({ id: percent }),
// api ('quota' for a quota error), removeMode ('noop' for an ignored removal, 'late' for one applied
// after 200 ms), removeVia ('command' when YouTube's menu item is unavailable), play ('ignore' for row
// links that start nothing), titles ({ id: title }), current (the playing id; 'current' by default).
async function fixture(page, mode = 'normal', extra = {}, options = {}) {
  await page.goto(blank);
  // Each fixture needs a fresh page, without an earlier copy of the userscript.
  assert.equal(await page.evaluate(() => typeof window.fixture), 'undefined');
  await page.evaluate((mode, extra, options) => {
    if (!options.noStorage) {
      const store = window.gmStore = options.freshStorage ? {} : { dedupe: false, ...options.settings };
      window.GM_getValue = (name, fallback) => name in store ? store[name] : fallback;
      window.GM_setValue = (name, value) => { store[name] = value; };
    }
    // Without a symbols font every font measures the trash icon alike.
    if (options.noGlyphFont) CanvasRenderingContext2D.prototype.measureText = () => ({ width: 10 });
    // The control asks for a closed shadow root; record that, then open it so tests can reach inside.
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      window.shadowModes = [...window.shadowModes ?? [], init.mode];
      return attachShadow.call(this, { ...init, mode: 'open' });
    };
    const table = {
      long: { views: '500', likes: '5', date: '2020-01-01T00:00:00Z' },
      short: { views: '20', likes: '9', date: '2024-01-01T00:00:00Z' },
      minute: { views: '100', date: '2022-01-01T00:00:00Z' }, // Likes hidden.
      live: { views: '7', likes: '1', date: '2019-01-01T00:00:00Z' },
    }; // 'unknown' is omitted, as the API omits private videos.
    window.fetch = async (url, init) => {
      window.fixture.requests.push(String(url));
      window.fixture.apiKeys.push(init?.headers?.['X-Goog-Api-Key']);
      if (options.api === 'quota') {
        return new Response(JSON.stringify({ error: { code: 403, message: 'Quota exceeded.', errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 });
      }
      return new Response(JSON.stringify({ items: new URL(url).searchParams.get('id').split(',').filter(id => table[id]).map(id => ({
        id, snippet: { publishedAt: table[id].date }, statistics: { viewCount: table[id].views, likeCount: table[id].likes },
      })) }));
    };
    const app = document.createElement('ytd-app');
    const panel = document.createElement('ytd-playlist-panel-renderer');
    const items = document.createElement('div');
    items.id = 'items';
    // YouTube's queue header row, where Save is the only visible control.
    const actions = document.createElement('div');
    actions.id = 'playlist-actions';
    const flexible = document.createElement('div');
    flexible.id = 'flexible-item-buttons';
    const renderer = document.createElement('ytd-button-renderer');
    const save = document.createElement('button');
    save.setAttribute('aria-label', 'Save queue');
    // YouTube sizes its icons inline to fill a 24px box.
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '24');
    icon.setAttribute('height', '24');
    icon.setAttribute('style', 'pointer-events: none; display: inherit; width: 100%; height: 100%;');
    renderer.style.cssText = 'display: block; width: 90px; height: 36px;';
    save.style.cssText = 'width: 100%; height: 100%;';
    save.append(icon, 'Save');
    save.addEventListener('click', () => window.fixture.saves++);
    renderer.append(save);
    flexible.append(renderer);
    actions.append(flexible);
    if (extra.extraAction) actions.append(Object.assign(document.createElement('button'), { textContent: 'Loop' }));
    panel.append(actions, items);
    document.body.replaceChildren(app, panel);
    if (mode === 'trusted-types') {
      const csp = document.createElement('meta');
      csp.httpEquiv = 'Content-Security-Policy';
      csp.content = "require-trusted-types-for 'script'; trusted-types 'none'";
      document.head.append(csp);
    }
    const playlistId = extra.playlistId ?? 'TLPQ-fixture';
    // Like YouTube, playing a row in place moves currentIndex and the address
    // bar but can leave every selected flag on the old position.
    let playing = null;
    const playingIndex = () => data.contents.findIndex(entry => playing
      ? entry.playlistPanelVideoRenderer.playlistSetVideoId === playing
      : entry.playlistPanelVideoRenderer.selected);
    const entries = [
      ['past', '9:00'], ['current', '10:00'], ['long', '4:00'],
      ['short', '0:15'], ['tie', '0:15'], ['live', 'LIVE'], ['unknown', ''], ['minute', '1:00'],
    ].map(([id, length]) => ({ playlistPanelVideoRenderer: {
      playlistSetVideoId: id, videoId: id === 'tie' ? 'short' : id,
      selected: id === (options.current ?? 'current'), lengthText: { simpleText: length },
      ...options.titles?.[id] ? { title: { simpleText: options.titles[id] } } : {},
      isLive: id === 'live',
      thumbnailOverlays: options.watched?.[id]
        ? [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: options.watched[id] } }] : [],
      menu: { menuRenderer: { items: [
        { menuServiceItemRenderer: { serviceEndpoint: { playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: id, action: 'ACTION_ADD_VIDEO' }] } } } },
        { menuServiceItemRenderer: { serviceEndpoint: { playlistEditEndpoint: { playlistId, actions: [{ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' }] } } } },
      ] } },
    } }));
    const currentIndex = entries.findIndex(entry => entry.playlistPanelVideoRenderer.selected);
    const data = { contents: entries, playlistId, currentIndex, totalVideos: entries.length, ...extra };
    const state = window.fixture = { render: () => render(), moves: 0, saves: 0, keys: 0, removed: [], edits: [], commands: 0, requests: [], apiKeys: [], playerNext: 'long', plays: [], data };
    document.addEventListener('keydown', () => state.keys++);
    // Stands in for YouTube running a playlist edit, with every action it carries.
    const runEdit = endpoint => {
      const edit = endpoint.playlistEditEndpoint;
      if (options.removeMode === 'noop' || edit.actions.some(action => action.action !== 'ACTION_REMOVE_VIDEO')) return;
      state.edits.push(edit.actions.length);
      const apply = () => {
        const token = id => entry => entry.playlistPanelVideoRenderer.playlistSetVideoId === id;
        const current = data.contents[data.currentIndex].playlistPanelVideoRenderer.playlistSetVideoId;
        for (const { setVideoId } of edit.actions) {
          data.contents.splice(data.contents.findIndex(token(setVideoId)), 1);
          state.removed.push(setVideoId);
        }
        data.currentIndex = data.contents.findIndex(token(current));
        render();
      };
      if (options.removeMode === 'late') setTimeout(apply, 200); else apply();
    };
    // YouTube's menu item, which runs its service endpoint when clicked;
    // removeVia 'command' leaves only the command handler.
    if (options.removeVia !== 'command') {
      customElements.define('ytd-menu-service-item-renderer', class extends HTMLElement {
        connectedCallback() { this.addEventListener('click', () => runEdit(this.data.serviceEndpoint)); }
      });
    }
    app.resolveCommand = endpoint => { state.commands++; runEdit(endpoint); };
    const render = () => {
      panel.querySelector('#items').replaceChildren(...data.contents.map(entry => {
        const row = document.createElement('ytd-playlist-panel-video-renderer');
        row.data = entry.playlistPanelVideoRenderer;
        // The row's link plays it in place, starting with YouTube's navigation event.
        const link = document.createElement('a');
        link.id = 'wc-endpoint';
        link.href = '#';
        link.textContent = row.data.playlistSetVideoId;
        link.addEventListener('click', event => {
          event.preventDefault();
          if (options.play === 'ignore') return;
          state.plays.push(row.data.playlistSetVideoId);
          document.dispatchEvent(new Event('yt-navigate-start'));
          playing = row.data.playlistSetVideoId;
          history.replaceState(null, '', `?v=${row.data.videoId}`);
          data.currentIndex = playingIndex();
          setTimeout(render, 30);
        });
        row.append(link);
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
        // A build that applies the move after handleDrop returns.
        if (mode === 'delayed') {
          setTimeout(() => {
            const original = data.contents.findIndex(entry => entry.playlistPanelVideoRenderer.playlistSetVideoId === token);
            data.contents.splice(destination, 0, data.contents.splice(original, 1)[0]);
            data.currentIndex = playingIndex();
            state.moves++;
            render();
          }, 60);
          return;
        }
        const original = data.contents.findIndex(entry => entry.playlistPanelVideoRenderer.playlistSetVideoId === token);
        const moved = data.contents.splice(original, 1)[0];
        data.contents.splice(destination, 0, moved);
        // YouTube keeps the current index on the playing video as rows move.
        data.currentIndex = playingIndex();
        state.moves++;
        if (mode === 'concurrent') data.contents.push({ playlistPanelVideoRenderer: { playlistSetVideoId: 'new', lengthText: { simpleText: '0:01' } } });
        if (mode === 'advance') {
          data.contents[data.currentIndex].playlistPanelVideoRenderer.selected = false;
          data.currentIndex++;
          data.contents[data.currentIndex].playlistPanelVideoRenderer.selected = true;
        }
        render();
        // Press Stop right after the first move, once the click that started the sort returns.
        if (mode === 'stop' && state.moves === 1) {
          queueMicrotask(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button[data-sort]').click());
        }
      } },
    };
    render();
  }, mode, extra, options);
  // Evaluate through the test debugger so the userscript runs with the page's
  // Trusted Types checks, without creating a blocked inline <script> element.
  await page.evaluate(source);
}

const click = page => page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button[data-sort]').click());
const settled = page => page.waitForFunction(() => !document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button[data-sort]').dataset.running, { timeout: 12000 });
const press = (page, selector) => page.evaluate(selector => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector(selector).click(), selector);
const idle = page => page.waitForFunction(() => !document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button[data-running]'), { timeout: 12000 });
const shown = (page, selector) => page.evaluate(selector => {
  const element = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector(selector);
  return element.getClientRects().length > 0 && !element.disabled;
}, selector);
const result = page => page.evaluate(() => ({
  removed: window.fixture.removed, requests: window.fixture.requests, current: window.fixture.data.currentIndex,
  order: window.fixture.data.contents.map(entry => entry.playlistPanelVideoRenderer.playlistSetVideoId),
  visible: [...document.querySelectorAll('#items > *')].map(row => row.data.playlistSetVideoId),
  next: window.fixture.playerNext, moves: window.fixture.moves,
  status: document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[role=status]').textContent,
  detail: document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button[data-sort]').title,
}));

for (const [browserName, executablePath] of [
  ['firefox', process.env.FIREFOX_BIN || '/usr/bin/firefox'],
  ['chrome', process.env.CHROMIUM_BIN || '/usr/bin/chromium'],
]) {
  const browser = await puppeteer.launch({ browser: browserName, executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await fixture(page);
    const saveState = () => page.evaluate(() => {
      const proxy = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('.save');
      return { hidden: proxy.hidden, text: proxy.textContent, icon: proxy.querySelector('svg') !== null,
        label: proxy.getAttribute('aria-label'), row: document.querySelector('#playlist-actions').style.display };
    });
    assert.deepEqual(await saveState(), { hidden: false, text: 'Save', icon: true, label: 'Save queue', row: 'none' });
    // The copied icon fits the text, so Save is no taller than the sort buttons.
    assert.deepEqual(await page.evaluate(() => {
      const root = document.querySelector('yt-up-next-duration-sort').shadowRoot;
      const height = selector => root.querySelector(selector).getBoundingClientRect().height;
      return { icon: height('.save svg') <= 16, sameHeight: Math.abs(height('.save') - height('[data-sort=duration]')) < 0.5 };
    }), { icon: true, sameHeight: true });
    await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('.save').click());
    assert.equal(await page.evaluate(() => window.fixture.saves), 1);
    await click(page); await settled(page);
    let actual = await result(page);
    assert.deepEqual(actual.order, expected);
    assert.deepEqual(actual.visible, expected);
    assert.equal(actual.next, 'short'); // Independent player state must also update.
    assert.match(actual.status, /^Sorted loaded/);
    // Only 'minute' (up) and 'long' (down) leave the run already in order.
    assert.equal(actual.moves, 2);
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, descending);
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, original);

    // With the current video in the sort, the first sorted video plays through its row,
    // and the cycle continues from the order it started with.
    await fixture(page, 'normal', {}, { settings: { includeCurrent: true } });
    assert.match((await result(page)).detail, /current video is sorted too/);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['past', 'short', 'tie', 'minute', 'long', 'current', 'live', 'unknown']);
    assert.deepEqual(actual.visible, actual.order);
    assert.equal(actual.current, 1);
    assert.deepEqual(await page.evaluate(() => window.fixture.plays), ['short']);
    assert.match(actual.status, /^Sorted loaded videos shortest to longest .*Playing the first sorted video/);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, descending);
    assert.equal(actual.order[actual.current], 'current');
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, original);
    assert.match(actual.status, /^Restored/);
    assert.deepEqual(await page.evaluate(() => window.fixture.plays), ['short', 'current']); // Undo plays nothing.
    // A row link that starts nothing leaves the sorted order and says so.
    await fixture(page, 'normal', {}, { settings: { includeCurrent: true }, play: 'ignore' });
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['past', 'short', 'tie', 'minute', 'long', 'current', 'live', 'unknown']);
    assert.match(actual.status, /did not start the first sorted video/);

    // Unwatched videos above the current one sort with the upcoming ones.
    await fixture(page, 'normal', {}, { settings: { includeAbove: true } });
    assert.match((await result(page)).detail, /Unwatched videos above it are sorted too/);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['current', 'short', 'tie', 'minute', 'long', 'past', 'live', 'unknown']);
    assert.deepEqual(actual.visible, actual.order);
    assert.equal(actual.current, 0);
    assert.match(actual.status, /^Sorted loaded videos shortest to longest/);
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, ['current', 'past', 'long', 'minute', 'short', 'tie', 'live', 'unknown']);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, original);
    assert.equal(actual.current, 1);
    // A watched video above stays put; Watched at decides what counts.
    await fixture(page, 'normal', {}, { settings: { includeAbove: true, watchedPercent: 50 }, watched: { past: 60 } });
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, expected);
    await fixture(page, 'normal', {}, { settings: { includeAbove: true, watchedPercent: 70 }, watched: { past: 60 } });
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, ['current', 'short', 'tie', 'minute', 'long', 'past', 'live', 'unknown']);

    // Watched videos move to the top, in order, above the current and sorted ones; nothing is removed.
    await fixture(page, 'normal', {}, { settings: { watchedFirst: true, watchedPercent: 50 }, watched: { long: 60, minute: 100, current: 100, short: 40 } });
    assert.match((await result(page)).detail, /Watched videos move to the top/);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['long', 'minute', 'past', 'current', 'short', 'tie', 'live', 'unknown']);
    assert.deepEqual(actual.visible, actual.order);
    assert.equal(actual.current, 3);
    assert.deepEqual(actual.removed, []);
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, ['long', 'minute', 'past', 'current', 'short', 'tie', 'live', 'unknown']);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, original);
    assert.equal(actual.current, 1);

    for (const mode of ['throw', 'noop']) {
      await fixture(page, mode); await click(page); await settled(page);
      actual = await result(page);
      assert.equal(actual.order[2], 'long');
      assert.deepEqual(actual.visible, actual.order);
      assert.doesNotMatch(actual.status, /^Sorted/);
    }
    await fixture(page, 'delayed'); await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, expected);
    assert.deepEqual(actual.visible, expected);
    assert.equal(actual.moves, 2);
    assert.match(actual.status, /^Sorted loaded/);

    for (const mode of ['concurrent', 'advance']) {
      await fixture(page, mode); await click(page); await settled(page);
      actual = await result(page);
      assert.equal(actual.moves, 1);
      assert.match(actual.status, /changed|change/);
    }
    await fixture(page, 'normal', { extraAction: true });
    assert.deepEqual(await saveState().then(({ hidden, row }) => ({ hidden, row })), { hidden: true, row: '' });

    await fixture(page, 'normal', { shuffleOn: true }); await click(page); await settled(page);
    assert.equal((await result(page)).moves, 0);
    assert.match((await result(page)).status, /shuffle/);

    await fixture(page, 'stop'); await click(page); await settled(page);
    actual = await result(page);
    assert.match(actual.status, /^Stopped/);
    assert.equal(actual.moves, 1);
    assert.deepEqual(actual.visible, actual.order);

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
      const button = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('button[data-sort]');
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert.ok(bounds.width > 0 && bounds.height > 0);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, expected);
    assert.equal(actual.next, 'short');
    assert.match(actual.status, /^Sorted loaded/);

    // Fetched sorts stay hidden until enabled with a key in the settings panel.
    await fixture(page);
    assert.equal(await shown(page, '[data-sort=views]'), false);
    assert.equal(await shown(page, '[data-setting=apiKey]'), false);
    await press(page, '[data-action=settings]');
    // Fetching needs a saved key: its toggle stays off and disabled until then.
    const fetchToggle = () => page.evaluate(() => {
      const input = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-setting=fetch]');
      return { checked: input.checked, disabled: input.disabled };
    });
    assert.deepEqual(await fetchToggle(), { checked: false, disabled: true });
    await press(page, '[data-setting=fetch]');
    assert.deepEqual(await fetchToggle(), { checked: false, disabled: true });
    const typeKey = async text => {
      await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-setting=apiKey]').focus());
      await page.keyboard.type(text);
    };
    await typeKey('key-1');
    // Typing alone saves nothing; Save does.
    assert.deepEqual(await page.evaluate(() => window.gmStore), { dedupe: false });
    assert.equal(await page.evaluate(() => window.fixture.keys), 0); // Typing must not reach YouTube's hotkeys.
    assert.deepEqual(await fetchToggle(), { checked: false, disabled: true }); // An unsaved key is not enough.
    await press(page, '[data-action=save-key]');
    assert.equal(await page.evaluate(() => window.gmStore.apiKey), 'key-1');
    assert.deepEqual(await fetchToggle(), { checked: false, disabled: false });
    assert.equal(await shown(page, '[data-sort=views]'), false);
    await press(page, '[data-setting=fetch]');
    assert.equal(await page.evaluate(() => window.gmStore.fetch), true);
    assert.equal(await shown(page, '[data-action=save-key]'), false); // Nothing left to save.
    for (const key of ['views', 'likes', 'uploaded']) assert.equal(await shown(page, `[data-sort=${key}]`), true);
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('yt-up-next-duration-sort').shadowRoot
      .querySelectorAll('[data-sort]')].map(button => button.textContent.trim())), ['Duration', 'Title', 'Views', 'Likes', 'Date']);
    // Every control fits on one line in a panel as narrow as YouTube's usual 400px,
    // even with the arrow of an active sort.
    assert.deepEqual(await page.evaluate(() => {
      const host = document.querySelector('yt-up-next-duration-sort');
      host.parentElement.style.width = '400px';
      host.shadowRoot.querySelector('[data-sort=duration]').textContent = 'Duration ↑';
      const box = host.getBoundingClientRect();
      const rects = [...host.shadowRoot.querySelectorAll('.row > button')]
        .filter(button => button.getClientRects().length).map(button => button.getBoundingClientRect());
      const result = { count: rects.length, tops: new Set(rects.map(rect => Math.round(rect.top))).size, heights: new Set(rects.map(rect => Math.round(rect.height))).size, inside: rects.every(rect => rect.right <= box.right) };
      host.parentElement.style.width = '';
      return result;
    }), { count: 9, tops: 1, heights: 1, inside: true });
    assert.deepEqual(await page.evaluate(() => window.shadowModes), ['closed']);
    // The field keeps the saved key masked and editable; Clear and Save share its line.
    const keyField = () => page.evaluate(() => {
      const root = document.querySelector('yt-up-next-duration-sort').shadowRoot;
      const input = root.querySelector('[data-setting=apiKey]');
      const middles = ['[data-setting=apiKey]', '[data-action=clear]', '[data-action=save-key]'].map(selector => {
        const rect = root.querySelector(selector).getBoundingClientRect();
        return rect.top + rect.height / 2;
      });
      return { value: input.value, type: input.type, sameLine: Math.max(...middles) - Math.min(...middles) <= 1 };
    });
    assert.deepEqual(await keyField(), { value: 'key-1', type: 'password', sameLine: true });
    await typeKey('-x');
    assert.equal(await page.evaluate(() => window.gmStore.apiKey), 'key-1');
    await press(page, '[data-action=settings]'); await press(page, '[data-action=settings]');
    assert.deepEqual(await keyField(), { value: 'key-1', type: 'password', sameLine: true }); // Unsaved edits are dropped.
    await press(page, '[data-action=clear]');
    assert.equal(await page.evaluate(() => window.gmStore.apiKey), '');
    assert.equal((await keyField()).value, '');
    assert.equal(await shown(page, '[data-sort=views]'), false);
    assert.equal(await shown(page, '[data-action=clear]'), false);
    assert.deepEqual(await fetchToggle(), { checked: false, disabled: true }); // Clearing the key turns fetching off.
    assert.equal(await page.evaluate(() => window.gmStore.fetch), false);
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('yt-up-next-duration-sort').shadowRoot
      .querySelectorAll('[role=switch]')].map(input => [input.dataset.setting, input.parentElement.textContent, input.disabled])),
    [['fetch', 'Use API key', true], ['dedupe', 'Dedupe on sort', false],
      ['includeCurrent', 'Include current video in sorting, and swap to first sorted video', false],
      ['includeAbove', 'Include unwatched videos that are above the current video in sorting', false],
      ['watchedFirst', 'Move watched videos above current and sorted videos', false],
      ['button-duration', 'Duration', false], ['button-title', 'Title', false], ['button-views', 'Views', true],
      ['button-likes', 'Likes', true], ['button-uploaded', 'Date', true], ['button-watched', 'Watched', false], ['button-above', 'Above', false]]);
    // The key field comes first, then the toggle that uses it.
    assert.equal(await page.evaluate(() => {
      const root = document.querySelector('yt-up-next-duration-sort').shadowRoot;
      const top = selector => root.querySelector(selector).getBoundingClientRect().top;
      return top('[data-setting=fetch]') > top('[data-setting=apiKey]');
    }), true);
    assert.equal(await shown(page, '.settings p'), false); // No explanatory text while settings work.
    // The watched threshold slider starts at any progress and saves as it moves.
    const percent = () => page.evaluate(() => {
      const root = document.querySelector('yt-up-next-duration-sort').shadowRoot;
      return { value: root.querySelector('[data-setting=watchedPercent]').value, text: root.querySelector('.percent output').textContent, stored: window.gmStore.watchedPercent };
    });
    assert.deepEqual(await percent(), { value: '0', text: 'any progress', stored: 0 });
    await page.evaluate(() => {
      const input = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-setting=watchedPercent]');
      input.value = '50';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.deepEqual(await percent(), { value: '50', text: '50%', stored: 50 });

    // Each row button has a switch and can move up or down the list; the row follows.
    await fixture(page, 'normal', {}, { settings: { apiKey: 'key-1', fetch: true } });
    await press(page, '[data-action=settings]');
    const rowOrder = () => page.evaluate(() => [...document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelectorAll('.row > button:not(.save)')]
      .filter(button => button.getClientRects().length).map(button => button.dataset.sort ?? button.dataset.action));
    assert.deepEqual(await rowOrder(), ['duration', 'title', 'views', 'likes', 'uploaded', 'watched', 'above', 'settings']);
    const movers = () => page.evaluate(() => [...document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelectorAll('[data-move]')]
      .filter(button => button.disabled).map(button => `${button.dataset.button}:${button.dataset.move}`));
    assert.deepEqual(await movers(), ['duration:up', 'above:down']); // Only the ends are stuck.
    await page.evaluate(() => {
      const root = document.querySelector('yt-up-next-duration-sort').shadowRoot;
      root.querySelector('[data-move=up][data-button=above]').focus();
    });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // Focus follows the moved button.
    assert.deepEqual(await rowOrder(), ['duration', 'title', 'views', 'likes', 'above', 'uploaded', 'watched', 'settings']);
    assert.equal(await page.evaluate(() => {
      const active = document.querySelector('yt-up-next-duration-sort').shadowRoot.activeElement;
      return `${active?.dataset.button}:${active?.dataset.move}`;
    }), 'above:up');
    await press(page, '[data-move=down][data-button=duration]');
    await press(page, '[data-setting=button-title]');
    await press(page, '[data-setting=button-watched]');
    assert.deepEqual(await rowOrder(), ['duration', 'views', 'likes', 'above', 'uploaded', 'settings']);
    assert.deepEqual(await page.evaluate(() => window.gmStore.buttons), [
      { key: 'title', on: false }, { key: 'duration', on: true }, { key: 'views', on: true }, { key: 'likes', on: true },
      { key: 'above', on: true }, { key: 'uploaded', on: true }, { key: 'watched', on: false }]);
    // Turning the API key off hides the fetched sorts and locks their switches as they were.
    await press(page, '[data-setting=fetch]');
    assert.deepEqual(await rowOrder(), ['duration', 'above', 'settings']);
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelectorAll('[data-setting^=button-]')]
      .filter(input => input.disabled).map(input => `${input.dataset.button}:${input.checked}`)), ['views:true', 'likes:true', 'uploaded:true']);
    // The saved layout applies on the next load.
    await fixture(page, 'normal', {}, { settings: { buttons: [{ key: 'above', on: true }, { key: 'duration', on: false }] } });
    assert.deepEqual(await rowOrder(), ['above', 'title', 'watched', 'settings']);

    // Dedupe is on by default.
    await fixture(page, 'normal', {}, { freshStorage: true });
    await press(page, '[data-action=settings]');
    assert.equal(await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-setting=dedupe]').checked), true);
    await click(page); await idle(page);
    assert.deepEqual((await result(page)).removed, ['tie']);

    await fixture(page, 'normal', {}, { noStorage: true });
    await press(page, '[data-action=settings]');
    assert.equal(await shown(page, '[data-setting=apiKey]'), false);
    assert.match(await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('.settings p').textContent), /storage permission/);
    assert.equal(await shown(page, '.settings p'), true);

    const enabled = { settings: { apiKey: 'key-1', fetch: true } };
    await fixture(page, 'normal', {}, enabled);
    await press(page, '[data-sort=views]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['past', 'current', 'live', 'short', 'tie', 'minute', 'long', 'unknown']);
    assert.equal(actual.requests.length, 1);
    const request = new URL(actual.requests[0]);
    assert.equal(request.origin + request.pathname, 'https://www.googleapis.com/youtube/v3/videos');
    assert.equal(request.searchParams.get('id'), 'long,short,live,unknown,minute'); // Upcoming only, each video once.
    assert.equal(request.searchParams.get('key'), null); // Sent as a header, not in the address.
    assert.deepEqual(await page.evaluate(() => window.fixture.apiKeys), ['key-1']);
    await press(page, '[data-sort=likes]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['past', 'current', 'live', 'long', 'short', 'tie', 'minute', 'unknown']);
    assert.equal(actual.requests.length, 1); // Cached for the session.
    await press(page, '[data-sort=uploaded]'); await idle(page);
    await press(page, '[data-sort=uploaded]'); await idle(page);
    assert.deepEqual((await result(page)).order, ['past', 'current', 'short', 'tie', 'minute', 'long', 'live', 'unknown']);
    // The details are stored for eight hours, so a reload asks again only after that.
    const stats = await page.evaluate(() => window.gmStore.stats);
    assert.deepEqual(Object.keys(stats).sort(), ['live', 'long', 'minute', 'short', 'unknown']);
    assert.deepEqual(stats.minute.likes, null);
    const aged = hours => Object.fromEntries(Object.entries(stats).map(([id, entry]) => [id, { ...entry, fetchedAt: Date.now() - hours * 3600000 }]));
    await fixture(page, 'normal', {}, { settings: { ...enabled.settings, stats: aged(7) } });
    await press(page, '[data-sort=views]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['past', 'current', 'live', 'short', 'tie', 'minute', 'long', 'unknown']);
    assert.equal(actual.requests.length, 0);
    await fixture(page, 'normal', {}, { settings: { ...enabled.settings, stats: aged(9) } });
    await press(page, '[data-sort=views]'); await idle(page);
    assert.equal((await result(page)).requests.length, 1);
    assert.ok(Date.now() - (await page.evaluate(() => window.gmStore.stats.long.fetchedAt)) < 60000);

    await fixture(page, 'normal', {}, { ...enabled, api: 'quota' });
    await press(page, '[data-sort=views]'); await idle(page);
    actual = await result(page);
    assert.match(actual.status, /quota is used up/);
    assert.equal(actual.moves, 0);

    // Dedupe removes the later upcoming repeat ('tie' repeats 'short'), then sorts.
    await fixture(page, 'normal', {}, { settings: { dedupe: true } });
    await click(page); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.removed, ['tie']);
    assert.deepEqual(actual.order, ['past', 'current', 'short', 'minute', 'long', 'live', 'unknown']);
    assert.deepEqual(actual.visible, actual.order);
    assert.match(actual.status, /^Sorted loaded.*Removed 1 repeated video\.$/);
    await click(page); await idle(page); await click(page); await idle(page);
    assert.deepEqual((await result(page)).order, ['past', 'current', 'long', 'short', 'live', 'unknown', 'minute']);

    // Any progress counts as watched, before or after the current video, which stays.
    assert.equal(await shown(page, '[data-action=watched]'), false);
    await fixture(page, 'normal', {}, { watched: { past: 100, current: 50, long: 10 } });
    // The trash icon shows with a symbols font, words without one. CI runners lack
    // Symbols Nerd Font, so the icon case runs only where the font is installed.
    const watchedLabel = () => page.evaluate(() => {
      const button = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-action=watched]');
      const glyph = button.querySelector('.glyph');
      return { text: button.textContent, font: glyph?.style.fontFamily.replaceAll('"', '') ?? null, hidden: glyph?.getAttribute('aria-hidden') ?? null };
    });
    const hasGlyphFont = await page.evaluate(() => {
      const context = document.createElement('canvas').getContext('2d');
      const width = font => { context.font = `20px ${font}`; return context.measureText('\uEA81').width; };
      return width('"Symbols Nerd Font", monospace') !== width('monospace') || width('"Symbols Nerd Font", serif') !== width('serif');
    });
    if (hasGlyphFont) assert.deepEqual(await watchedLabel(), { text: '\uEA81 Watched', font: 'Symbols Nerd Font', hidden: 'true' });
    else {
      console.log(`${browserName}: Symbols Nerd Font not installed; skipped the trash icon check`);
      assert.deepEqual(await watchedLabel(), { text: 'Remove watched', font: null, hidden: null });
    }
    await press(page, '[data-action=watched]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.removed, ['past', 'long']);
    assert.deepEqual(actual.order, ['current', 'short', 'tie', 'live', 'unknown', 'minute']);
    assert.equal(actual.current, 0);
    assert.match(actual.status, /^Removed 2 watched videos/);
    // With a threshold, only videos watched at least that much go.
    await fixture(page, 'normal', {}, { watched: { past: 100, current: 50, long: 10, short: 50 }, settings: { watchedPercent: 50 } });
    await press(page, '[data-action=watched]'); await idle(page);
    assert.deepEqual((await result(page)).removed, ['past', 'short']);
    await fixture(page, 'normal', {}, { watched: { long: 10 }, settings: { watchedPercent: 50 } });
    assert.equal(await shown(page, '[data-action=watched]'), false);
    await fixture(page, 'normal', {}, { watched: { long: 10 }, noGlyphFont: true });
    assert.deepEqual(await watchedLabel(), { text: 'Remove watched', font: null, hidden: null });
    assert.equal(await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-action=above]').textContent), 'Remove above');

    // Above removes every video before the current one, which stays.
    await fixture(page);
    assert.equal(await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-action=above]').textContent), hasGlyphFont ? '\uEA81 Above' : 'Remove above');
    await press(page, '[data-action=above]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.removed, ['past']);
    assert.equal(actual.current, 0);
    assert.match(actual.status, /^Removed 1 video above the current video/);
    assert.equal(await shown(page, '[data-action=above]'), false); // Nothing is left above.

    // All removals go in one edit, without waiting for YouTube to drop the rows.
    await fixture(page, 'normal', {}, { watched: { past: 100, long: 10, short: 5 }, removeMode: 'late' });
    await press(page, '[data-action=watched]');
    actual = await page.evaluate(() => ({ edits: window.fixture.edits, commands: window.fixture.commands, removed: window.fixture.removed.length }));
    assert.deepEqual(actual, { edits: [3], commands: 0, removed: 0 });
    await idle(page);
    assert.match((await result(page)).status, /^Removed 3 watched videos/);
    await page.waitForFunction(() => window.fixture.removed.length === 3);

    // Without YouTube's menu item, the edit goes to its command handler.
    await fixture(page, 'normal', {}, { watched: { past: 100, long: 10 }, removeVia: 'command' });
    await press(page, '[data-action=watched]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.removed, ['past', 'long']);
    assert.deepEqual(await page.evaluate(() => [window.fixture.edits, window.fixture.commands]), [[2], 1]);

    // An ignored removal is not an error.
    await fixture(page, 'normal', {}, { watched: { long: 10 }, removeMode: 'noop' });
    await press(page, '[data-action=watched]'); await idle(page);
    actual = await result(page);
    assert.match(actual.status, /^Removed 1 watched video/);
    assert.equal(actual.order.length, 8);

    // A sort after dedupe waits for a late removal, and sorts a repeat YouTube kept.
    await fixture(page, 'normal', {}, { settings: { dedupe: true }, removeMode: 'late' });
    await click(page); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['past', 'current', 'short', 'minute', 'long', 'live', 'unknown']);
    assert.match(actual.status, /Removed 1 repeated video\.$/);
    await fixture(page, 'normal', {}, { settings: { dedupe: true }, removeMode: 'noop' });
    await click(page); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.order, expected);
    assert.match(actual.status, /^Sorted loaded[^.]*\([0-9]+ native moves\)\.?$/);

    // Saved playlists ask before removing anything.
    await fixture(page, 'normal', { playlistId: 'PL-owned' }, { watched: { long: 10 } });
    await press(page, '[data-action=watched]');
    assert.equal(await shown(page, '[data-action=confirm]'), true);
    assert.match(await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('.confirm span').textContent), /^Remove 1 video from this saved playlist\?/);
    await press(page, '[data-action=cancel]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.removed, []);
    assert.match(actual.status, /^Cancelled/);
    assert.equal(await shown(page, '[data-action=confirm]'), false);
    await press(page, '[data-action=watched]'); await press(page, '[data-action=confirm]'); await idle(page);
    assert.deepEqual((await result(page)).removed, ['long']);
    await fixture(page, 'normal', { playlistId: 'PL-owned' });
    await press(page, '[data-action=above]');
    assert.equal(await shown(page, '[data-action=confirm]'), true);
    await press(page, '[data-action=confirm]'); await idle(page);
    assert.deepEqual((await result(page)).removed, ['past']);

    // Each sort button names its next step, and its arrow shows the step just done.
    const button = selector => page.evaluate(selector => {
      const element = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector(selector);
      return { text: element.textContent, pressed: element.getAttribute('aria-pressed'), label: element.getAttribute('aria-label'), title: element.title, disabled: element.disabled };
    }, selector);
    const pick = (object, ...keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
    await fixture(page);
    assert.deepEqual(await button('[data-sort=duration]'), { text: 'Duration', pressed: 'false', label: 'Sort upcoming videos shortest to longest.',
      title: 'Sort upcoming videos shortest to longest. Current video stays fixed. 6 upcoming loaded videos.', disabled: false });
    assert.equal((await button('[data-sort=title]')).label, 'Sort upcoming videos A to Z.');
    await click(page); await settled(page);
    assert.deepEqual(pick(await button('[data-sort=duration]'), 'text', 'pressed', 'label'),
      { text: 'Duration ↑', pressed: 'true', label: 'Sort upcoming videos longest to shortest.' });
    assert.deepEqual(pick(await button('[data-sort=title]'), 'text', 'pressed'), { text: 'Title', pressed: 'false' });
    await click(page); await settled(page);
    assert.deepEqual(pick(await button('[data-sort=duration]'), 'text', 'label'),
      { text: 'Duration ↓', label: 'Undo duration sorting; restore the order before this cycle.' });
    await click(page); await settled(page);
    assert.deepEqual(pick(await button('[data-sort=duration]'), 'text', 'pressed'), { text: 'Duration', pressed: 'false' });

    // With dedupe on, sorting steps say repeats go first; undo does not.
    await fixture(page, 'normal', {}, { settings: { dedupe: true } });
    assert.match((await button('[data-sort=duration]')).title, / Repeated upcoming videos are removed first\.$/);
    await click(page); await idle(page); await click(page); await idle(page);
    assert.doesNotMatch((await button('[data-sort=duration]')).title, /Repeated/);
    // Undo never removes repeats, even when dedupe is turned on mid-cycle.
    await fixture(page);
    await click(page); await idle(page); await click(page); await idle(page);
    await page.evaluate(() => { window.gmStore.dedupe = true; });
    await click(page); await idle(page);
    actual = await result(page);
    assert.deepEqual([actual.order, actual.removed], [original, []]);

    // Titles sort A to Z ignoring case, untitled videos last.
    await fixture(page, 'normal', {}, { titles: { past: 'Zed', current: 'Middle', long: 'Banana', short: 'apple', tie: 'Cherry', minute: 'Date' } });
    await press(page, '[data-sort=title]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.order, ['past', 'current', 'short', 'long', 'tie', 'minute', 'live', 'unknown']);
    assert.match(actual.status, /^Sorted loaded upcoming videos A to Z \(/);
    await press(page, '[data-sort=title]'); await idle(page);
    assert.deepEqual((await result(page)).order, ['past', 'current', 'minute', 'tie', 'long', 'short', 'live', 'unknown']);
    await fixture(page);
    await press(page, '[data-sort=title]'); await idle(page);
    actual = await result(page);
    assert.deepEqual([actual.status, actual.moves], ['No titles are available for the videos to sort.', 0]);

    // One upcoming video is too few to sort.
    await fixture(page, 'normal', {}, { current: 'unknown' });
    assert.match((await result(page)).detail, / 1 upcoming loaded videos\.$/);
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual([actual.status, actual.moves], ['Load at least two upcoming videos to sort.', 0]);

    // Settings are read again on each click, so a key turned off elsewhere stops a fetched sort.
    await fixture(page, 'normal', {}, { settings: { apiKey: 'key-1', fetch: true } });
    await page.evaluate(() => { window.gmStore.fetch = false; });
    await press(page, '[data-sort=views]'); await idle(page);
    actual = await result(page);
    assert.deepEqual([actual.status, actual.requests, actual.moves], ['Save an API key and turn on Use API key in the sort settings.', [], 0]);

    // While one action runs, its button stops it and the other queue actions wait.
    await fixture(page, 'noop');
    await click(page);
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelectorAll('.row > button')]
      .filter(element => element.getClientRects().length).map(element => `${element.dataset.sort ?? element.dataset.action ?? 'save'}:${element.disabled}`)),
    ['save:true', 'duration:false', 'title:true', 'watched:true', 'above:true', 'settings:false']);
    assert.deepEqual(pick(await button('[data-sort=duration]'), 'text', 'label', 'title'), { text: 'Stop', label: 'Stop sorting', title: 'Stop sorting' });
    await click(page); await settled(page);
    assert.equal((await button('[data-sort=title]')).disabled, false);

    // Leaving the page stops a running sort and forgets the cycle.
    await fixture(page, 'noop');
    await click(page);
    await page.evaluate(() => document.dispatchEvent(new Event('yt-navigate-start')));
    await settled(page);
    assert.match((await result(page)).status, /^Stopped/);
    await fixture(page);
    await click(page); await settled(page);
    await page.evaluate(() => document.dispatchEvent(new Event('yt-navigate-start')));
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, expected); // Ascending again, not the cycle's descending step.
    assert.match(actual.status, /shortest to longest \(0 native moves\)/);

    // A stopped sort offers undo, which restores the order from before the cycle.
    await fixture(page, 'stop'); await click(page); await settled(page);
    assert.deepEqual(pick(await button('[data-sort=duration]'), 'text', 'label'),
      { text: 'Duration ↶', label: 'Undo duration sorting; restore the order before this cycle.' });
    await click(page); await settled(page);
    actual = await result(page);
    assert.deepEqual(actual.order, original);
    assert.match(actual.status, /^Restored/);
    // An interrupted sort keeps undo while the queue holds the same videos, wherever playback went.
    await fixture(page, 'advance'); await click(page); await settled(page);
    assert.equal((await button('[data-sort=duration]')).text, 'Duration ↶');
    await fixture(page, 'concurrent'); await click(page); await settled(page);
    assert.equal((await button('[data-sort=duration]')).text, 'Duration');

    // Reordering the queue some other way ends the cycle.
    await fixture(page); await click(page); await settled(page);
    await page.evaluate(() => {
      const { data } = window.fixture;
      [data.contents[4], data.contents[5]] = [data.contents[5], data.contents[4]];
      window.fixture.render();
      document.querySelector('ytd-playlist-panel-renderer').dispatchEvent(new Event('yt-rendererstamper-finished'));
    });
    assert.equal((await button('[data-sort=duration]')).text, 'Duration');
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, expected);

    // When the queue cannot be sorted, every button says why.
    await fixture(page, 'normal', { shuffleOn: true });
    assert.equal((await result(page)).detail, 'Turn off YouTube shuffle before sorting.');
    for (const selector of ['[data-action=watched]', '[data-action=above]']) {
      assert.deepEqual(pick(await button(selector), 'title', 'label'),
        { title: 'Turn off YouTube shuffle before sorting.', label: 'Turn off YouTube shuffle before sorting.' });
    }

    // A queue panel added later gets its own controls.
    await fixture(page);
    await page.evaluate(() => document.body.append(Object.assign(document.createElement('ytd-playlist-panel-renderer'), { id: 'late' })));
    await page.waitForFunction(() => document.querySelector('#late > yt-up-next-duration-sort'), { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.querySelectorAll('yt-up-next-duration-sort').length), 2);

    // The Save copy follows YouTube's button, and steps aside once its row holds more.
    await fixture(page);
    const restamp = () => page.evaluate(() => document.querySelector('ytd-playlist-panel-renderer').dispatchEvent(new Event('yt-rendererstamper-finished')));
    await page.evaluate(() => {
      const native = document.querySelector('#playlist-actions button');
      native.setAttribute('aria-label', 'Save to playlist');
      native.lastChild.textContent = 'Saved';
    });
    await restamp();
    assert.deepEqual(await saveState(), { hidden: false, text: 'Saved', icon: true, label: 'Save to playlist', row: 'none' });
    await page.evaluate(() => document.querySelector('#playlist-actions').append(Object.assign(document.createElement('button'), { textContent: 'Loop' })));
    await restamp();
    assert.deepEqual(pick(await saveState(), 'hidden', 'row'), { hidden: true, row: '' });
    await page.evaluate(() => document.querySelector('#playlist-actions > button').remove());
    await restamp();
    assert.deepEqual(pick(await saveState(), 'hidden', 'row'), { hidden: false, row: 'none' });

    // Removal buttons count what they would remove, and from where.
    await fixture(page, 'normal', {}, { watched: { long: 10, short: 20 } });
    assert.equal((await button('[data-action=watched]')).label, 'Remove 2 videos that YouTube shows as watched (watch progress) from this queue. The current video stays.');
    assert.equal((await button('[data-action=above]')).label, 'Remove the 1 video above the current video from this queue. The current video stays.');
    await fixture(page, 'normal', { playlistId: 'PL-owned' }, { watched: { long: 60 }, settings: { watchedPercent: 50 } });
    assert.equal((await button('[data-action=watched]')).title, 'Remove 1 video that YouTube shows as watched (at least 50% watched) from this saved playlist. The current video stays.');
    assert.match((await button('[data-action=above]')).label, /from this saved playlist\./);
    await fixture(page, 'normal', {}, { current: 'past', settings: { watchedPercent: 50 } });
    assert.deepEqual(pick(await button('[data-action=watched]'), 'label', 'disabled'), { label: 'No loaded videos show at least 50% watched.', disabled: true });
    assert.deepEqual(pick(await button('[data-action=above]'), 'label', 'disabled'), { label: 'No loaded videos are above the current video.', disabled: true });

    // A setting that cannot be saved says so; the gear reports whether settings are open.
    await fixture(page);
    await press(page, '[data-action=settings]');
    assert.equal(await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-action=settings]').getAttribute('aria-expanded')), 'true');
    await page.evaluate(() => { delete window.GM_setValue; });
    await press(page, '[data-setting=dedupe]');
    assert.deepEqual(await page.evaluate(() => {
      const status = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[role=status]');
      return [status.textContent, status.className];
    }), ['The userscript manager’s storage is unavailable. Reinstall the script to grant it.', 'notice']);
    await press(page, '[data-action=settings]');
    assert.equal(await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-action=settings]').getAttribute('aria-expanded')), 'false');

    // Clicks inside the control stay out of YouTube's panel header.
    await fixture(page);
    await page.evaluate(() => { window.outside = 0; document.addEventListener('click', () => window.outside++); });
    await press(page, '[data-action=settings]'); await press(page, '[data-sort=title]'); await idle(page);
    assert.equal(await page.evaluate(() => window.outside), 0);

    // Dedupe on a saved playlist asks first; Cancel or Stop changes nothing.
    const confirmShown = () => page.waitForFunction(() => !document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('.confirm').hidden, { timeout: 3000 });
    await fixture(page, 'normal', { playlistId: 'PL-owned' }, { settings: { dedupe: true } });
    await click(page); await confirmShown();
    await press(page, '[data-action=cancel]'); await idle(page);
    actual = await result(page);
    assert.deepEqual([actual.removed, actual.order, actual.status], [[], original, 'Cancelled. Nothing was changed.']);
    await fixture(page, 'normal', { playlistId: 'PL-owned' }, { settings: { dedupe: true } });
    await click(page); await confirmShown();
    await click(page); await idle(page);
    actual = await result(page);
    assert.deepEqual([actual.removed, actual.order], [[], original]);
    assert.match(actual.status, /^Stopped/);
    assert.equal(await shown(page, '[data-action=confirm]'), false);
    console.log(`${browserName}: 54 browser fixture scenarios passed`);
  } finally {
    await browser.close();
  }
}
server.close();
