import { loadSettings, saveSettings, storageAvailable } from './settings.ts';
import { duplicateIds, sameOrder, sortUpcoming, watchedIds, type Direction, type SortKey } from './sort.ts';
import { fetchStats } from './stats.ts';
import { readSnapshot, removeItems, reorderPanel, type QueueItem, type Snapshot } from './youtube.ts';

const HOST_TAG = 'yt-up-next-duration-sort';
let running: AbortController | null = null;
let settings = loadSettings();
interface Cycle {
  key: SortKey;
  phase: Direction | 'partial';
  baseline: string[];
  expected: string[];
  currentIndex: number;
  currentId: string;
}
const cycles = new Map<string, Cycle>();
const controls = new Map<HTMLElement, () => void>();
const names: Record<SortKey, string> = { duration: 'Duration', title: 'Title', views: 'Views', likes: 'Likes', uploaded: 'Uploaded' };
const plurals: Record<SortKey, string> = { duration: 'durations', title: 'titles', views: 'view counts', likes: 'like counts', uploaded: 'upload dates' };
const descriptions: Record<SortKey, Record<Direction, string>> = {
  duration: { asc: 'shortest to longest', desc: 'longest to shortest' },
  title: { asc: 'A to Z', desc: 'Z to A' },
  views: { asc: 'fewest to most views', desc: 'most to fewest views' },
  likes: { asc: 'fewest to most likes', desc: 'most to fewest likes' },
  uploaded: { asc: 'oldest to newest upload', desc: 'newest to oldest upload' },
};
// These sorts need data YouTube's queue does not carry; it is fetched on click.
const fetched: ReadonlySet<SortKey> = new Set(['views', 'likes', 'uploaded']);
const canFetch = (): boolean => settings.fetch && settings.apiKey !== '';
const unknown = (item: QueueItem, key: SortKey): boolean => key === 'duration' ? item.duration === null
  : key === 'title' ? !item.title : key === 'views' ? item.views == null
  : key === 'likes' ? item.likes == null : item.uploadedAt == null;
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const ids = (snapshot: Snapshot): string[] => snapshot.items.map(item => item.id);
function matchingCycle(snapshot: Snapshot): Cycle | undefined {
  const cycle = cycles.get(snapshot.playlistId);
  return cycle && cycle.currentIndex === snapshot.currentIndex &&
    cycle.currentId === snapshot.items[snapshot.currentIndex]?.id &&
    sameOrder(cycle.expected, ids(snapshot)) ? cycle : undefined;
}
function nextStep(cycle: Cycle | undefined, key: SortKey): Direction | 'undo' {
  return cycle?.key !== key ? 'asc' : cycle.phase === 'asc' ? 'desc' : 'undo';
}
function refreshControls(): void {
  for (const [host, refresh] of controls) {
    if (host.isConnected) refresh(); else controls.delete(host);
  }
}

/** YouTube's panel action row, only when its sole visible control is Save. */
function nativeSave(panel: HTMLElement): { row: HTMLElement; button: HTMLButtonElement } | null {
  const row = panel.querySelector<HTMLElement>('#playlist-actions');
  if (!row) return null;
  // Measure with this script's hiding lifted; nothing paints in between.
  const display = row.style.display;
  row.style.display = '';
  const controls = Array.from(row.querySelectorAll<HTMLElement>('button, a[href], [role="button"]'))
    .filter(control => control.getClientRects().length > 0);
  row.style.display = display;
  const button = controls[0];
  return controls.length === 1 && button instanceof HTMLButtonElement && button.textContent?.trim() &&
    button.closest('#flexible-item-buttons ytd-button-renderer') ? { row, button } : null;
}

