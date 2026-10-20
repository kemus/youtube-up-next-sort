import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { BUTTON_KEYS, loadSettings, normalizeButtons, readStored, saveSettings, storageAvailable, writeStored, type Settings } from '../src/settings.ts';

const scope = globalThis as Record<string, unknown>;
/** Stand in for the userscript manager's storage; returns the backing object. */
function grant(store: Record<string, unknown> = {}, { get = true, set = true } = {}): Record<string, unknown> {
  if (get) scope.GM_getValue = (name: string, fallback: unknown) => name in store ? store[name] : fallback;
  if (set) scope.GM_setValue = (name: string, value: unknown) => { store[name] = value; };
  return store;
}
afterEach(() => { delete scope.GM_getValue; delete scope.GM_setValue; });

const defaultButtons = BUTTON_KEYS.map(key => ({ key, on: true }));
const settings = (changes: Partial<Settings> = {}): Settings => ({
  apiKey: 'key', fetch: true, dedupe: false, watchedPercent: 30, buttons: defaultButtons,
  includeCurrent: true, includeAbove: false, watchedFirst: true, ...changes,
});

test('buttons default to all on, in row order', () => {
  for (const value of [undefined, null, 'x', [], {}]) {
    assert.deepEqual(normalizeButtons(value), defaultButtons);
  }
});

test('stored button order and switches survive; unknown and repeated entries drop; missing ones follow', () => {
  assert.deepEqual(normalizeButtons([
    { key: 'above', on: false }, { key: 'bogus', on: true }, null, { key: 'title' }, { key: 'above', on: true }, { key: 'views', on: 0 },
  ]), [
    { key: 'above', on: false }, { key: 'title', on: true }, { key: 'views', on: true },
    { key: 'duration', on: true }, { key: 'likes', on: true }, { key: 'uploaded', on: true }, { key: 'watched', on: true },
  ]);
});

test('storage needs both manager functions', () => {
  assert.equal(storageAvailable(), false);
  grant({}, { set: false });
  assert.equal(storageAvailable(), false);
  delete scope.GM_getValue;
  grant({}, { get: false });
  assert.equal(storageAvailable(), false);
  grant();
  assert.equal(storageAvailable(), true);
});

test('without storage, reads give the fallback, writes do nothing, and nothing removes videos unasked', () => {
  assert.equal(readStored('stats', 'fallback'), 'fallback');
  assert.doesNotThrow(() => writeStored('stats', {}));
  assert.deepEqual(loadSettings(), {
    apiKey: '', fetch: false, dedupe: false, watchedPercent: 0, buttons: defaultButtons,
    includeCurrent: false, includeAbove: false, watchedFirst: false,
  });
  assert.throws(() => saveSettings(settings()), /storage is unavailable\. Reinstall the script/);
});

test('with storage, reads and writes go through the manager', () => {
  const store = grant({ stats: { a: 1 } });
  assert.deepEqual(readStored('stats', {}), { a: 1 });
  assert.equal(readStored('other', 'fallback'), 'fallback');
  writeStored('other', 5);
  assert.equal(store.other, 5);
});

test('empty storage turns dedupe on and everything else off', () => {
  grant();
  assert.deepEqual(loadSettings(), {
    apiKey: '', fetch: false, dedupe: true, watchedPercent: 0, buttons: defaultButtons,
    includeCurrent: false, includeAbove: false, watchedFirst: false,
  });
});

test('stored switches count only when exactly true, and a non-text key reads as none', () => {
  grant({ apiKey: 42, fetch: 'true', dedupe: 1, includeCurrent: 'yes', includeAbove: {}, watchedFirst: 1 });
  assert.deepEqual(loadSettings(), {
    apiKey: '', fetch: false, dedupe: false, watchedPercent: 0, buttons: defaultButtons,
    includeCurrent: false, includeAbove: false, watchedFirst: false,
  });
  grant({ apiKey: 'k', fetch: true, dedupe: false, includeCurrent: true, includeAbove: true, watchedFirst: true,
    buttons: [{ key: 'above', on: false }] });
  assert.deepEqual(loadSettings(), {
    apiKey: 'k', fetch: true, dedupe: false, watchedPercent: 0,
    buttons: [{ key: 'above', on: false }, ...defaultButtons.filter(({ key }) => key !== 'above')],
    includeCurrent: true, includeAbove: true, watchedFirst: true,
  });
});

test('the watched threshold rounds to a whole percent within 0 to 100', () => {
  for (const [stored, read] of [[49.6, 50], [49.4, 49], [-3, 0], [250, 100], [Number.NaN, 0], [Infinity, 0], ['50', 0], [null, 0], [75, 75]] as const) {
    grant({ watchedPercent: stored });
    assert.equal(loadSettings().watchedPercent, read, String(stored));
  }
});

test('saving writes every setting, with the threshold clamped and the buttons normalized', () => {
  const store = grant();
  saveSettings(settings({ watchedPercent: 140.2, buttons: [{ key: 'likes', on: false, extra: 1 } as never] }));
  assert.deepEqual(store, {
    apiKey: 'key', fetch: true, dedupe: false, watchedPercent: 100,
    buttons: [{ key: 'likes', on: false }, ...defaultButtons.filter(({ key }) => key !== 'likes')],
    includeCurrent: true, includeAbove: false, watchedFirst: true,
  });
  saveSettings(settings({ watchedPercent: -1 }));
  assert.equal(store.watchedPercent, 0);
});

test('saved settings load back unchanged', () => {
  grant();
  const saved = settings({ includeAbove: true, dedupe: true, buttons: [...defaultButtons].reverse() });
  saveSettings(saved);
  assert.deepEqual(loadSettings(), saved);
});
