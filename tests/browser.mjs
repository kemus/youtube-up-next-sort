import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const source = await readFile(new URL('../dist/playlist-sort.user.js', import.meta.url), 'utf8');
const expected = ['past', 'current', 'short', 'tie', 'minute', 'long', 'live', 'unknown'];
const original = ['past', 'current', 'long', 'short', 'tie', 'live', 'unknown', 'minute'];
const descending = ['past', 'current', 'long', 'minute', 'short', 'tie', 'live', 'unknown'];

// options: settings (manager storage contents), noStorage, watched ({ id: percent }),
// api ('quota' for a quota error), removeMode ('noop' for an ignored removal).
async function fixture(page, mode = 'normal', extra = {}, options = {}) {
  await page.goto('about:blank');
  // Each fixture needs a fresh page, without an earlier copy of the userscript.
  assert.equal(await page.evaluate(() => typeof window.fixture), 'undefined');
  await page.evaluate((mode, extra, options) => {
    if (!options.noStorage) {
      const store = window.gmStore = { ...options.settings };
      window.GM_getValue = (name, fallback) => name in store ? store[name] : fallback;
      window.GM_setValue = (name, value) => { store[name] = value; };
    }
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
    save.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), 'Save');
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
    const entries = [
      ['past', '9:00'], ['current', '10:00'], ['long', '4:00'],
      ['short', '0:15'], ['tie', '0:15'], ['live', 'LIVE'], ['unknown', ''], ['minute', '1:00'],
    ].map(([id, length]) => ({ playlistPanelVideoRenderer: {
      playlistSetVideoId: id, videoId: id === 'tie' ? 'short' : id,
      selected: id === 'current', lengthText: { simpleText: length },
      isLive: id === 'live',
      thumbnailOverlays: options.watched?.[id]
        ? [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: options.watched[id] } }] : [],
      menu: { menuRenderer: { items: [
        { menuServiceItemRenderer: { serviceEndpoint: { playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: id, action: 'ACTION_ADD_VIDEO' }] } } } },
        { menuServiceItemRenderer: { serviceEndpoint: { playlistEditEndpoint: { playlistId, actions: [{ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' }] } } } },
      ] } },
    } }));
    const data = { contents: entries, playlistId, currentIndex: 1, totalVideos: entries.length, ...extra };
    const state = window.fixture = { moves: 0, saves: 0, keys: 0, removed: [], requests: [], apiKeys: [], playerNext: 'long', data };
    document.addEventListener('keydown', () => state.keys++);
    // Stands in for YouTube's command handler running a row's own menu action.
    app.resolveCommand = endpoint => {
      const edit = endpoint.playlistEditEndpoint;
      if (options.removeMode === 'noop' || edit.actions[0].action !== 'ACTION_REMOVE_VIDEO') return;
      const token = id => entry => entry.playlistPanelVideoRenderer.playlistSetVideoId === id;
      const current = data.contents[data.currentIndex].playlistPanelVideoRenderer.playlistSetVideoId;
      data.contents.splice(data.contents.findIndex(token(edit.actions[0].setVideoId)), 1);
      data.currentIndex = data.contents.findIndex(token(current));
      state.removed.push(edit.actions[0].setVideoId);
      render();
    };
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
    await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('.save').click());
    assert.equal(await page.evaluate(() => window.fixture.saves), 1);
    await click(page); await settled(page);
    let actual = await result(page);
    assert.deepEqual(actual.order, expected);
    assert.deepEqual(actual.visible, expected);
    assert.equal(actual.next, 'short'); // Independent player state must also update.
    assert.match(actual.status, /^Sorted loaded/);
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, descending);
    await click(page); await settled(page);
    assert.deepEqual((await result(page)).order, original);

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
    await fixture(page, 'normal', { extraAction: true });
    assert.deepEqual(await saveState().then(({ hidden, row }) => ({ hidden, row })), { hidden: true, row: '' });

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
    await press(page, '[data-setting=fetch]');
    await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-setting=apiKey]').focus());
    await page.keyboard.type('key-1');
    assert.deepEqual(await page.evaluate(() => window.gmStore), { apiKey: 'key-1', fetch: true, dedupe: false });
    assert.equal(await page.evaluate(() => window.fixture.keys), 0); // Typing must not reach YouTube's hotkeys.
    for (const key of ['views', 'likes', 'uploaded']) assert.equal(await shown(page, `[data-sort=${key}]`), true);
    assert.deepEqual(await page.evaluate(() => window.shadowModes), ['closed']);
    // The saved key leaves the field once editing ends and never comes back into it.
    const keyField = () => page.evaluate(() => {
      const input = document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-setting=apiKey]');
      return [input.value, input.placeholder];
    });
    await page.evaluate(() => document.querySelector('yt-up-next-duration-sort').shadowRoot.querySelector('[data-setting=apiKey]').blur());
    assert.deepEqual(await keyField(), ['', 'Saved; type to replace']);
    await press(page, '[data-action=settings]'); await press(page, '[data-action=settings]');
    assert.deepEqual(await keyField(), ['', 'Saved; type to replace']);
    await press(page, '[data-action=forget]');
    assert.equal(await page.evaluate(() => window.gmStore.apiKey), '');
    assert.deepEqual(await keyField(), ['', 'Paste a key']);
    assert.equal(await shown(page, '[data-sort=views]'), false);
    assert.equal(await shown(page, '[data-action=forget]'), false);
    assert.equal(await shown(page, '.settings p'), false); // No explanatory text while settings work.

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
    await press(page, '[data-action=watched]'); await idle(page);
    actual = await result(page);
    assert.deepEqual(actual.removed, ['past', 'long']);
    assert.deepEqual(actual.order, ['current', 'short', 'tie', 'live', 'unknown', 'minute']);
    assert.equal(actual.current, 0);
    assert.match(actual.status, /^Removed 2 watched videos/);

    await fixture(page, 'normal', {}, { watched: { long: 10 }, removeMode: 'noop' });
    await press(page, '[data-action=watched]'); await idle(page);
    actual = await result(page);
    assert.match(actual.status, /did not confirm the removal/);
    assert.equal(actual.order.length, 8);

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
    console.log(`${browserName}: 21 browser fixture scenarios passed`);
  } finally {
    await browser.close();
  }
}
