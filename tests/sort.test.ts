import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuration, sameOrder, sortUpcoming } from '../src/sort.ts';

test('parses YouTube time badges, including long videos and directional markers', () => {
  for (const [text, seconds] of [['0:07', 7], ['12:34', 754], ['1:02:03', 3723], ['123:45:59', 445559], [' \u200e2:03\u200f ', 123]] as const) {
    assert.equal(parseDuration(text), seconds);
  }
});

test('unknown, live, invalid and zero durations stay unknown', () => {
  for (const text of ['', 'LIVE', 'UPCOMING', '1.2K watching', '0:00', '3:99', '1:60:00', 'Duration: 1:23', '-1:20', '999999999999999999:00']) {
    assert.equal(parseDuration(text), null, text);
  }
});

test('sorts only upcoming occurrences; ties and unknowns stay stable', () => {
  const items = [
    { id: 'past', duration: 900 }, { id: 'current', duration: 1000 },
    { id: 'same-video-first', duration: 120 }, { id: 'live', duration: null },
    { id: 'short', duration: 5 }, { id: 'same-video-second', duration: 120 },
    { id: 'unknown', duration: null },
  ];
  const original = structuredClone(items);
  assert.deepEqual(sortUpcoming(items, 1).map(item => item.id),
    ['past', 'current', 'short', 'same-video-first', 'same-video-second', 'live', 'unknown']);
  assert.deepEqual(items, original);
});

test('requires a current occurrence and unique occurrence IDs', () => {
  for (const index of [-1, 1, 0.5, NaN]) assert.throws(() => sortUpcoming([{ id: 'a', duration: 1 }], index));
  assert.throws(() => sortUpcoming([{ id: 'a', duration: 1 }, { id: 'a', duration: 2 }], 0));
});

test('an already-sorted tail and a final current item stay unchanged', () => {
  const items = [{ id: 'a', duration: 500 }, { id: 'b', duration: 1 }, { id: 'c', duration: null }];
  assert.deepEqual(sortUpcoming(items, 0), items);
  assert.deepEqual(sortUpcoming(items, 2), items);
  assert.equal(sameOrder(['a'], ['a', 'b']), false);
});
