import { readStored, writeStored } from './settings.ts';

export interface Stats {
  views: number | null;
  likes: number | null;
  uploadedAt: number | null;
}

interface Cached extends Stats {
  fetchedAt: number;
}

const ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';
const BATCH = 50;
const CACHE_KEY = 'stats';
const CACHE_MS = 8 * 60 * 60 * 1000;
// Kept for eight hours per video, in the manager's storage so reloads and other
// tabs reuse it; in memory alone when the manager grants no storage.
const cache = new Map<string, Cached>();

function count(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

const known = (value: unknown): value is number | null => value === null || typeof value === 'number';

/** Merge stored entries into memory and drop expired ones. True when something expired. */
function refreshCache(now: number): boolean {
  const stored = readStored(CACHE_KEY, {});
  if (stored !== null && typeof stored === 'object') {
    for (const [id, entry] of Object.entries(stored as Record<string, Partial<Cached> | null>)) {
      if (typeof entry?.fetchedAt === 'number' && known(entry.views) && known(entry.likes) && known(entry.uploadedAt) &&
          entry.fetchedAt > (cache.get(id)?.fetchedAt ?? -Infinity)) {
        cache.set(id, { views: entry.views, likes: entry.likes, uploadedAt: entry.uploadedAt, fetchedAt: entry.fetchedAt });
      }
    }
  }
  let expired = false;
  for (const [id, entry] of cache) {
    if (now - entry.fetchedAt >= CACHE_MS || entry.fetchedAt > now) { cache.delete(id); expired = true; }
  }
  return expired;
}

function failure(status: number, body: unknown): string {
  const error = (body as { error?: { message?: unknown; errors?: { reason?: unknown }[] } } | null)?.error;
  const reason = error?.errors?.[0]?.reason;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return 'Today’s YouTube Data API quota is used up. It resets at midnight Pacific Time.';
  }
  if (status === 400 && /API key/i.test(message)) return 'YouTube rejected the API key. Check it in the sort settings.';
  return `YouTube Data API request failed (${status})${message ? `: ${message}` : '.'}`;
}

/** Fetch view, like and publish data for videos not cached in the last eight hours. One request per 50 videos. */
export async function fetchStats(videoIds: readonly string[], apiKey: string, signal: AbortSignal): Promise<Map<string, Stats>> {
  const changed = refreshCache(Date.now());
  const missing = [...new Set(videoIds)].filter(id => id && !cache.has(id));
  try {
    await fetchMissing(missing, apiKey, signal);
  } finally {
    // Keep what earlier batches fetched even when a later one fails.
    if (changed || missing.some(id => cache.has(id))) writeStored(CACHE_KEY, Object.fromEntries(cache));
  }
  return new Map(videoIds.flatMap(id => {
    const entry = cache.get(id);
    return entry ? [[id, { views: entry.views, likes: entry.likes, uploadedAt: entry.uploadedAt }] as const] : [];
  }));
}

async function fetchMissing(missing: readonly string[], apiKey: string, signal: AbortSignal): Promise<void> {
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH);
    const query = new URLSearchParams({
      part: 'snippet,statistics',
      fields: 'items(id,snippet/publishedAt,statistics(viewCount,likeCount))',
      id: batch.join(','),
    });
    let response: Response;
    try {
      // A header keeps the key out of the request address, which the page can list.
      response = await fetch(`${ENDPOINT}?${query}`, { signal, credentials: 'omit', headers: { 'X-Goog-Api-Key': apiKey } });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`Could not reach the YouTube Data API: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(failure(response.status, body));
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new Error('The YouTube Data API returned an unexpected response.');
    const fetchedAt = Date.now();
    for (const item of items as { id?: unknown; snippet?: { publishedAt?: unknown }; statistics?: { viewCount?: unknown; likeCount?: unknown } }[]) {
      if (typeof item.id !== 'string') continue;
      const published = typeof item.snippet?.publishedAt === 'string' ? Date.parse(item.snippet.publishedAt) : NaN;
      cache.set(item.id, {
        views: count(item.statistics?.viewCount),
        likes: count(item.statistics?.likeCount),
        uploadedAt: Number.isFinite(published) ? published : null,
        fetchedAt,
      });
    }
    // Private and deleted videos are omitted from the response; do not ask again.
    for (const id of batch) if (!cache.has(id)) cache.set(id, { views: null, likes: null, uploadedAt: null, fetchedAt });
  }
}
