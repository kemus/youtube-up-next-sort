export interface Item {
  id: string;
  duration: number | null;
}

/** Accept time badges, never interpret a live badge or an empty string as zero. */
export function parseDuration(text: string): number | null {
  const value = text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!/^\d+:\d{2}(?::\d{2})?$/.test(value)) return null;
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function sortUpcoming<T extends Item>(items: readonly T[], currentIndex: number): T[] {
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= items.length) {
    throw new Error('Cannot identify the currently playing item.');
  }
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('YouTube did not provide unique queue item identifiers.');
  }
  const upcoming = items.slice(currentIndex + 1).map((item, index) => ({ item, index }));
  upcoming.sort((a, b) => {
    const left = a.item.duration ?? Infinity;
    const right = b.item.duration ?? Infinity;
    return (left < right ? -1 : left > right ? 1 : 0) || a.index - b.index;
  });
  return [...items.slice(0, currentIndex + 1), ...upcoming.map(entry => entry.item)];
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
