// Tests src/youtube.ts on its own, in a real DOM: each scenario builds a small
// fixture queue on a blank page, calls one exported function and checks the result.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const bundle = (await build({
  entryPoints: [new URL('../src/youtube.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'iife', globalName: 'youtube', target: 'es2022',
})).outputFiles[0].text;
const library = `window.yt = (() => { ${bundle}; return youtube; })();`;

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>youtube.ts</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const blank = `http://127.0.0.1:${server.address().port}/`;

/** Page-side fixture: a queue panel shaped like YouTube's, with a drop handler whose behaviour `state.mode` picks. */
function helpers() {
  window.make = (options = {}) => {
    const ids = options.ids ?? ['a', 'b', 'c', 'd'];
    const current = options.current ?? 1;
    const playlistId = options.playlistId ?? 'TLPQ-test';
    const panel = document.createElement('ytd-playlist-panel-renderer');
    const items = document.createElement('div');
    items.id = 'items';
    panel.append(items);
    document.body.replaceChildren(panel);
    const removal = id => ({ menuServiceItemRenderer: {
      text: { simpleText: 'Remove from queue' },
      serviceEndpoint: { clickTrackingParams: `track-${id}`, playlistEditEndpoint: {
        playlistId, actions: [{ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' }],
        ...options.clientActions ? { clientActions: [{ playlistRemoveVideosAction: { setVideoIds: [id] } }] } : {},
      } },
    } });
    const data = {
      contents: ids.map((id, index) => ({ playlistPanelVideoRenderer: {
        playlistSetVideoId: id, videoId: `v-${id}`, selected: index === current,
        lengthText: { simpleText: `0:${10 + index}` },
        menu: { menuRenderer: { items: [removal(id)] } },
      } })),
      playlistId, currentIndex: current, totalVideos: ids.length,
    };
    const indexOf = id => data.contents.findIndex(entry => entry.playlistPanelVideoRenderer.playlistSetVideoId === id);
    const playingId = () => data.contents[data.currentIndex]?.playlistPanelVideoRenderer.playlistSetVideoId;
    const state = window.state = {
      panel, items, data, mode: 'normal', drops: 0, plays: [], onPlay: null,
      order: () => data.contents.map(entry => entry.playlistPanelVideoRenderer.playlistSetVideoId),
      visible: () => [...items.children].map(row => row.data?.playlistSetVideoId),
      entry: id => data.contents[indexOf(id)].playlistPanelVideoRenderer,
      select(id) {
        for (const entry of data.contents) entry.playlistPanelVideoRenderer.selected = entry.playlistPanelVideoRenderer.playlistSetVideoId === id;
        data.currentIndex = indexOf(id);
      },
      /** Move one entry in the data only, keeping currentIndex on the playing video. */
      move(id, destination) {
        const playing = playingId();
        data.contents.splice(destination, 0, data.contents.splice(indexOf(id), 1)[0]);
        data.currentIndex = indexOf(playing);
      },
      swapLast() {
        const playing = playingId();
        const last = data.contents.length - 1;
        [data.contents[last - 1], data.contents[last]] = [data.contents[last], data.contents[last - 1]];
        data.currentIndex = indexOf(playing);
        state.render();
      },
      render() {
        items.replaceChildren(...data.contents.map(entry => {
          const row = document.createElement('ytd-playlist-panel-video-renderer');
          row.data = entry.playlistPanelVideoRenderer;
          const link = document.createElement('a');
          link.id = 'wc-endpoint';
          link.href = '#';
          link.addEventListener('click', event => {
            event.preventDefault();
            state.plays.push(row.data.playlistSetVideoId);
            state.onPlay?.(row.data.playlistSetVideoId);
          });
          row.append(link);
          return row;
        }));
      },
    };
    panel.polymerController = {
      data, canReorder: true, shuffleOn: false,
      ytReorderableController: { handleDrop({ currDragItem }) {
        state.drops++;
        const id = currDragItem.data.playlistSetVideoId;
        const destination = [...currDragItem.parentNode.childNodes].indexOf(currDragItem);
        switch (state.mode) {
          case 'throw': throw new Error('boom');
          case 'data-then-throw': state.move(id, destination); throw new Error('late boom');
          case 'noop': return;
          case 'delayed': setTimeout(() => { state.move(id, destination); state.render(); }, 60); return;
          case 'unexpected': {
            const playing = playingId();
            data.contents.reverse();
            data.currentIndex = indexOf(playing);
            state.render();
            return;
          }
          case 'session': data.playlistId = 'elsewhere'; break;
        }
        state.move(id, destination);
        state.render();
      } },
    };
    state.render();
    return state;
  };
  window.failure = async run => {
    try { await run(); return null; } catch (error) { return error.name === 'AbortError' ? 'AbortError' : error.message; }
  };
  /** Plain fields of a snapshot, which holds DOM nodes the test runner cannot receive. */
  window.plain = snapshot => ({
    items: snapshot.items, currentIndex: snapshot.currentIndex, playlistId: snapshot.playlistId, total: snapshot.total,
    rows: snapshot.rows.length, container: snapshot.container === state.items, controller: snapshot.controller === state.panel.polymerController,
  });
}

const scenarios = [];
const scenario = (name, run) => scenarios.push([name, run]);
const unreadable = 'Cannot read YouTube’s queue. Enable page-context injection in your userscript manager and reload.';
const noReorder = 'Native reordering is unavailable here. Open a queue or an editable playlist with drag handles.';
const rendering = 'Wait for the loaded queue items to finish rendering, then try again.';
const disagree = 'Queue data and visible rows disagree. Wait for YouTube to finish updating.';
const lost = 'Cannot locate the current video in the loaded queue. Try a short, fully loaded queue.';

// readSnapshot ----------------------------------------------------------------

scenario('a snapshot lists every loaded occurrence with its details', async page => {
  const snapshot = await page.evaluate(() => {
    const state = make();
    state.entry('a').title = { runs: [{ text: '  First ' }, { text: 'part' }, {}] };
    state.entry('b').title = { simpleText: 'Second' };
    state.entry('c').thumbnailOverlays = [
      { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 0 } },
      { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 35 } },
      { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 90 } },
    ];
    state.entry('d').videoId = 42;
    return plain(yt.readSnapshot(state.panel));
  });
  assert.deepEqual(snapshot, {
    items: [
      { id: 'a', duration: 10, title: 'First part', videoId: 'v-a', watched: 0 },
      { id: 'b', duration: 11, title: 'Second', videoId: 'v-b', watched: 0 },
      { id: 'c', duration: 12, title: null, videoId: 'v-c', watched: 35 },
      { id: 'd', duration: 13, title: null, videoId: '', watched: 0 },
    ],
    currentIndex: 1, playlistId: 'TLPQ-test', total: 4, rows: 4, container: true, controller: true,
  });
  assert.equal(await page.evaluate(() => { state.data.totalVideos = '4'; return yt.readSnapshot(state.panel).total; }), null);
});

