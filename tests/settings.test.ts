import assert from 'node:assert/strict';
import test from 'node:test';
import { BUTTON_KEYS, normalizeButtons } from '../src/settings.ts';

test('buttons default to all on, in row order', () => {
  for (const value of [undefined, null, 'x', [], {}]) {
    assert.deepEqual(normalizeButtons(value), BUTTON_KEYS.map(key => ({ key, on: true })));
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
