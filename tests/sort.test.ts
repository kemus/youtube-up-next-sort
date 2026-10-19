import assert from 'node:assert/strict';
import test from 'node:test';
import { aboveIds, arrange, duplicateIds, parseDuration, partition, planMoves, sameOrder, sortUpcoming, watchedIds, type Move } from '../src/sort.ts';

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

test('fetched keys sort numerically with missing values last in both directions', () => {
  const items = [
    { id: 'current', duration: 1, views: 5 }, { id: 'hidden', duration: 1, views: null },
    { id: 'many', duration: 1, views: 1000 }, { id: 'unfetched', duration: 1 }, { id: 'few', duration: 1, views: 20 },
  ];
  assert.deepEqual(sortUpcoming(items, 0, 'views', 'asc').map(item => item.id), ['current', 'few', 'many', 'hidden', 'unfetched']);
  assert.deepEqual(sortUpcoming(items, 0, 'views', 'desc').map(item => item.id), ['current', 'many', 'few', 'hidden', 'unfetched']);
});

test('repeats keep the current and earlier occurrences, then the first upcoming one', () => {
  const items = [
    { id: 'past', videoId: 'a', watched: 0 }, { id: 'past-again', videoId: 'a', watched: 0 },
    { id: 'current', videoId: 'b', watched: 0 }, { id: 'of-past', videoId: 'a', watched: 0 },
    { id: 'first', videoId: 'c', watched: 0 }, { id: 'of-current', videoId: 'b', watched: 0 },
    { id: 'second', videoId: 'c', watched: 50 }, { id: 'no-id', videoId: '', watched: 0 },
    { id: 'no-id-either', videoId: '', watched: 0 },
  ];
  assert.deepEqual(duplicateIds(items, 2), ['of-past', 'of-current', 'second']);
});

test('any watch progress counts as watched, except on the current video', () => {
  const items = [
    { id: 'past', videoId: 'a', watched: 100 }, { id: 'current', videoId: 'b', watched: 40 },
    { id: 'started', videoId: 'c', watched: 1 }, { id: 'unwatched', videoId: 'd', watched: 0 },
  ];
  assert.deepEqual(watchedIds(items, 1), ['past', 'started']);
  // A threshold needs that much progress; no progress never counts.
  assert.deepEqual(watchedIds(items, 1, 50), ['past']);
  assert.deepEqual(watchedIds(items, 0, 40), ['current']);
  assert.deepEqual(watchedIds(items, 1, 100), ['past']);
});

test('an already-sorted tail and a final current item stay unchanged', () => {
  const items = [{ id: 'a', duration: 500 }, { id: 'b', duration: 1 }, { id: 'c', duration: null }];
  assert.deepEqual(sortUpcoming(items, 0), items);
  assert.deepEqual(sortUpcoming(items, 2), items);
  assert.equal(sameOrder(['a'], ['a', 'b']), false);
});

function applyMoves(order: readonly string[], moves: readonly Move[]): string[] {
  let result = [...order];
  for (const { id, after } of moves) {
    result = result.filter(other => other !== id);
    result.splice(after === null ? 0 : result.indexOf(after) + 1, 0, id);
  }
  return result;
}

test('moves only entries outside the longest run already in target order', () => {
  assert.deepEqual(planMoves(['x', 'd', 'a', 'b', 'c'], ['x', 'a', 'b', 'c', 'd'], 1), [{ id: 'd', after: 'c' }]);
  assert.deepEqual(planMoves(['x', 'b', 'c', 'd', 'a'], ['x', 'a', 'b', 'c', 'd'], 1), [{ id: 'a', after: 'x' }]);
  assert.deepEqual(planMoves(['x', 'a', 'b'], ['x', 'a', 'b'], 1), []);
  assert.equal(planMoves(['x', 'e', 'd', 'c', 'b', 'a'], ['x', 'a', 'b', 'c', 'd', 'e'], 1).length, 4);
  assert.deepEqual(planMoves(['x', 'a', 'b'], ['b', 'x', 'a'], 0), [{ id: 'b', after: null }]); // Null drops at the top.
});

