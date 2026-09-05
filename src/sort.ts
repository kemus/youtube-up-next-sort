export interface Item {
  id: string;
  duration: number | null;
  title?: string | null;
  postedAt?: number | null;
}

export type SortKey = 'duration' | 'title' | 'date';
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

/** Only posting-date fields feed this parser, never playlist-added timestamps. */
export function parsePostedDate(text: string, now = Date.now()): number | null {
  const value = text.trim();
  if (/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now ? timestamp : null;
  }
  // YouTube sometimes supplies only an English relative age. These are coarse
  // estimates; unrecognized/localized labels are left unavailable, not guessed.
  const relative = /^(?:(?:Streamed|Premiered)\s+)?(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(value);
  if (!relative) return null;
  const units: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
  const timestamp = now - Number(relative[1]) * units[relative[2]!.toLowerCase()]! * 1000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortUpcoming<T extends Item>(
  items: readonly T[], currentIndex: number, key: SortKey = 'duration', direction: Direction = 'asc',
): T[] {
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= items.length) {
    throw new Error('Cannot identify the currently playing item.');
  }
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('YouTube did not provide unique queue item identifiers.');
  }
  const upcoming = items.slice(currentIndex + 1).map((item, index) => ({ item, index }));
  const value = (item: Item): number | string | null => key === 'title' ? item.title?.trim() || null
    : key === 'date' ? item.postedAt ?? null : item.duration;
  upcoming.sort((a, b) => {
    const left = value(a.item);
    const right = value(b.item);
    // Missing values stay last in both directions; equal values retain their
    // pre-cycle order instead of reversing with the rest of the list.
    if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
    const comparison = typeof left === 'string' && typeof right === 'string'
      ? titleOrder.compare(left, right) : left < right ? -1 : left > right ? 1 : 0;
    return comparison * (direction === 'asc' ? 1 : -1) || a.index - b.index;
  });
  return [...items.slice(0, currentIndex + 1), ...upcoming.map(entry => entry.item)];
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
