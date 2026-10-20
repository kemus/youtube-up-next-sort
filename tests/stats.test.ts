import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

type StatsModule = typeof import('../src/stats.ts');
const scope = globalThis as Record<string, unknown>;
const realFetch = globalThis.fetch;
const HOUR = 3600000;
let copies = 0;

/** A fresh copy of the module, so each test starts with an empty in-memory cache. */
async function load(): Promise<StatsModule['fetchStats']> {
  const url = new URL(`../src/stats.ts?copy=${copies++}`, import.meta.url).href;
  return ((await import(url)) as StatsModule).fetchStats;
}
function grant(store: Record<string, unknown> = {}): { store: Record<string, unknown>; writes: string[] } {
  const writes: string[] = [];
  scope.GM_getValue = (name: string, fallback: unknown) => name in store ? store[name] : fallback;
  scope.GM_setValue = (name: string, value: unknown) => { writes.push(name); store[name] = value; };
  return { store, writes };
}
interface Call { url: URL; init: RequestInit }
/** Answer each request with `respond`, recording it; the default lists every asked id with its index as views. */
function serve(respond: (call: Call, index: number) => Response | Promise<Response> = call => json({
  items: call.url.searchParams.get('id')!.split(',').map((id, index) => ({
    id, snippet: { publishedAt: '2024-01-02T03:04:05Z' }, statistics: { viewCount: String(index), likeCount: '7' },
  })),
})): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: new URL(String(url)), init };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const signal = () => new AbortController().signal;
afterEach(() => { globalThis.fetch = realFetch; delete scope.GM_getValue; delete scope.GM_setValue; });

test('asks for each new video once, in batches of 50, with the key in a header and no cookies', async () => {
  const fetchStats = await load();
  grant();
  const calls = serve();
  const ids = Array.from({ length: 120 }, (_, index) => `v${index}`);
  const abort = new AbortController();
  const result = await fetchStats([...ids, 'v0', '', 'v119'], 'key-1', abort.signal);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('id')!.split(',').length), [50, 50, 20]);
  assert.deepEqual(calls.flatMap(call => call.url.searchParams.get('id')!.split(',')), ids);
  for (const { url, init } of calls) {
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/videos');
    assert.equal(url.searchParams.get('part'), 'snippet,statistics');
    assert.equal(url.searchParams.get('fields'), 'items(id,snippet/publishedAt,statistics(viewCount,likeCount))');
    assert.equal(url.searchParams.get('key'), null);
    assert.deepEqual(init.headers, { 'X-Goog-Api-Key': 'key-1' });
    assert.equal(init.credentials, 'omit');
    assert.equal(init.signal, abort.signal);
  }
  assert.equal(result.size, 120);
  assert.deepEqual(result.get('v51'), { views: 1, likes: 7, uploadedAt: Date.parse('2024-01-02T03:04:05Z') });
});

test('counts must be whole digit strings within the safe range, and dates must parse', async () => {
  const fetchStats = await load();
  const { store } = grant();
  serve(() => json({ items: [
    { id: 'digits', snippet: { publishedAt: 'not a date' }, statistics: { viewCount: '123', likeCount: '0' } },
    { id: 'fraction', statistics: { viewCount: '12.5', likeCount: '-1' } },
    { id: 'number', snippet: { publishedAt: 5 }, statistics: { viewCount: 5, likeCount: '' } },
    { id: 'huge', statistics: { viewCount: '99999999999999999999', likeCount: '9007199254740991' } },
    { id: 7, statistics: { viewCount: '1' } },
  ] }));
  const result = await fetchStats(['digits', 'fraction', 'number', 'huge'], 'k', signal());
  assert.deepEqual(Object.fromEntries(result), {
    digits: { views: 123, likes: 0, uploadedAt: null },
    fraction: { views: null, likes: null, uploadedAt: null },
    number: { views: null, likes: null, uploadedAt: null },
    huge: { views: null, likes: 9007199254740991, uploadedAt: null },
  });
  // An item without a string id is skipped, not stored under some other key.
  assert.deepEqual(Object.keys(store.stats as object).sort(), ['digits', 'fraction', 'huge', 'number']);
});

test('videos the API leaves out are kept as unknown and not asked for again', async () => {
  const fetchStats = await load();
  const calls = serve(() => json({ items: [] }));
  const first = await fetchStats(['private'], 'k', signal());
  assert.deepEqual(first.get('private'), { views: null, likes: null, uploadedAt: null });
  await fetchStats(['private'], 'k', signal());
  assert.equal(calls.length, 1);
});

test('the result holds only the asked videos, and cached ones are not asked again', async () => {
  const fetchStats = await load();
  const { writes } = grant();
  const calls = serve();
  await fetchStats(['a', 'b'], 'k', signal());
  assert.deepEqual(writes, ['stats']);
  const result = await fetchStats(['b', 'c'], 'k', signal());
  assert.deepEqual([...result.keys()], ['b', 'c']);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('id')), ['a,b', 'c']);
  // Nothing new and nothing expired: storage is left alone.
  await fetchStats(['a', 'c'], 'k', signal());
  assert.deepEqual(writes, ['stats', 'stats']);
  assert.equal(calls.length, 2);
});

