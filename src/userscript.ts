import { sameOrder, sortUpcoming, type Direction, type SortKey } from './sort.ts';
import { readSnapshot, reorderPanel, type Snapshot } from './youtube.ts';

const HOST_TAG = 'yt-up-next-duration-sort';
let running: AbortController | null = null;
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
const names: Record<SortKey, string> = { duration: 'Duration', title: 'Title', date: 'Date' };
const descriptions: Record<SortKey, Record<Direction, string>> = {
  duration: { asc: 'shortest to longest', desc: 'longest to shortest' },
  title: { asc: 'A to Z', desc: 'Z to A' },
  date: { asc: 'oldest to newest', desc: 'newest to oldest' },
};
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
  const root = host.attachShadow({ mode: 'open' });
  // YouTube enforces Trusted Types in page context. Build DOM nodes rather than
  // assigning HTML strings, which would throw before the control is attached.
  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; padding: 4px 8px; color: var(--yt-spec-text-secondary, #aaa); font: 11px/1.4 system-ui, sans-serif; }
    button { border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; padding: 3px 7px; margin-right: 4px; background: transparent; color: inherit; font: 400 11px/16px system-ui, sans-serif; cursor: pointer; }
    button[aria-pressed="true"] { color: var(--yt-spec-text-primary, #eee); }
    button:disabled { opacity: .5; cursor: default; }
    button[hidden] { display: none; }
    button:hover { background: var(--yt-spec-badge-chip-background, #333); color: var(--yt-spec-text-primary, #eee); }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .save { display: inline-flex; align-items: center; gap: 4px; vertical-align: top; }
    .save svg { width: 14px; height: 14px; fill: currentColor; }
    .notice { margin: 4px 0 0; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
  const buttons = new Map<SortKey, HTMLButtonElement>();
  for (const key of ['duration', 'title', 'date'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.sort = key;
    button.textContent = names[key];
    button.hidden = key === 'date';
    buttons.set(key, button);
  }
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.className = 'sr-only';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'save';
  save.hidden = true;
  root.append(style, save, ...buttons.values(), status);
  const report = (message: string, attention = false): void => {
    status.textContent = message;
    status.className = attention ? 'notice' : 'sr-only';
  };
  let hiddenRow: { row: HTMLElement; display: string } | undefined;
  let saveLook = '';
  save.addEventListener('click', event => {
    event.stopPropagation();
    nativeSave(panel)?.button.click();
  });

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
    for (const [key, button] of buttons) {
      if (button.dataset.running) continue;
      const active = cycle?.key === key;
      button.textContent = names[key] + (active ? cycle.phase === 'asc' ? ' ↑' : cycle.phase === 'desc' ? ' ↓' : ' ↶' : '');
      button.setAttribute('aria-pressed', String(active));
      button.disabled = running !== null;
      button.hidden = key === 'date' && !active && !(upcoming.length > 1 && upcoming.every(item => item.postedAt != null));
      const step = nextStep(cycle, key);
      const action = step === 'undo' ? `Undo ${names[key].toLowerCase()} sorting; restore the order before this cycle.`
        : `Sort upcoming videos ${descriptions[key][step]}.`;
      button.setAttribute('aria-label', action);
      const scope = snapshot?.total !== null && snapshot?.total !== undefined && snapshot.total > snapshot.items.length
        ? `Loaded ${snapshot.items.length} of ${snapshot.total}; only loaded upcoming videos are sorted.`
        : `${upcoming.length} upcoming loaded videos.`;
      button.title = problem || `${action} Current video stays fixed. ${scope} ${snapshot?.playlistId.startsWith('TLPQ') ? '' : 'Native playlist moves can also change the saved playlist order.'} ${key === 'date' ? 'Uses existing posting dates; relative ages are approximate.' : ''}`.trim();
    }
  }
  for (const [key, button] of buttons) button.addEventListener('click', async event => {
    event.stopPropagation();
    if (button.dataset.running === 'true') { running?.abort(); return; }
    if (running) { report('Another queue sort is running.', true); return; }
    const abort = new AbortController();
    running = abort;
    button.dataset.running = 'true';
    button.textContent = 'Stop';
    button.title = 'Stop sorting';
    button.setAttribute('aria-label', 'Stop sorting');
    refreshControls();
    report('Reading upcoming videos…');
    let attempted: { playlistId: string; cycle: Cycle } | undefined;
    try {
      const snapshot = readSnapshot(panel);
      const upcoming = snapshot.items.slice(snapshot.currentIndex + 1);
      const existing = matchingCycle(snapshot);
      const step = nextStep(existing, key);
      if (upcoming.length < 2) {
        report('Load at least two upcoming videos to sort.', true);
      } else if (step !== 'undo' && key === 'date' && upcoming.some(item => item.postedAt == null)) {
        report('Posting dates are not available for all loaded upcoming videos.', true);
      } else if (step !== 'undo' && upcoming.every(item => key === 'duration' ? item.duration === null : key === 'title' ? !item.title : false)) {
        report(`No ${key === 'title' ? 'titles' : 'durations'} are available yet.`, true);
      } else {
        const baseline = existing?.key === key ? existing.baseline : ids(snapshot);
        const byId = new Map(snapshot.items.map(item => [item.id, item]));
        const target = step === 'undo' ? baseline : sortUpcoming(
          baseline.map(id => byId.get(id)!), snapshot.currentIndex, key, step,
        ).map(item => item.id);
        const cycle: Cycle = { key, phase: 'partial', baseline, expected: ids(snapshot),
          currentIndex: snapshot.currentIndex, currentId: snapshot.items[snapshot.currentIndex]!.id };
        cycles.set(snapshot.playlistId, cycle);
        attempted = { playlistId: snapshot.playlistId, cycle };
        const moves = await reorderPanel(panel, snapshot, target, abort.signal, report);
        if (step === 'undo') {
          cycles.delete(snapshot.playlistId);
          report('Restored the order from before this sort cycle.');
        } else {
          cycle.phase = step;
          cycle.expected = target;
          report(`Sorted loaded upcoming videos ${descriptions[key][step]} (${moves} native moves).`);
        }
      }
    } catch (error) {
      report(abort.signal.aborted ? 'Stopped. Completed native moves remain applied.' :
        error instanceof Error ? error.message : String(error), !abort.signal.aborted);
      if (!abort.signal.aborted) console.warn('[YouTube Up Next Sort]', error);
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
    } finally {
      running = null;
      delete button.dataset.running;
      refreshControls();
    }
  });
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