scenario('the queue controller is found on polymerController, inst, or the panel itself', async page => {
  assert.deepEqual(await page.evaluate(() => {
    const read = () => failure(() => yt.readSnapshot(state.panel));
    const state = make();
    const controller = state.panel.polymerController;
    const results = [];
    delete state.panel.polymerController;
    results.push(read());
    state.panel.inst = controller;
    results.push(read());
    delete state.panel.inst;
    Object.assign(state.panel, controller);
    results.push(read());
    // polymerController wins over inst.
    state.panel.polymerController = controller;
    state.panel.inst = {};
    results.push(read());
    return Promise.all(results);
  }), [unreadable, null, null, null]);
});

scenario('unreadable or unsupported queues give a plain reason', async page => {
  const cases = [
    ['closed', state => state.panel.remove(), 'The queue panel was closed.'],
    ['no data', state => { state.panel.polymerController.data = undefined; }, unreadable],
    ['contents not a list', state => { state.data.contents = {}; }, unreadable],
    ['cannot reorder', state => { state.panel.polymerController.canReorder = 'yes'; }, noReorder],
    ['no drop handler', state => { state.panel.polymerController.ytReorderableController = {}; }, noReorder],
    ['no reorder controller', state => { delete state.panel.polymerController.ytReorderableController; }, noReorder],
    ['shuffle', state => { state.panel.polymerController.shuffleOn = true; }, 'Turn off YouTube shuffle before sorting.'],
    ['mix', state => { state.data.isInfinite = true; }, 'Radio/mix playlists are not supported by this prototype.'],
    ['no playlist id', state => { state.data.playlistId = ''; }, 'YouTube has not provided a queue identifier yet.'],
    ['playlist id not text', state => { state.data.playlistId = 7; }, 'YouTube has not provided a queue identifier yet.'],
    ['collapsed', state => state.items.remove(), 'Expand the queue panel first.'],
    ['no rows', state => state.items.replaceChildren(), rendering],
    ['too few rows', state => state.items.lastChild.remove(), rendering],
    ['too many rows', state => { state.data.contents.pop(); }, rendering],
    ['a gap', state => state.items.prepend(document.createElement('div')), 'Unsupported queue layout: video rows are not contiguous.'],
    ['a text node first', state => state.items.prepend(' '), 'Unsupported queue layout: video rows are not contiguous.'],
    ['row for another entry', state => { state.items.children[2].data = state.entry('d'); }, disagree],
    ['row without data', state => { delete state.items.children[0].data; }, disagree],
    ['entry without id', state => { state.entry('c').playlistSetVideoId = ''; }, disagree],
    ['numeric id', state => { state.entry('c').playlistSetVideoId = 3; state.items.children[2].data = { playlistSetVideoId: 3 }; }, disagree],
    ['repeated id', state => { state.entry('d').playlistSetVideoId = 'c'; }, 'Queue occurrence identifiers are missing or duplicated.'],
    ['no current index', state => { delete state.data.currentIndex; }, lost],
    ['current index past the end', state => { state.data.currentIndex = 9; }, lost],
    ['two selected', state => { state.entry('c').selected = true; }, lost],
    ['none selected', state => { state.entry('b').selected = false; }, lost],
    ['selected elsewhere', state => { state.entry('b').selected = false; state.entry('c').selected = true; }, lost],
    ['address names another video', state => { state.entry('b').selected = false; history.replaceState(null, '', '?v=v-c'); }, lost],
  ];
  for (const [name, change, message] of cases) {
    const actual = await page.evaluate(async change => {
      history.replaceState(null, '', '/');
      const state = make();
      new Function('state', `(${change})(state)`)(state);
      return failure(() => yt.readSnapshot(state.panel));
    }, change.toString());
    assert.equal(actual, message, name);
  }
});

