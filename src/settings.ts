// Granted by the userscript manager; absent when the script runs without grants.
declare const GM_getValue: (<T>(name: string, fallback: T) => T) | undefined;
declare const GM_setValue: ((name: string, value: unknown) => void) | undefined;

/** The row's buttons, in their default order. */
export const BUTTON_KEYS = ['duration', 'title', 'views', 'likes', 'uploaded', 'watched', 'above'] as const;
export type ButtonKey = typeof BUTTON_KEYS[number];
export interface ButtonSetting {
  key: ButtonKey;
  on: boolean;
}

/** Stored button order and switches; unknown or repeated entries drop, missing buttons follow, on. */
export function normalizeButtons(value: unknown): ButtonSetting[] {
  const seen = new Set<ButtonKey>();
  const stored = Array.isArray(value) ? value.flatMap(entry => {
    const key = (entry as { key?: unknown } | null)?.key;
    if (!BUTTON_KEYS.includes(key as ButtonKey) || seen.has(key as ButtonKey)) return [];
    seen.add(key as ButtonKey);
    return [{ key: key as ButtonKey, on: (entry as { on?: unknown }).on !== false }];
  }) : [];
  return [...stored, ...BUTTON_KEYS.filter(key => !seen.has(key)).map(key => ({ key, on: true }))];
}

export interface Settings {
  apiKey: string;
  fetch: boolean;
  dedupe: boolean;
  /** How much of a video, in percent, YouTube must show as seen for it to count as watched; 0 means any progress. */
  watchedPercent: number;
  buttons: ButtonSetting[];
  /** Sort the current video too, then play the first sorted video. */
  includeCurrent: boolean;
}

const percent = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;

export function storageAvailable(): boolean {
  return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
}

/** A value from the manager's storage, or the fallback without storage. */
export function readStored(name: string, fallback: unknown): unknown {
  return storageAvailable() ? GM_getValue!<unknown>(name, fallback) : fallback;
}

export function writeStored(name: string, value: unknown): void {
  if (storageAvailable()) GM_setValue!(name, value);
}

/** Settings live in the manager's storage, not the page's; the page can still see the key in use. */
export function loadSettings(): Settings {
  // Without storage nothing can be changed, so nothing removes videos unasked.
  if (!storageAvailable()) return { apiKey: '', fetch: false, dedupe: false, watchedPercent: 0, buttons: normalizeButtons([]), includeCurrent: false };
  const apiKey = GM_getValue!<unknown>('apiKey', '');
  return {
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    fetch: GM_getValue!<unknown>('fetch', false) === true,
    dedupe: GM_getValue!<unknown>('dedupe', true) === true,
    watchedPercent: percent(GM_getValue!<unknown>('watchedPercent', 0)),
    buttons: normalizeButtons(GM_getValue!<unknown>('buttons', [])),
    includeCurrent: GM_getValue!<unknown>('includeCurrent', false) === true,
  };
}

export function saveSettings(settings: Settings): void {
  if (!storageAvailable()) throw new Error('The userscript manager’s storage is unavailable. Reinstall the script to grant it.');
  GM_setValue!('apiKey', settings.apiKey);
  GM_setValue!('fetch', settings.fetch);
  GM_setValue!('dedupe', settings.dedupe);
  GM_setValue!('watchedPercent', percent(settings.watchedPercent));
  GM_setValue!('buttons', normalizeButtons(settings.buttons).map(({ key, on }) => ({ key, on })));
  GM_setValue!('includeCurrent', settings.includeCurrent);
}
