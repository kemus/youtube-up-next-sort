// Granted by the userscript manager; absent when the script runs without grants.
declare const GM_getValue: (<T>(name: string, fallback: T) => T) | undefined;
declare const GM_setValue: ((name: string, value: string | boolean) => void) | undefined;

export interface Settings {
  apiKey: string;
  fetch: boolean;
  dedupe: boolean;
}

export function storageAvailable(): boolean {
  return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
}

/** Settings live in the manager's storage, not the page's; the page can still see the key in use. */
export function loadSettings(): Settings {
  if (!storageAvailable()) return { apiKey: '', fetch: false, dedupe: false };
  const apiKey = GM_getValue!<unknown>('apiKey', '');
  return {
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    fetch: GM_getValue!<unknown>('fetch', false) === true,
    dedupe: GM_getValue!<unknown>('dedupe', false) === true,
  };
}

export function saveSettings(settings: Settings): void {
  if (!storageAvailable()) throw new Error('The userscript manager’s storage is unavailable. Reinstall the script to grant it.');
  GM_setValue!('apiKey', settings.apiKey);
  GM_setValue!('fetch', settings.fetch);
  GM_setValue!('dedupe', settings.dedupe);
}