scenario('the current video comes from the selected flag, or from the address bar when flags are stale', async page => {
  assert.deepEqual(await page.evaluate(() => {
    const results = [];
    history.replaceState(null, '', '/');
    let state = make({ current: 2 });
    results.push(yt.readSnapshot(state.panel).currentIndex);
    // Played in place: currentIndex and the address move, the flag stays behind.
    state.data.currentIndex = 3;
    history.replaceState(null, '', '?v=v-d');
    results.push(yt.readSnapshot(state.panel).currentIndex);
    // The address alone is enough even with two flags.
    state.entry('a').selected = true;
    results.push(yt.readSnapshot(state.panel).currentIndex);
    history.replaceState(null, '', '/');
    state = make({ current: 0 });
    results.push(yt.readSnapshot(state.panel).currentIndex);
    // A current index that is not a number is not trusted, even beside a matching flag.
    state = make({ current: 2 });
    state.data.currentIndex = '2';
    results.push(failure(() => yt.readSnapshot(state.panel)));
    return Promise.all(results);
  }), [2, 3, 3, 0, lost]);
});

scenario('continuation entries and trailing nodes are left out', async page => {
  assert.deepEqual(await page.evaluate(() => {
    const state = make();
    state.data.contents.push({ continuationItemRenderer: {} }, null, 'x');
    state.items.append(document.createElement('ytd-continuation-item-renderer'), ' ');
    return yt.readSnapshot(state.panel).items.map(item => item.id);
  }), ['a', 'b', 'c', 'd']);
});

