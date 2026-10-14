export interface Stats {
  views: number | null;
  likes: number | null;
  uploadedAt: number | null;
}

const ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';
const BATCH = 50;
// Kept until the page reloads, so each video costs quota once per session.
const cache = new Map<string, Stats>();

function count(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
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

/** Fetch view, like and publish data for videos not already cached. One request per 50 videos. */
export async function fetchStats(videoIds: readonly string[], apiKey: string, signal: AbortSignal): Promise<Map<string, Stats>> {
  const missing = [...new Set(videoIds)].filter(id => id && !cache.has(id));
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH);
    const query = new URLSearchParams({
      part: 'snippet,statistics',
      fields: 'items(id,snippet/publishedAt,statistics(viewCount,likeCount))',
      id: batch.join(','),
      key: apiKey,
    });
    let response: Response;
    try {
      response = await fetch(`${ENDPOINT}?${query}`, { signal, credentials: 'omit' });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`Could not reach the YouTube Data API: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(failure(response.status, body));
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new Error('The YouTube Data API returned an unexpected response.');
    for (const item of items as { id?: unknown; snippet?: { publishedAt?: unknown }; statistics?: { viewCount?: unknown; likeCount?: unknown } }[]) {
      if (typeof item.id !== 'string') continue;
      const published = typeof item.snippet?.publishedAt === 'string' ? Date.parse(item.snippet.publishedAt) : NaN;
      cache.set(item.id, {
        views: count(item.statistics?.viewCount),
        likes: count(item.statistics?.likeCount),
        uploadedAt: Number.isFinite(published) ? published : null,
      });
    }
    // Private and deleted videos are omitted from the response; do not ask again.
    for (const id of batch) if (!cache.has(id)) cache.set(id, { views: null, likes: null, uploadedAt: null });
  }
  return new Map(videoIds.flatMap(id => cache.has(id) ? [[id, cache.get(id)!] as const] : []));
}