function mount(panel: HTMLElement): void {
  if (panel.querySelector(HOST_TAG)) return;
  const host = document.createElement(HOST_TAG);
  // Closed, so page scripts can't walk into the settings field.
  const root = host.attachShadow({ mode: 'closed' });
  // YouTube enforces Trusted Types in page context. Build DOM nodes rather than
  // assigning HTML strings, which would throw before the control is attached.
  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; padding: 4px 8px; color: var(--yt-spec-text-secondary, #aaa); font: 11px/1.4 system-ui, sans-serif; }
    button { border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; padding: 3px 7px; margin: 0 4px 4px 0; background: transparent; color: inherit; font: 400 11px/16px system-ui, sans-serif; cursor: pointer; }
    button[aria-pressed="true"] { color: var(--yt-spec-text-primary, #eee); }
    button:disabled { opacity: .5; cursor: default; }
    button[hidden], .settings[hidden], .confirm[hidden] { display: none; }
    button:hover:enabled { background: var(--yt-spec-badge-chip-background, #333); color: var(--yt-spec-text-primary, #eee); }
    button:focus-visible, input:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .save { display: inline-flex; align-items: center; gap: 4px; vertical-align: top; }
    .save svg { width: 14px; height: 14px; fill: currentColor; }
    .settings label { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
    .settings .key { display: flex; align-items: center; gap: 4px; max-width: 420px; margin-bottom: 4px; }
    .settings .key button { margin: 0; }
    .settings input[type="password"] { flex: 1; min-width: 0; box-sizing: border-box; padding: 3px 6px; border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; background: transparent; color: var(--yt-spec-text-primary, #eee); font: inherit; }
    /* The knob is a gradient: Firefox draws no ::before on inputs. */
    .settings input[role="switch"] { appearance: none; flex: none; width: 26px; height: 14px; margin: 0; border-radius: 7px; cursor: pointer;
      background: radial-gradient(circle at 7px 50%, #fff 4.5px, transparent 5px) var(--yt-spec-10-percent-layer, #555); }
    .settings input[role="switch"]:checked { background: radial-gradient(circle at 19px 50%, #fff 4.5px, transparent 5px) var(--yt-spec-call-to-action, #3ea6ff); }
    .settings input[role="switch"]:disabled { opacity: .5; cursor: default; }
    .settings p { margin: 4px 0; }
    .confirm span { margin-right: 6px; color: var(--yt-spec-text-primary, #eee); }
    .notice { margin: 0 0 4px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
  const makeButton = (text: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    return button;
  };
  const buttons = new Map<SortKey, HTMLButtonElement>();
  for (const key of ['duration', 'title', 'views', 'likes', 'uploaded'] as const) {
    const button = makeButton(names[key]);
    button.dataset.sort = key;
    button.hidden = fetched.has(key);
    buttons.set(key, button);
  }
  const removeWatched = makeButton('Remove watched');
  removeWatched.dataset.action = 'watched';
  const gear = makeButton('⚙');
  gear.dataset.action = 'settings';
  gear.title = 'Sort settings';
  gear.setAttribute('aria-label', 'Sort settings');
  gear.setAttribute('aria-expanded', 'false');

  const form = document.createElement('div');
  form.className = 'settings';
  form.hidden = true;
  const toggle = (name: string, text: string): HTMLInputElement => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.dataset.setting = name;
    label.append(input, text);
    form.append(label);
    return input;
  };
  const fetchBox = toggle('fetch', 'Fetch views, likes and upload dates');
  const keyLabel = document.createElement('label');
  keyLabel.htmlFor = 'api-key';
  keyLabel.textContent = 'YouTube Data API key';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.id = 'api-key';
  keyInput.dataset.setting = 'apiKey';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = 'Paste a key';
  const clearKey = makeButton('Clear');
  clearKey.dataset.action = 'clear';
  const saveKey = makeButton('Save');
  saveKey.dataset.action = 'save-key';
  const keyRow = document.createElement('div');
  keyRow.className = 'key';
  keyRow.append(keyInput, clearKey, saveKey);
  form.append(keyLabel, keyRow);
  const dedupeBox = toggle('dedupe', 'Dedupe');
  dedupeBox.parentElement!.title = 'Remove repeated upcoming videos when sorting.';
  const hint = document.createElement('p');
  form.append(hint);

  const confirmBar = document.createElement('div');
  confirmBar.className = 'confirm';
  confirmBar.hidden = true;
  const confirmText = document.createElement('span');
  const confirmYes = makeButton('Remove');
  confirmYes.dataset.action = 'confirm';
  const confirmNo = makeButton('Cancel');
  confirmNo.dataset.action = 'cancel';
  confirmBar.append(confirmText, confirmYes, confirmNo);

  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.className = 'sr-only';
  const save = makeButton('');
  save.className = 'save';
  save.hidden = true;
  root.append(style, save, ...buttons.values(), removeWatched, gear, confirmBar, status, form);
  // Keep clicks from toggling YouTube's panel header, and typing in the key
  // field from triggering YouTube's player hotkeys.
  for (const type of ['click', 'keydown', 'keyup', 'keypress']) {
    root.addEventListener(type, event => event.stopPropagation());
  }
  const report = (message: string, attention = false): void => {
    status.textContent = message;
    status.className = attention ? 'notice' : 'sr-only';
  };
  let hiddenRow: { row: HTMLElement; display: string } | undefined;
  let saveLook = '';
  save.addEventListener('click', () => { nativeSave(panel)?.button.click(); });

  // Mirror YouTube's Save into this row and hide its own row, which then holds
  // nothing else. YouTube's button stays in place and handles the click.
  function syncSave(): void {
    const native = nativeSave(panel);
    if (hiddenRow && hiddenRow.row !== native?.row) {
      hiddenRow.row.style.display = hiddenRow.display;
      hiddenRow = undefined;
    }
    save.hidden = !native;
    if (!native) return;
    if (!hiddenRow) {
      hiddenRow = { row: native.row, display: native.row.style.display };
      native.row.style.display = 'none';
    }
    const label = native.button.textContent!.trim();
    const icon = native.button.querySelector('svg');
    if (saveLook !== `${label}|${icon !== null}`) {
      saveLook = `${label}|${icon !== null}`;
      save.replaceChildren(...(icon ? [icon.cloneNode(true)] : []), label);
    }
    save.setAttribute('aria-label', native.button.getAttribute('aria-label') || label);
    save.title = native.button.getAttribute('aria-label') || label;
    save.disabled = running !== null;
  }

  function fillSettings(): void {
    settings = loadSettings();
    const available = storageAvailable();
    fetchBox.checked = settings.fetch;
    dedupeBox.checked = settings.dedupe;
    keyInput.value = settings.apiKey;
    for (const input of [fetchBox, keyInput, dedupeBox]) input.disabled = !available;
    updateKeyButtons();
    hint.hidden = available;
    hint.textContent = available ? '' : 'Settings need the userscript manager’s storage permission. Reinstall the script to grant it.';
  }
  // The key field holds the saved key, masked; edits apply only through Save.
  function updateKeyButtons(): void {
    const typed = keyInput.value.trim();
    saveKey.disabled = keyInput.disabled || !typed || typed === settings.apiKey;
    clearKey.disabled = keyInput.disabled || (!settings.apiKey && !keyInput.value);
  }
  gear.addEventListener('click', () => {
    form.hidden = !form.hidden;
    gear.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) fillSettings();
  });
  const store = (apiKey: string): void => {
    settings = { apiKey, fetch: fetchBox.checked, dedupe: dedupeBox.checked };
    try {
      saveSettings(settings);
    } catch (error) {
      report(error instanceof Error ? error.message : String(error), true);
    }
    updateKeyButtons();
    refreshControls();
  };
  for (const input of [fetchBox, dedupeBox]) input.addEventListener('input', () => store(settings.apiKey));
  keyInput.addEventListener('input', updateKeyButtons);
  saveKey.addEventListener('click', () => { keyInput.value = keyInput.value.trim(); store(keyInput.value); });
  clearKey.addEventListener('click', () => { keyInput.value = ''; store(''); });

  function describe(): void {
    syncSave();
    let snapshot: Snapshot | undefined;
    let problem = '';
    try {
      snapshot = readSnapshot(panel);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    const cycle = snapshot ? matchingCycle(snapshot) : undefined;
    const upcoming = snapshot?.items.slice(snapshot.currentIndex + 1) ?? [];
    const saved = snapshot !== undefined && !snapshot.playlistId.startsWith('TLPQ');
    for (const [key, button] of buttons) {
      if (button.dataset.running) continue;
      const active = cycle?.key === key;
      button.textContent = names[key] + (active ? cycle.phase === 'asc' ? ' ↑' : cycle.phase === 'desc' ? ' ↓' : ' ↶' : '');
      button.setAttribute('aria-pressed', String(active));
      button.disabled = running !== null;
      button.hidden = fetched.has(key) && !active && !canFetch();
      const step = nextStep(cycle, key);
      const action = step === 'undo' ? `Undo ${names[key].toLowerCase()} sorting; restore the order before this cycle.`
        : `Sort upcoming videos ${descriptions[key][step]}.`;
      button.setAttribute('aria-label', action);
      const scope = snapshot?.total !== null && snapshot?.total !== undefined && snapshot.total > snapshot.items.length
        ? `Loaded ${snapshot.items.length} of ${snapshot.total}; only loaded upcoming videos are sorted.`
        : `${upcoming.length} upcoming loaded videos.`;
      button.title = problem || [action, 'Current video stays fixed.', scope,
        saved ? 'Native playlist moves can also change the saved playlist order.' : '',
        settings.dedupe && step !== 'undo' ? 'Repeated upcoming videos are removed first.' : '',
      ].filter(Boolean).join(' ');
    }
    if (!removeWatched.dataset.running) {
      const count = snapshot ? watchedIds(snapshot.items, snapshot.currentIndex).length : 0;
      removeWatched.textContent = 'Remove watched';
      removeWatched.disabled = running !== null || count === 0;
      const action = count === 0 ? 'No loaded videos show watch progress.'
        : `Remove ${plural(count, 'video')} that YouTube shows as started from this ${saved ? 'saved playlist' : 'queue'}. The current video stays.`;
      removeWatched.setAttribute('aria-label', problem || action);
      removeWatched.title = problem || action;
    }
  }

  /** Run one queue action at a time; a second click on its button stops it. */
  async function run(button: HTMLButtonElement, stopLabel: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (button.dataset.running === 'true') { running?.abort(); return; }
    if (running) { report('Another queue action is running.', true); return; }
    const abort = new AbortController();
    running = abort;
    button.dataset.running = 'true';
    button.textContent = 'Stop';
    button.title = stopLabel;
    button.setAttribute('aria-label', stopLabel);
    button.disabled = false;
    refreshControls();
    try {
      settings = loadSettings();
      await action(abort.signal);
    } catch (error) {
      report(abort.signal.aborted ? 'Stopped. Completed changes remain applied.' :
        error instanceof Error ? error.message : String(error), !abort.signal.aborted);
      if (!abort.signal.aborted) console.warn('[YouTube Up Next Sort]', error);
    } finally {
      running = null;
      delete button.dataset.running;
      refreshControls();
    }
  }

  function confirmed(count: number, signal: AbortSignal): Promise<boolean> {
    confirmText.textContent = `Remove ${plural(count, 'video')} from this saved playlist? This cannot be undone.`;
    confirmBar.hidden = false;
    return new Promise(resolve => {
      const done = new AbortController();
      const finish = (answer: boolean): void => {
        done.abort();
        confirmBar.hidden = true;
        resolve(answer);
      };
      confirmYes.addEventListener('click', () => finish(true), { signal: done.signal });
      confirmNo.addEventListener('click', () => finish(false), { signal: done.signal });
      signal.addEventListener('abort', () => finish(false), { signal: done.signal });
    });
  }

  /** Remove through YouTube; saved playlists ask first. False when declined. */
  async function remove(snapshot: Snapshot, targets: string[], signal: AbortSignal): Promise<boolean> {
    if (!snapshot.playlistId.startsWith('TLPQ') && !(await confirmed(targets.length, signal))) {
      signal.throwIfAborted();
      return false;
    }
    await removeItems(panel, snapshot, targets, signal, report);
    return true;
  }

  for (const [key, button] of buttons) button.addEventListener('click', () => run(button, 'Stop sorting', async signal => {
    report('Reading upcoming videos…');
    let attempted: { playlistId: string; cycle: Cycle } | undefined;
    try {
      let snapshot = readSnapshot(panel);
      const existing = matchingCycle(snapshot);
      const step = nextStep(existing, key);
      let baseline = existing?.key === key ? existing.baseline : ids(snapshot);
      const repeats = step !== 'undo' && settings.dedupe ? duplicateIds(snapshot.items, snapshot.currentIndex) : [];
      if (repeats.length > 0) {
        if (!(await remove(snapshot, repeats, signal))) { report('Cancelled. Nothing was changed.'); return; }
        snapshot = readSnapshot(panel);
        baseline = baseline.filter(id => !repeats.includes(id));
      }
      const removedNote = repeats.length > 0 ? `Removed ${plural(repeats.length, 'repeated video')}. ` : '';
      let items = snapshot.items;
      const upcomingIds = new Set(ids(snapshot).slice(snapshot.currentIndex + 1));
      if (upcomingIds.size < 2) {
        report(`${removedNote}Load at least two upcoming videos to sort.`, true);
        return;
      }
      if (step !== 'undo' && fetched.has(key)) {
        if (!canFetch()) throw new Error('Turn on fetching and enter an API key in the sort settings.');
        report('Fetching video details…');
        const stats = await fetchStats(items.filter(item => upcomingIds.has(item.id)).map(item => item.videoId), settings.apiKey, signal);
        items = items.map(item => ({ ...item, ...stats.get(item.videoId) }));
      }
      if (step !== 'undo' && items.every(item => !upcomingIds.has(item.id) || unknown(item, key))) {
        report(`${removedNote}No ${plurals[key]} are available for the upcoming videos.`, true);
        return;
      }
      const byId = new Map(items.map(item => [item.id, item]));
      const target = step === 'undo' ? baseline : sortUpcoming(
        baseline.map(id => byId.get(id)!), snapshot.currentIndex, key, step,
      ).map(item => item.id);
      const cycle: Cycle = { key, phase: 'partial', baseline, expected: ids(snapshot),
        currentIndex: snapshot.currentIndex, currentId: snapshot.items[snapshot.currentIndex]!.id };
      cycles.set(snapshot.playlistId, cycle);
      attempted = { playlistId: snapshot.playlistId, cycle };
      const moves = await reorderPanel(panel, snapshot, target, signal, report);
      if (step === 'undo') {
        cycles.delete(snapshot.playlistId);
        report('Restored the order from before this sort cycle.');
      } else {
        cycle.phase = step;
        cycle.expected = target;
        report(`Sorted loaded upcoming videos ${descriptions[key][step]} (${moves} native moves). ${removedNote}`.trim());
      }
    } catch (error) {
      if (attempted) {
        try {
          const after = readSnapshot(panel);
          const { cycle } = attempted;
          const order = ids(after);
          // Keep a usable undo after interruption only when the same queue,
          // current occurrence, membership, and fixed prefix still exist.
          if (after.playlistId === attempted.playlistId && after.currentIndex === cycle.currentIndex &&
              order.length === cycle.baseline.length && order.every(id => cycle.baseline.includes(id)) &&
              sameOrder(order.slice(0, after.currentIndex + 1), cycle.baseline.slice(0, after.currentIndex + 1))) {
            cycle.expected = order;
          } else cycles.delete(attempted.playlistId);
        } catch { cycles.delete(attempted.playlistId); }
      }
      throw error;
    }
  }));
  removeWatched.addEventListener('click', () => run(removeWatched, 'Stop removing', async signal => {
    report('Reading the queue…');
    const snapshot = readSnapshot(panel);
    const watched = watchedIds(snapshot.items, snapshot.currentIndex);
    if (watched.length === 0) { report('No loaded videos show watch progress.', true); return; }
    if (!(await remove(snapshot, watched, signal))) { report('Cancelled. Nothing was changed.'); return; }
    report(`Removed ${plural(watched.length, 'watched video')}.`);
  }));
  panel.prepend(host); // Outside #items: native drop computes indices from childNodes.
  controls.set(host, describe);
  describe();
  panel.addEventListener('yt-rendererstamper-finished', () => { if (!running) describe(); });
}

let scheduled = false;
function scan(): void {
  scheduled = false;
  document.querySelectorAll<HTMLElement>('ytd-playlist-panel-renderer').forEach(mount);
  if (!running) refreshControls();
}
const observer = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(scan, 250);
});
observer.observe(document.body, { childList: true, subtree: true });
document.addEventListener('yt-navigate-start', () => { running?.abort(); cycles.clear(); });
document.addEventListener('yt-navigate-finish', scan);
scan();