scenario('durations come from time badges; live and upcoming videos have none', async page => {
  const cases = [
    ['simple text', entry => { entry.lengthText = { simpleText: '1:02:03' }; }, 3723],
    ['runs', entry => { entry.lengthText = { runs: [{ text: '4:' }, { text: '05' }] }; }, 245],
    ['overlay text', entry => {
      delete entry.lengthText;
      entry.thumbnailOverlays = [{ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 5 } }, { thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '2:00' }, style: 'DEFAULT' } }];
    }, 120],
    ['length text before overlay', entry => { entry.thumbnailOverlays = [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '2:00' } } }]; }, 10],
    ['unreadable length text falls back to overlay', entry => {
      entry.lengthText = { simpleText: 'soon' };
      entry.thumbnailOverlays = [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '2:00' } } }];
    }, 120],
    ['badge element', (entry, row) => {
      delete entry.lengthText;
      row.append(Object.assign(document.createElement('ytd-thumbnail-overlay-time-status-renderer'), { textContent: ' 3:00 ' }));
    }, 180],
    ['badge shape', (entry, row) => {
      delete entry.lengthText;
      row.append(Object.assign(document.createElement('div'), { className: 'badge-shape-wiz__text', textContent: '0:30' }));
    }, 30],
    ['title with a time', (entry, row) => {
      delete entry.lengthText;
      row.append(Object.assign(document.createElement('span'), { id: 'video-title', textContent: '10:00' }));
    }, null],
    ['no badge', entry => { delete entry.lengthText; }, null],
    ['live', entry => { entry.isLive = true; }, null],
    ['live now', entry => { entry.isLiveNow = true; }, null],
    ['not quite live', entry => { entry.isLive = 'true'; }, 10],
    ['upcoming event', entry => { entry.upcomingEventData = { startTime: '1' }; }, null],
    ['live badge style', entry => { entry.thumbnailOverlays = [{ thumbnailOverlayTimeStatusRenderer: { style: 'LIVE' } }]; }, null],
    ['upcoming badge style', entry => { entry.thumbnailOverlays = [{ thumbnailOverlayTimeStatusRenderer: { style: 'UPCOMING' } }]; }, null],
    ['overlays not a list', entry => { entry.thumbnailOverlays = { style: 'LIVE' }; }, 10],
  ];
  for (const [name, change, seconds] of cases) {
    const actual = await page.evaluate(change => {
      const state = make();
      new Function('entry', 'row', `(${change})(entry, row)`)(state.entry('a'), state.items.children[0]);
      return yt.readSnapshot(state.panel).items[0].duration;
    }, change.toString());
    assert.equal(actual, seconds, name);
  }
});

scenario('titles fall back to the row title, then to none', async page => {
  assert.deepEqual(await page.evaluate(() => {
    const state = make();
    state.entry('a').title = { simpleText: '   ' };
    state.items.children[0].append(Object.assign(document.createElement('span'), { id: 'video-title', textContent: '  Row title ' }));
    state.entry('b').title = { runs: 'not a list' };
    state.items.children[1].append(Object.assign(document.createElement('span'), { id: 'video-title', textContent: '   ' }));
    state.entry('c').title = { simpleText: 'Data title' };
    state.items.children[2].append(Object.assign(document.createElement('span'), { id: 'video-title', textContent: 'Row title' }));
    return yt.readSnapshot(state.panel).items.map(item => item.title);
  }), ['Row title', null, 'Data title', null]);
});

// reorderPanel ----------------------------------------------------------------

/** Run reorderPanel on a fresh five-video queue playing 'a'; returns what happened. */
const reorder = (page, { target = ['a', 'c', 'b', 'e', 'd'], mode = 'normal', onReport = '', aborted = false, abortAfter = null } = {}) =>
  page.evaluate(async (target, mode, onReport, aborted, abortAfter) => {
    const state = make({ ids: ['a', 'b', 'c', 'd', 'e'], current: 0 });
    state.mode = mode;
    const abort = new AbortController();
    if (aborted) abort.abort();
    if (abortAfter !== null) setTimeout(() => abort.abort(), abortAfter);
    const reports = [];
    const hook = new Function('state', 'abort', 'reports', onReport);
    const started = Date.now();
    let moves;
    const error = await failure(async () => {
      moves = await yt.reorderPanel(state.panel, yt.readSnapshot(state.panel), target, abort.signal, message => {
        reports.push(message);
        hook(state, abort, reports);
      });
    });
    return { error, moves, reports, drops: state.drops, order: state.order(), visible: state.visible(), elapsed: Date.now() - started };
  }, target, mode, onReport, aborted, abortAfter);

