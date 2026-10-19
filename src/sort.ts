export interface Item {
  id: string;
  duration: number | null;
  title?: string | null;
  views?: number | null;
  likes?: number | null;
  uploadedAt?: number | null;
}

export type SortKey = 'duration' | 'title' | 'views' | 'likes' | 'uploaded';
export type Direction = 'asc' | 'desc';
const titleOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Accept time badges, never interpret a live badge or an empty string as zero. */
export function parseDuration(text: string): number | null {
  const value = text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(value)) return null;
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function sortUpcoming<T extends Item>(
  items: readonly T[], currentIndex: number, key: SortKey = 'duration', direction: Direction = 'asc',
): T[] {
  checkItems(items, currentIndex);
  return [...items.slice(0, currentIndex + 1), ...sortItems(items.slice(currentIndex + 1), key, direction)];
}

function checkItems(items: readonly Item[], currentIndex: number): void {
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= items.length) {
    throw new Error('Cannot identify the currently playing item.');
  }
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('YouTube did not provide unique queue item identifiers.');
  }
}

/** Sort by one key; missing values go last, and ties keep their given order. */
function sortItems<T extends Item>(items: readonly T[], key: SortKey, direction: Direction): T[] {
  const entries = items.map((item, index) => ({ item, index }));
  const value = (item: Item): number | string | null => key === 'title' ? item.title?.trim() || null
    : key === 'views' ? item.views ?? null : key === 'likes' ? item.likes ?? null
    : key === 'uploaded' ? item.uploadedAt ?? null : item.duration;
  entries.sort((a, b) => {
    const left = value(a.item);
    const right = value(b.item);
    // Missing values stay last in both directions; equal values retain their
    // pre-cycle order instead of reversing with the rest of the list.
    if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
    const comparison = typeof left === 'string' && typeof right === 'string'
      ? titleOrder.compare(left, right) : left < right ? -1 : left > right ? 1 : 0;
    return comparison * (direction === 'asc' ? 1 : -1) || a.index - b.index;
  });
  return entries.map(entry => entry.item);
}

export interface ArrangeOptions<T> {
  /** Sort the current video with the upcoming ones. */
  includeCurrent?: boolean;
  /** Sort the unwatched videos above the current one with the upcoming ones. */
  includeAbove?: boolean;
  /** Move watched videos, except the current one, above everything else, in order. */
  watchedFirst?: boolean;
  /** Whether a video counts as watched; none do without it. */
  watched?: (item: T) => boolean;
}

/**
 * Split the queue into the entries that keep their place at the top, in
 * order, and the pool a sort reorders below them.
 */
export function partition<T extends Item>(items: readonly T[], currentIndex: number, options: ArrangeOptions<T> = {}): { top: T[]; pool: T[] } {
  checkItems(items, currentIndex);
  const watched = options.watched ?? (() => false);
  const first: T[] = [];
  const top: T[] = [];
  const pool: T[] = [];
  items.forEach((item, index) => {
    if (index !== currentIndex && options.watchedFirst === true && watched(item)) { first.push(item); return; }
    const sorted = index > currentIndex ||
      (index === currentIndex ? options.includeCurrent === true : options.includeAbove === true && !watched(item));
    (sorted ? pool : top).push(item);
  });
  return { top: [...first, ...top], pool };
}

/** The whole queue after sorting its pool; see partition. */
export function arrange<T extends Item>(
  items: readonly T[], currentIndex: number, key: SortKey, direction: Direction, options: ArrangeOptions<T> = {},
): T[] {
  const { top, pool } = partition(items, currentIndex, options);
  return [...top, ...sortItems(pool, key, direction)];
}

export interface Occurrence {
  id: string;
  videoId: string;
  watched: number;
}

/**
 * Upcoming occurrences that repeat a video. The current and earlier occurrences
 * always stay; among upcoming-only repeats the first stays.
 */
export function duplicateIds(items: readonly Occurrence[], currentIndex: number): string[] {
  const seen = new Set<string>();
  return items.flatMap((item, index) => {
    if (!item.videoId) return [];
    if (!seen.has(item.videoId)) { seen.add(item.videoId); return []; }
    return index > currentIndex ? [item.id] : [];
  });
}

/**
 * Every occurrence watched at least `percent` (any progress at 0), except the current one.
 */
export function watchedIds(items: readonly Occurrence[], currentIndex: number, percent = 0): string[] {
  return items.flatMap((item, index) => index !== currentIndex && isWatched(item, percent) ? [item.id] : []);
}

export function isWatched(item: Occurrence, percent = 0): boolean {
  return item.watched > 0 && item.watched >= percent;
}

/** Every occurrence above the current one. */
export function aboveIds(items: readonly Occurrence[], currentIndex: number): string[] {
  return items.slice(0, Math.max(currentIndex, 0)).map(item => item.id);
}

export interface Move {
  id: string;
  /** The entry the moved one is dropped directly after; null for the top. */
  after: string | null;
}

/**
 * The fewest single-entry moves that turn `current` into `target`, both the
 * same entries with the first `fixed` in place: the longest run already in
 * target order stays, and each other entry, taken in target order, is dropped
 * right after its target predecessor.
 */
export function planMoves(current: readonly string[], target: readonly string[], fixed: number): Move[] {
  const rank = new Map(target.map((id, index) => [id, index]));
  const upcoming = current.slice(fixed);
  // Longest increasing subsequence of target ranks, by patience sorting.
  const tails: number[] = [];
  const previous: number[] = [];
  upcoming.forEach((id, index) => {
    const value = rank.get(id)!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (rank.get(upcoming[tails[middle]!]!)! < value) low = middle + 1; else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  });
  const kept = new Set<string>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) kept.add(upcoming[index]!);
  return target.slice(fixed).flatMap((id, offset) => kept.has(id) ? [] : [{ id, after: target[fixed + offset - 1] ?? null }]);
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