test('planned moves reach the target with the fewest moves', () => {
  let seed = 7;
  const random = (limit: number): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % limit;
  for (let round = 0; round < 300; round++) {
    const size = random(12) + 1;
    const fixed = random(size + 1); // Zero lets the top entry move too.
    const current = Array.from({ length: size }, (_, index) => `v${index}`);
    const tail = current.slice(fixed);
    for (let index = tail.length - 1; index > 0; index--) {
      const other = random(index + 1);
      [tail[index], tail[other]] = [tail[other]!, tail[index]!];
    }
    const target = [...current.slice(0, fixed), ...tail];
    const moves = planMoves(current, target, fixed);
    assert.deepEqual(applyMoves(current, moves), target);
    // Each move can fix at most one entry outside the longest in-order run.
    const ranks = current.slice(fixed).map(id => target.indexOf(id));
    const longest = ranks.map(() => 1);
    ranks.forEach((rank, index) => {
      for (let earlier = 0; earlier < index; earlier++) {
        if (ranks[earlier]! < rank) longest[index] = Math.max(longest[index]!, longest[earlier]! + 1);
      }
    });
    assert.equal(moves.length, ranks.length - Math.max(0, ...longest));
  }
});

test('above lists every occurrence before the current one', () => {
  const items = ['a', 'b', 'current', 'd'].map(id => ({ id, videoId: id, watched: 0 }));
  assert.deepEqual(aboveIds(items, 2), ['a', 'b']);
  assert.deepEqual(aboveIds(items, 0), []);
});

test('the current video joins the sorted pool only when asked', () => {
  const items = [
    { id: 'past', duration: 30 }, { id: 'current', duration: 50 }, { id: 'long', duration: 90 }, { id: 'short', duration: 10 },
  ];
  const order = (options = {}) => arrange(items, 1, 'duration', 'asc', options).map(item => item.id);
  assert.deepEqual(order(), ['past', 'current', 'short', 'long']);
  assert.deepEqual(order({ includeCurrent: true }), ['past', 'short', 'current', 'long']);
  assert.deepEqual(arrange(items, 1, 'duration', 'desc', { includeCurrent: true }).map(item => item.id), ['past', 'long', 'current', 'short']);
  assert.deepEqual(partition(items, 1, { includeCurrent: true }).pool.map(item => item.id), ['current', 'long', 'short']);
  assert.throws(() => partition(items, 4), /currently playing/);
});

test('unwatched videos above the current one join the sorted pool only when asked', () => {
  const items = [
    { id: 'seen', duration: 5, watched: 100 }, { id: 'missed', duration: 70, watched: 0 }, { id: 'half', duration: 1, watched: 40 },
    { id: 'current', duration: 50, watched: 10 }, { id: 'long', duration: 90, watched: 0 }, { id: 'short', duration: 20, watched: 0 },
  ];
  const watched = (item: { watched: number }) => item.watched >= 50;
  const order = (options = {}) => arrange(items, 3, 'duration', 'asc', { watched, ...options }).map(item => item.id);
  assert.deepEqual(order(), ['seen', 'missed', 'half', 'current', 'short', 'long']);
  // Below 50% counts as unwatched, so "half" is sorted too.
  assert.deepEqual(order({ includeAbove: true }), ['seen', 'current', 'half', 'short', 'missed', 'long']);
  assert.deepEqual(order({ includeAbove: true, includeCurrent: true }), ['seen', 'half', 'short', 'current', 'missed', 'long']);
  assert.deepEqual(partition(items, 3, { includeAbove: true, watched }).top.map(item => item.id), ['seen', 'current']);
  // Without a watched check, every video above counts as unwatched.
  assert.deepEqual(partition(items, 3, { includeAbove: true }).pool.length, 5);
});

test('watched videos move above the current and sorted ones only when asked', () => {
  const items = [
    { id: 'missed', duration: 70, watched: 0 }, { id: 'seen', duration: 5, watched: 100 },
    { id: 'current', duration: 50, watched: 100 }, { id: 'long', duration: 90, watched: 60 }, { id: 'short', duration: 20, watched: 0 },
    { id: 'tiny', duration: 1, watched: 80 },
  ];
  const watched = (item: { watched: number }) => item.watched >= 50;
  const order = (options = {}) => arrange(items, 2, 'duration', 'asc', { watched, ...options }).map(item => item.id);
  assert.deepEqual(order({ watchedFirst: true }), ['seen', 'long', 'tiny', 'missed', 'current', 'short']);
  assert.deepEqual(order({ watchedFirst: true, includeAbove: true }), ['seen', 'long', 'tiny', 'current', 'short', 'missed']);
  assert.deepEqual(order({ watchedFirst: true, includeCurrent: true }), ['seen', 'long', 'tiny', 'missed', 'short', 'current']);
  assert.deepEqual(order(), ['missed', 'seen', 'current', 'tiny', 'short', 'long']);
});