scenario('reordering moves only what it must, reporting each move', async page => {
  const actual = await reorder(page);
  assert.equal(actual.error, null);
  assert.equal(actual.moves, 2);
  assert.equal(actual.drops, 2);
  assert.deepEqual(actual.reports, ['Sorting: 1/2 moves…', 'Sorting: 2/2 moves…']);
  assert.deepEqual(actual.order, ['a', 'c', 'b', 'e', 'd']);
  assert.deepEqual(actual.visible, actual.order);
  // Moving the top entry drops it before the first row.
  const top = await reorder(page, { target: ['b', 'a', 'c', 'd', 'e'] });
  assert.deepEqual([top.error, top.moves, top.order], [null, 1, ['b', 'a', 'c', 'd', 'e']]);
});

scenario('an order already in place needs no moves', async page => {
  const actual = await reorder(page, { target: ['a', 'b', 'c', 'd', 'e'] });
  assert.deepEqual([actual.error, actual.moves, actual.drops, actual.reports], [null, 0, 0, []]);
});

scenario('a target that is not a reordering of the queue is refused', async page => {
  for (const target of [['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'd'], ['a', 'b', 'c', 'd', 'z']]) {
    const actual = await reorder(page, { target });
    assert.equal(actual.error, 'The requested order no longer matches this queue.', target.join());
    assert.equal(actual.drops, 0);
  }
});

scenario('a stop before or between moves is honoured', async page => {
  let actual = await reorder(page, { aborted: true });
  assert.deepEqual([actual.error, actual.drops], ['AbortError', 0]);
  actual = await reorder(page, { onReport: 'abort.abort();' });
  assert.deepEqual([actual.error, actual.drops], ['AbortError', 1]);
  actual = await reorder(page, { target: ['a', 'c', 'b', 'd', 'e'], onReport: 'abort.abort();' });
  assert.deepEqual([actual.error, actual.drops], ['AbortError', 1]); // Even after the last move.
  // A stop while waiting for YouTube to confirm a move puts the row back.
  actual = await reorder(page, { mode: 'noop', abortAfter: 100 });
  assert.deepEqual([actual.error, actual.drops, actual.order], ['AbortError', 1, ['a', 'b', 'c', 'd', 'e']]);
  assert.deepEqual(actual.visible, actual.order);
});

scenario('a failing drop handler puts the row back when YouTube kept its order', async page => {
  let actual = await reorder(page, { mode: 'throw' });
  assert.equal(actual.error, 'YouTube’s native move failed: boom');
  assert.deepEqual(actual.order, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(actual.visible, actual.order);
  // When YouTube's data did move, the row stays where the data says.
  actual = await reorder(page, { mode: 'data-then-throw' });
  assert.equal(actual.error, 'YouTube’s native move failed: late boom');
  assert.notDeepEqual(actual.order, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(actual.visible, actual.order);
});

scenario('an unconfirmed move stops after a few seconds and puts the row back', async page => {
  const actual = await reorder(page, { mode: 'noop' });
  assert.equal(actual.error, 'YouTube did not confirm the move in its queue data. Sorting stopped.');
  assert.ok(actual.elapsed >= 3400 && actual.elapsed < 6000, String(actual.elapsed));
  assert.deepEqual(actual.order, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(actual.visible, actual.order);
});

scenario('a move YouTube applies a little later still counts', async page => {
  const actual = await reorder(page, { mode: 'delayed' });
  assert.deepEqual([actual.error, actual.moves, actual.order], [null, 2, ['a', 'c', 'b', 'e', 'd']]);
  assert.deepEqual(actual.visible, actual.order);
});

scenario('other queue changes stop the sort with what changed', async page => {
  let actual = await reorder(page, { mode: 'unexpected' });
  assert.deepEqual([actual.error, actual.drops], ['Unexpected queue change after a native move. Sorting stopped.', 1]);
  actual = await reorder(page, { mode: 'session' });
  assert.deepEqual([actual.error, actual.drops], ['Playback or the queue changed. Sorting stopped; completed moves remain applied.', 1]);
  actual = await reorder(page, { onReport: 'if (reports.length === 1) state.swapLast();' });
  assert.deepEqual([actual.error, actual.drops], ['The queue changed while sorting. Completed moves remain applied; try again.', 1]);
  actual = await reorder(page, { onReport: 'if (reports.length === 1) { state.select("b"); state.render(); }' });
  assert.deepEqual([actual.error, actual.drops], ['Playback or the queue changed. Sorting stopped; completed moves remain applied.', 1]);
  actual = await reorder(page, { target: ['a', 'c', 'b', 'd', 'e'], onReport: 'state.swapLast();' });
  assert.deepEqual([actual.error, actual.drops], ['YouTube changed the order before verification finished. Try again.', 1]);
  actual = await reorder(page, { target: ['a', 'c', 'b', 'd', 'e'], onReport: 'state.data.playlistId = "elsewhere";' });
  assert.equal(actual.error, 'Playback or the queue changed. Sorting stopped; completed moves remain applied.');
});

// playItem --------------------------------------------------------------------

/** Click a row's link with playItem; `onPlay` is page source run with the played id. */
const play = (page, { id = 'c', onPlay = '', setup = '', aborted = false } = {}) => page.evaluate(async (id, onPlay, setup, aborted) => {
  history.replaceState(null, '', '/');
  const state = make();
  new Function('state', setup)(state);
  state.onPlay = new Function('id', 'state', onPlay).bind(null, id, state);
  const abort = new AbortController();
  if (aborted) abort.abort();
  const started = Date.now();
  let snapshot;
  const error = await failure(async () => { snapshot = plain(await yt.playItem(state.panel, yt.readSnapshot(state.panel), id, abort.signal)); });
  return { error, snapshot, plays: state.plays, order: state.order(), elapsed: Date.now() - started };
}, id, onPlay, setup, aborted);
const starts = 'setTimeout(() => { state.select(id); history.replaceState(null, "", "?v=v-" + id); state.render(); }, 80);';

scenario('playing a video clicks its row link and waits until it is current', async page => {
  const actual = await play(page, { onPlay: starts });
  assert.equal(actual.error, null);
  assert.deepEqual(actual.plays, ['c']);
  assert.equal(actual.snapshot.currentIndex, 2);
  assert.equal(actual.snapshot.items[2].id, 'c');
  assert.deepEqual(actual.order, ['a', 'b', 'c', 'd']);
  assert.ok(actual.elapsed >= 70, String(actual.elapsed));
});

scenario('a row without a link, a stop, an ignored click or another queue each end the wait', async page => {
  let actual = await play(page, { setup: 'state.items.children[2].querySelector("a").remove();' });
  assert.deepEqual([actual.error, actual.plays], ['YouTube offers no link to play the first sorted video. The new order stays.', []]);
  actual = await play(page, { aborted: true });
  assert.deepEqual([actual.error, actual.plays], ['AbortError', ['c']]);
  actual = await play(page);
  assert.equal(actual.error, 'YouTube did not start the first sorted video. The new order stays.');
  assert.ok(actual.elapsed >= 4900 && actual.elapsed < 7000, String(actual.elapsed));
  actual = await play(page, { onPlay: 'state.data.playlistId = "elsewhere";' });
  assert.equal(actual.error, 'The queue changed before the first sorted video started.');
});

// removeItems -----------------------------------------------------------------

/** Run removeItems; `setup` is page source that may define YouTube's menu item or command handler. */
const remove = (page, ids, { setup = '', clientActions = false } = {}) => page.evaluate(async (ids, setup, clientActions) => {
  const state = make({ clientActions });
  window.seen = [];
  new Function('state', setup)(state);
  const error = await failure(() => yt.removeItems(yt.readSnapshot(state.panel), ids));
  return { error, seen: window.seen, leftovers: document.querySelectorAll('ytd-menu-service-item-renderer').length };
}, ids, setup, clientActions);
const recordMenuItem = `customElements.define('ytd-menu-service-item-renderer', class extends HTMLElement {
  connectedCallback() {
    this.addEventListener('click', () => window.seen.push({
      hidden: this.hidden, row: this.parentElement.data.playlistSetVideoId, data: structuredClone(this.data),
    }));
  }
});`;
const app = handler => `const app = document.createElement('ytd-app'); document.body.append(app); ${handler}`;
const removeAction = id => ({ setVideoId: id, action: 'ACTION_REMOVE_VIDEO' });

scenario('removals that do not match the queue are refused', async page => {
  for (const ids of [[], ['b'], ['c', 'c'], ['z'], ['c', 'b']]) {
    const actual = await remove(page, ids, { setup: app('app.resolveCommand = command => window.seen.push(command);') });
    assert.deepEqual(actual, { error: 'The requested removals no longer match this queue.', seen: [], leftovers: 0 }, ids.join());
  }
});

scenario('only a row’s own single remove action is used', async page => {
  const cases = [
    ['another playlist', 'edit.playlistId = "WL";'],
    ['two actions', 'edit.actions.push({ setVideoId: "d", action: "ACTION_REMOVE_VIDEO" });'],
    ['an add action', 'edit.actions[0].action = "ACTION_ADD_VIDEO";'],
    ['another occurrence', 'edit.actions[0].setVideoId = "d";'],
    ['no actions', 'delete edit.actions;'],
    ['no menu', 'delete state.entry("c").menu;'],
  ];
  for (const [name, change] of cases) {
    const actual = await remove(page, ['d', 'c'], { setup: `${app('app.resolveCommand = command => window.seen.push(command);')}
      const edit = state.entry('c').menu.menuRenderer.items[0].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint;
      ${change}` });
    assert.deepEqual(actual, { error: 'YouTube offers no remove action for a video here. Nothing was removed.', seen: [], leftovers: 0 }, name);
  }
  // Other menu items before the remove item are skipped.
  const actual = await remove(page, ['c'], { setup: `${app('app.resolveCommand = command => window.seen.push(command);')}
    state.entry('c').menu.menuRenderer.items.unshift({ menuServiceItemRenderer: { serviceEndpoint: { playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: 'v-c', action: 'ACTION_ADD_VIDEO' }] } } } }, null);` });
  assert.equal(actual.error, null);
  assert.deepEqual(actual.seen[0].playlistEditEndpoint.actions, [removeAction('c')]);
});

scenario('without YouTube’s menu item, one combined edit goes to the command handler', async page => {
  let actual = await remove(page, ['d', 'a'], { setup: app('app.resolveCommand = command => window.seen.push(command);') });
  assert.equal(actual.error, null);
  assert.deepEqual(actual.seen, [{ clickTrackingParams: 'track-d', playlistEditEndpoint: { playlistId: 'TLPQ-test', actions: [removeAction('d'), removeAction('a')] } }]);
  // The handler may sit on the app's controller instead.
  actual = await remove(page, ['c'], { clientActions: true, setup: app('app.polymerController = { resolveCommand: command => window.seen.push(command) };') });
  assert.equal(actual.error, null);
  assert.deepEqual(actual.seen[0].playlistEditEndpoint.clientActions, [{ playlistRemoveVideosAction: { setVideoIds: ['c'] } }]);
  actual = await remove(page, ['c'], { setup: app('app.resolveCommand = () => { throw new Error("rejected"); };') });
  assert.equal(actual.error, 'YouTube’s native removal failed: rejected');
  for (const setup of ['', app(''), app('app.resolveCommand = "no"; app.polymerController = {};')]) {
    actual = await remove(page, ['c'], { setup });
    assert.equal(actual.error, 'YouTube’s command handler is unavailable here.', setup || 'no app');
  }
});

scenario('with YouTube’s menu item, a hidden one is clicked in the first removed row, then dropped', async page => {
  const actual = await remove(page, ['d', 'a', 'c'], { clientActions: true, setup: `${recordMenuItem}
    ${app('app.resolveCommand = () => window.seen.push("command");')}` });
  assert.equal(actual.error, null);
  assert.equal(actual.leftovers, 0);
  assert.deepEqual(actual.seen, [{ hidden: true, row: 'd', data: {
    text: { simpleText: 'Remove from queue' },
    serviceEndpoint: { clickTrackingParams: 'track-d', playlistEditEndpoint: {
      playlistId: 'TLPQ-test', actions: [removeAction('d'), removeAction('a'), removeAction('c')],
      clientActions: [{ playlistRemoveVideosAction: { setVideoIds: ['d', 'a', 'c'] } }],
    } },
  } }]);
  // The menu item works without any command handler.
  const alone = await remove(page, ['a'], { setup: '' });
  assert.deepEqual([alone.error, alone.seen.length, alone.seen[0].data.serviceEndpoint.playlistEditEndpoint.clientActions], [null, 1, undefined]);
});

// afterRemoval ----------------------------------------------------------------

const after = (page, { gone = ['c'], change = '', aborted = false } = {}) => page.evaluate(async (gone, change, aborted) => {
  const state = make();
  new Function('state', change)(state);
  const abort = new AbortController();
  if (aborted) abort.abort();
  const started = Date.now();
  let ids;
  const error = await failure(async () => { ids = (await yt.afterRemoval(state.panel, gone, abort.signal)).items.map(item => item.id); });
  return { error, ids, elapsed: Date.now() - started };
}, gone, change, aborted);
const drop = 'state.data.contents.splice(2, 1);';

scenario('after removals, the queue is read once the rows are gone, or as it stands after a short wait', async page => {
  let actual = await after(page, { gone: ['z'] });
  assert.deepEqual([actual.error, actual.ids], [null, ['a', 'b', 'c', 'd']]);
  assert.ok(actual.elapsed < 300, String(actual.elapsed));
  actual = await after(page, { change: `setTimeout(() => { ${drop} state.render(); }, 150);` });
  assert.deepEqual([actual.error, actual.ids], [null, ['a', 'b', 'd']]);
  assert.ok(actual.elapsed >= 140 && actual.elapsed < 1200, String(actual.elapsed));
  // Rows that lag behind the data are waited out.
  actual = await after(page, { change: `${drop} setTimeout(() => state.render(), 150);` });
  assert.deepEqual([actual.error, actual.ids], [null, ['a', 'b', 'd']]);
  assert.ok(actual.elapsed >= 140 && actual.elapsed < 1200, String(actual.elapsed));
  actual = await after(page);
  assert.deepEqual([actual.error, actual.ids], [null, ['a', 'b', 'c', 'd']]);
  assert.ok(actual.elapsed >= 1450 && actual.elapsed < 3000, String(actual.elapsed));
});

scenario('after removals, a queue that stays unreadable or a stop ends the wait', async page => {
  let actual = await after(page, { change: 'state.panel.polymerController.data = undefined;' });
  assert.equal(actual.error, unreadable);
  assert.ok(actual.elapsed >= 1450 && actual.elapsed < 3000, String(actual.elapsed));
  actual = await after(page, { aborted: true });
  assert.equal(actual.error, 'AbortError');
});

for (const [browserName, executablePath] of [
  ['firefox', process.env.FIREFOX_BIN || '/usr/bin/firefox'],
  ['chrome', process.env.CHROMIUM_BIN || '/usr/bin/chromium'],
]) {
  const browser = await puppeteer.launch({ browser: browserName, executablePath, headless: true });
  try {
    const page = await browser.newPage();
    for (const [name, run] of scenarios) {
      // A fresh page per scenario: custom elements cannot be undefined once defined.
      await page.goto(blank);
      await page.evaluate(library);
      await page.evaluate(helpers);
      try {
        await run(page);
      } catch (error) {
        error.message = `${browserName}: ${name}: ${error.message}`;
        throw error;
      }
    }
    console.log(`${browserName}: ${scenarios.length} youtube.ts scenarios passed`);
  } finally {
    await browser.close();
  }
}
server.close();