test('stored details are reused for eight hours, then asked for again', async () => {
  const fetchStats = await load();
  const now = Date.now();
  const entry = (age: number, views = 1) => ({ views, likes: 2, uploadedAt: 3, fetchedAt: now - age });
  const { store } = grant({ stats: { fresh: entry(8 * HOUR - 60000), stale: entry(8 * HOUR), future: entry(-60000) } });
  const calls = serve();
  const result = await fetchStats(['fresh', 'stale', 'future'], 'k', signal());
  assert.deepEqual(calls.map(call => call.url.searchParams.get('id')), ['stale,future']);
  assert.deepEqual(result.get('fresh'), { views: 1, likes: 2, uploadedAt: 3 });
  assert.equal(result.get('stale')?.views, 0);
  const stored = store.stats as Record<string, { fetchedAt: number }>;
  assert.deepEqual(Object.keys(stored).sort(), ['fresh', 'future', 'stale']);
  assert.ok(stored.stale!.fetchedAt >= now);
});

test('an expired stored entry is dropped from storage even when nothing is fetched', async () => {
  const fetchStats = await load();
  const { store, writes } = grant({ stats: { old: { views: 1, likes: 1, uploadedAt: 1, fetchedAt: Date.now() - 9 * HOUR } } });
  const calls = serve();
  assert.equal((await fetchStats([], 'k', signal())).size, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(writes, ['stats']);
  assert.deepEqual(store.stats, {});
});

test('malformed stored entries are ignored', async () => {
  const fetchStats = await load();
  const now = Date.now();
  grant({ stats: {
    textTime: { views: 1, likes: 1, uploadedAt: 1, fetchedAt: String(now) },
    textViews: { views: '1', likes: 1, uploadedAt: 1, fetchedAt: now },
    noLikes: { views: 1, uploadedAt: 1, fetchedAt: now },
    badDate: { views: 1, likes: 1, uploadedAt: 'x', fetchedAt: now },
    empty: null,
    good: { views: null, likes: null, uploadedAt: null, fetchedAt: now },
  } });
  const calls = serve();
  await fetchStats(['textTime', 'textViews', 'noLikes', 'badDate', 'empty', 'good'], 'k', signal());
  assert.deepEqual(calls.map(call => call.url.searchParams.get('id')), ['textTime,textViews,noLikes,badDate,empty']);
});

test('a stored entry replaces the one in memory only when it is newer', async () => {
  const fetchStats = await load();
  const at = Date.now() - 2 * HOUR;
  const entry = (views: number, fetchedAt: number) => ({ stats: { a: { views, likes: 0, uploadedAt: 0, fetchedAt } } });
  const { store } = grant(entry(10, at));
  const calls = serve();
  assert.equal((await fetchStats(['a'], 'k', signal())).get('a')?.views, 10);
  Object.assign(store, entry(50, at - 1000));
  assert.equal((await fetchStats(['a'], 'k', signal())).get('a')?.views, 10);
  Object.assign(store, entry(60, at + 1000));
  assert.equal((await fetchStats(['a'], 'k', signal())).get('a')?.views, 60);
  assert.equal(calls.length, 0);
});

test('without storage the details stay in memory', async () => {
  const fetchStats = await load();
  const calls = serve();
  await fetchStats(['a'], 'k', signal());
  assert.equal((await fetchStats(['a'], 'k', signal())).get('a')?.views, 0);
  assert.equal(calls.length, 1);
});

test('earlier batches are stored even when a later one fails', async () => {
  const fetchStats = await load();
  const { store } = grant();
  serve((call, index) => index === 0 ? json({ items: [] }) : json({}, 500));
  const ids = Array.from({ length: 60 }, (_, index) => `v${index}`);
  await assert.rejects(fetchStats(ids, 'k', signal()), { message: 'YouTube Data API request failed (500).' });
  assert.equal(Object.keys(store.stats as object).length, 50);
});

test('API failures read as plain messages', async () => {
  const cases: [Response, RegExp][] = [
    [json({ error: { message: 'Quota exceeded.', errors: [{ reason: 'quotaExceeded' }] } }, 403), /^Today’s YouTube Data API quota is used up\. It resets at midnight Pacific Time\.$/],
    [json({ error: { errors: [{ reason: 'dailyLimitExceeded' }] } }, 403), /quota is used up/],
    [json({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 400), /^YouTube rejected the API key\. Check it in the sort settings\.$/],
    [json({ error: { message: 'Bad id list' } }, 400), /^YouTube Data API request failed \(400\): Bad id list$/],
    [json({ error: { message: 'API key expired' } }, 403), /^YouTube Data API request failed \(403\): API key expired$/],
    [new Response('<html>', { status: 502 }), /^YouTube Data API request failed \(502\)\.$/],
    [json({ kind: 'youtube#videoListResponse' }), /^The YouTube Data API returned an unexpected response\.$/],
    [new Response('not json'), /^The YouTube Data API returned an unexpected response\.$/],
    [json({ items: {} }), /^The YouTube Data API returned an unexpected response\.$/],
    [json({ items: 'a' }), /^The YouTube Data API returned an unexpected response\.$/],
  ];
  for (const [response, message] of cases) {
    const fetchStats = await load();
    serve(() => response);
    await assert.rejects(fetchStats(['a'], 'k', signal()), { message });
  }
});

test('a network failure says the API was unreachable, but a stop stays a stop', async () => {
  let fetchStats = await load();
  serve(() => { throw new TypeError('NetworkError'); });
  await assert.rejects(fetchStats(['a'], 'k', signal()), { message: 'Could not reach the YouTube Data API: NetworkError' });
  fetchStats = await load();
  const abort = new AbortController();
  serve(() => { abort.abort(); throw new DOMException('The operation was aborted.', 'AbortError'); });
  await assert.rejects(fetchStats(['a'], 'k', abort.signal), { name: 'AbortError' });
});
