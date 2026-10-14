import assert from 'node:assert/strict';
import test from 'node:test';
import { duplicateIds, parseDuration, planMoves, sameOrder, sortUpcoming, watchedIds, type Move } from '../src/sort.ts';

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
    result.splice(result.indexOf(after) + 1, 0, id);
  }
  return result;
}

test('moves only entries outside the longest run already in target order', () => {
  assert.deepEqual(planMoves(['x', 'd', 'a', 'b', 'c'], ['x', 'a', 'b', 'c', 'd'], 1), [{ id: 'd', after: 'c' }]);
  assert.deepEqual(planMoves(['x', 'b', 'c', 'd', 'a'], ['x', 'a', 'b', 'c', 'd'], 1), [{ id: 'a', after: 'x' }]);
  assert.deepEqual(planMoves(['x', 'a', 'b'], ['x', 'a', 'b'], 1), []);
  assert.equal(planMoves(['x', 'e', 'd', 'c', 'b', 'a'], ['x', 'a', 'b', 'c', 'd', 'e'], 1).length, 4);
});

test('planned moves reach the target with the fewest moves', () => {
  let seed = 7;
  const random = (limit: number): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % limit;
  for (let round = 0; round < 300; round++) {
    const size = random(12) + 1;
    const fixed = random(size) + 1;
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
