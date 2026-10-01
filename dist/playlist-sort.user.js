// ==UserScript==
// @name         YouTube Up Next — Shortest First
// @namespace    urn:kemus:youtube-up-next-sort
// @version      0.3.0
// @description  Sort upcoming videos by duration, title, or available posting date. Click to cycle ascending, descending, and undo.
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==
"use strict";
(() => {
  // src/sort.ts
  var titleOrder = new Intl.Collator(void 0, { numeric: true, sensitivity: "base" });
  function parseDuration(text) {
    const value = text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
    if (!/^\d+:\d{2}(?::\d{2})?$/.test(value)) return null;
    const parts = value.split(":").map(Number);
    if (parts.slice(1).some((part) => part >= 60)) return null;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }
  function parsePostedDate(text, now = Date.now()) {
    const value = text.trim();
    if (/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))?$/.test(value)) {
      const timestamp2 = Date.parse(value);
      return Number.isFinite(timestamp2) && timestamp2 <= now ? timestamp2 : null;
    }
    const relative = /^(?:(?:Streamed|Premiered)\s+)?(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(value);
    if (!relative) return null;
    const units = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
    const timestamp = now - Number(relative[1]) * units[relative[2].toLowerCase()] * 1e3;
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  function sortUpcoming(items, currentIndex, key = "duration", direction = "asc") {
    if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= items.length) {
      throw new Error("Cannot identify the currently playing item.");
    }
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new Error("YouTube did not provide unique queue item identifiers.");
    }
    const upcoming = items.slice(currentIndex + 1).map((item, index) => ({ item, index }));
    const value = (item) => key === "title" ? item.title?.trim() || null : key === "date" ? item.postedAt ?? null : item.duration;
    upcoming.sort((a, b) => {
      const left = value(a.item);
      const right = value(b.item);
      if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
      const comparison = typeof left === "string" && typeof right === "string" ? titleOrder.compare(left, right) : left < right ? -1 : left > right ? 1 : 0;
      return comparison * (direction === "asc" ? 1 : -1) || a.index - b.index;
    });
    return [...items.slice(0, currentIndex + 1), ...upcoming.map((entry) => entry.item)];
  }
  function sameOrder(left, right) {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  // src/youtube.ts
  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }
  function controllerOf(element) {
    return element.polymerController ?? element.inst ?? element;
  }
  function textOf(value) {
    const data = record(value);
    if (typeof data?.simpleText === "string") return data.simpleText;
    return Array.isArray(data?.runs) ? data.runs.map((run) => record(run)?.text ?? "").join("") : "";
  }
  function durationOf(data, row) {
    if (data.isLive === true || data.isLiveNow === true || data.upcomingEventData) return null;
    const overlays = Array.isArray(data.thumbnailOverlays) ? data.thumbnailOverlays : [];
    for (const overlay of overlays) {
      const badge = record(record(overlay)?.thumbnailOverlayTimeStatusRenderer);
      if (badge?.style === "LIVE" || badge?.style === "UPCOMING") return null;
    }
    const candidates = [textOf(data.lengthText), ...overlays.map((overlay) => textOf(record(record(overlay)?.thumbnailOverlayTimeStatusRenderer)?.text))];
    for (const badge of row.querySelectorAll("ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text")) {
      candidates.push(badge.textContent ?? "");
    }
    for (const candidate of candidates) {
      const seconds = parseDuration(candidate);
      if (seconds !== null) return seconds;
    }
    return null;
  }
  function postedDateOf(data, now) {
    for (const field of ["publishDate", "datePublished", "publishedTimeText"]) {
      const raw = data[field];
      const timestamp = parsePostedDate(typeof raw === "string" ? raw : textOf(raw), now);
      if (timestamp !== null) return timestamp;
    }
    return null;
  }
  function readSnapshot(panel) {
    if (!panel.isConnected) throw new Error("The queue panel was closed.");
    const controller = controllerOf(panel);
    const data = controller.data;
    if (!data || !Array.isArray(data.contents)) {
      throw new Error("Cannot read YouTube\u2019s queue. Enable page-context injection in your userscript manager and reload.");
    }
    if (controller.canReorder !== true || typeof controller.ytReorderableController?.handleDrop !== "function") {
      throw new Error("Native reordering is unavailable here. Open a queue or an editable playlist with drag handles.");
    }
    if (controller.shuffleOn === true) throw new Error("Turn off YouTube shuffle before sorting.");
    if (data.isInfinite === true) throw new Error("Radio/mix playlists are not supported by this prototype.");
    const playlistId = typeof data.playlistId === "string" ? data.playlistId : "";
    if (!playlistId) throw new Error("YouTube has not provided a queue identifier yet.");
    const container = panel.querySelector("#items");
    if (!container) throw new Error("Expand the queue panel first.");
    const rows = Array.from(container.children).filter((node) => node instanceof HTMLElement && node.tagName === "YTD-PLAYLIST-PANEL-VIDEO-RENDERER");
    const entries = data.contents.map((entry) => record(record(entry)?.playlistPanelVideoRenderer)).filter((entry) => entry !== void 0);
    if (rows.length === 0 || entries.length !== rows.length) {
      throw new Error("Wait for the loaded queue items to finish rendering, then try again.");
    }
    if (rows.some((row, index) => container.childNodes[index] !== row)) {
      throw new Error("Unsupported queue layout: video rows are not contiguous.");
    }
    const now = Date.now();
    const items = entries.map((entry, index) => {
      const row = rows[index];
      const rowData = row.data;
      const id = entry.playlistSetVideoId;
      if (typeof id !== "string" || !id || rowData?.playlistSetVideoId !== id) {
        throw new Error("Queue data and visible rows disagree. Wait for YouTube to finish updating.");
      }
      return {
        id,
        duration: durationOf(entry, row),
        title: textOf(entry.title).trim() || row.querySelector("#video-title")?.textContent?.trim() || null,
        postedAt: postedDateOf(entry, now)
      };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new Error("Queue occurrence identifiers are missing or duplicated.");
    }
    const selected = entries.flatMap((entry, index) => entry.selected === true ? [index] : []);
    if (selected.length !== 1 || data.currentIndex !== selected[0]) {
      throw new Error("Cannot locate the current video in the loaded queue. Try a short, fully loaded queue.");
    }
    const total = typeof data.totalVideos === "number" ? data.totalVideos : null;
    return { items, currentIndex: selected[0], playlistId, total, container, rows, controller };
  }
  var ids = (snapshot) => snapshot.items.map((item) => item.id);
  var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function checkSession(snapshot, initial) {
    if (snapshot.playlistId !== initial.playlistId || snapshot.currentIndex !== initial.currentIndex || snapshot.items[snapshot.currentIndex]?.id !== initial.items[initial.currentIndex]?.id) {
      throw new Error("Playback or the queue changed. Sorting stopped; completed moves remain applied.");
    }
  }
  async function reorderPanel(panel, initial, target, signal, report) {
    const original = ids(initial);
    if (target.length !== original.length || new Set(target).size !== target.length || target.some((id) => !original.includes(id)) || !sameOrder(target.slice(0, initial.currentIndex + 1), original.slice(0, initial.currentIndex + 1))) {
      throw new Error("The requested order no longer matches this queue.");
    }
    let expected = ids(initial);
    let moves = 0;
    for (let position = initial.currentIndex + 1; position < target.length; position++) {
      signal.throwIfAborted();
      const before = readSnapshot(panel);
      checkSession(before, initial);
      if (!sameOrder(ids(before), expected)) {
        throw new Error("The queue changed while sorting. Completed moves remain applied; try again.");
      }
      if (expected[position] === target[position]) continue;
      const from = expected.indexOf(target[position]);
      const row = before.rows[from];
      const oldNext = row.nextSibling;
      const nextOrder = [...expected];
      nextOrder.splice(position, 0, nextOrder.splice(from, 1)[0]);
      const reorder = before.controller.ytReorderableController;
      before.container.insertBefore(row, before.rows[position]);
      try {
        reorder.handleDrop({ currDragItem: row });
      } catch (error) {
        restoreVisualIfUnchanged(before, row, oldNext, expected);
        throw new Error(`YouTube\u2019s native move failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const deadline = Date.now() + 3500;
      let confirmed = false;
      try {
        while (Date.now() < deadline) {
          await delay(100);
          signal.throwIfAborted();
          let after;
          try {
            after = readSnapshot(panel);
          } catch {
            continue;
          }
          checkSession(after, initial);
          if (sameOrder(ids(after), nextOrder)) {
            confirmed = true;
            break;
          }
          if (!sameOrder(ids(after), expected)) {
            throw new Error("Unexpected queue change after a native move. Sorting stopped.");
          }
        }
      } catch (error) {
        restoreVisualIfUnchanged(before, row, oldNext, expected);
        throw error;
      }
      if (!confirmed) {
        restoreVisualIfUnchanged(before, row, oldNext, expected);
        throw new Error("YouTube did not confirm the move in its queue data. Sorting stopped.");
      }
      expected = nextOrder;
      moves++;
      report(`Sorting: ${position - initial.currentIndex}/${target.length - initial.currentIndex - 1} upcoming positions checked\u2026`);
      await delay(350);
    }
    signal.throwIfAborted();
    const final = readSnapshot(panel);
    checkSession(final, initial);
    if (!sameOrder(ids(final), target)) throw new Error("YouTube changed the order before verification finished. Try again.");
    return moves;
  }
  function restoreVisualIfUnchanged(before, row, oldNext, expected) {
    const contents = before.controller.data?.contents;
    if (!Array.isArray(contents) || row.parentNode !== before.container || oldNext && oldNext.parentNode !== before.container) return;
    const current = contents.flatMap((entry) => {
      const id = record(record(entry)?.playlistPanelVideoRenderer)?.playlistSetVideoId;
      return typeof id === "string" ? [id] : [];
    });
    if (sameOrder(current, expected)) before.container.insertBefore(row, oldNext);
  }

  // src/userscript.ts
  var HOST_TAG = "yt-up-next-duration-sort";
  var running = null;
  var cycles = /* @__PURE__ */ new Map();
  var controls = /* @__PURE__ */ new Map();
  var names = { duration: "Duration", title: "Title", date: "Date" };
  var descriptions = {
    duration: { asc: "shortest to longest", desc: "longest to shortest" },
    title: { asc: "A to Z", desc: "Z to A" },
    date: { asc: "oldest to newest", desc: "newest to oldest" }
  };
  var ids2 = (snapshot) => snapshot.items.map((item) => item.id);
  function matchingCycle(snapshot) {
    const cycle = cycles.get(snapshot.playlistId);
    return cycle && cycle.currentIndex === snapshot.currentIndex && cycle.currentId === snapshot.items[snapshot.currentIndex]?.id && sameOrder(cycle.expected, ids2(snapshot)) ? cycle : void 0;
  }
  function nextStep(cycle, key) {
    return cycle?.key !== key ? "asc" : cycle.phase === "asc" ? "desc" : "undo";
  }
  function refreshControls() {
    for (const [host, refresh] of controls) {
      if (host.isConnected) refresh();
      else controls.delete(host);
    }
  }
  function nativeSave(panel) {
    const row = panel.querySelector("#playlist-actions");
    if (!row) return null;
    const display = row.style.display;
    row.style.display = "";
    const controls2 = Array.from(row.querySelectorAll('button, a[href], [role="button"]')).filter((control) => control.getClientRects().length > 0);
    row.style.display = display;
    const button = controls2[0];
    return controls2.length === 1 && button instanceof HTMLButtonElement && button.textContent?.trim() && button.closest("#flexible-item-buttons ytd-button-renderer") ? { row, button } : null;
  }
  function mount(panel) {
    if (panel.querySelector(HOST_TAG)) return;
    const host = document.createElement(HOST_TAG);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
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
    const buttons = /* @__PURE__ */ new Map();
    for (const key of ["duration", "title", "date"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.sort = key;
      button.textContent = names[key];
      button.hidden = key === "date";
      buttons.set(key, button);
    }
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.className = "sr-only";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "save";
    save.hidden = true;
    root.append(style, save, ...buttons.values(), status);
    const report = (message, attention = false) => {
      status.textContent = message;
      status.className = attention ? "notice" : "sr-only";
    };
    let hiddenRow;
    let saveLook = "";
    save.addEventListener("click", (event) => {
      event.stopPropagation();
      nativeSave(panel)?.button.click();
    });
    function syncSave() {
      const native = nativeSave(panel);
      if (hiddenRow && hiddenRow.row !== native?.row) {
        hiddenRow.row.style.display = hiddenRow.display;
        hiddenRow = void 0;
      }
      save.hidden = !native;
      if (!native) return;
      if (!hiddenRow) {
        hiddenRow = { row: native.row, display: native.row.style.display };
        native.row.style.display = "none";
      }
      const label = native.button.textContent.trim();
      const icon = native.button.querySelector("svg");
      if (saveLook !== `${label}|${icon !== null}`) {
        saveLook = `${label}|${icon !== null}`;
        save.replaceChildren(...icon ? [icon.cloneNode(true)] : [], label);
      }
      save.setAttribute("aria-label", native.button.getAttribute("aria-label") || label);
      save.title = native.button.getAttribute("aria-label") || label;
      save.disabled = running !== null;
    }
    function describe() {
      syncSave();
      let snapshot;
      let problem = "";
      try {
        snapshot = readSnapshot(panel);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      const cycle = snapshot ? matchingCycle(snapshot) : void 0;
      const upcoming = snapshot?.items.slice(snapshot.currentIndex + 1) ?? [];
      for (const [key, button] of buttons) {
        if (button.dataset.running) continue;
        const active = cycle?.key === key;
        button.textContent = names[key] + (active ? cycle.phase === "asc" ? " \u2191" : cycle.phase === "desc" ? " \u2193" : " \u21B6" : "");
        button.setAttribute("aria-pressed", String(active));
        button.disabled = running !== null;
        button.hidden = key === "date" && !active && !(upcoming.length > 1 && upcoming.every((item) => item.postedAt != null));
        const step = nextStep(cycle, key);
        const action = step === "undo" ? `Undo ${names[key].toLowerCase()} sorting; restore the order before this cycle.` : `Sort upcoming videos ${descriptions[key][step]}.`;
        button.setAttribute("aria-label", action);
        const scope = snapshot?.total !== null && snapshot?.total !== void 0 && snapshot.total > snapshot.items.length ? `Loaded ${snapshot.items.length} of ${snapshot.total}; only loaded upcoming videos are sorted.` : `${upcoming.length} upcoming loaded videos.`;
        button.title = problem || `${action} Current video stays fixed. ${scope} ${snapshot?.playlistId.startsWith("TLPQ") ? "" : "Native playlist moves can also change the saved playlist order."} ${key === "date" ? "Uses existing posting dates; relative ages are approximate." : ""}`.trim();
      }
    }
    for (const [key, button] of buttons) button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (button.dataset.running === "true") {
        running?.abort();
        return;
      }
      if (running) {
        report("Another queue sort is running.", true);
        return;
      }
      const abort = new AbortController();
      running = abort;
      button.dataset.running = "true";
      button.textContent = "Stop";
      button.title = "Stop sorting";
      button.setAttribute("aria-label", "Stop sorting");
      refreshControls();
      report("Reading upcoming videos\u2026");
      let attempted;
      try {
        const snapshot = readSnapshot(panel);
        const upcoming = snapshot.items.slice(snapshot.currentIndex + 1);
        const existing = matchingCycle(snapshot);
        const step = nextStep(existing, key);
        if (upcoming.length < 2) {
          report("Load at least two upcoming videos to sort.", true);
        } else if (step !== "undo" && key === "date" && upcoming.some((item) => item.postedAt == null)) {
          report("Posting dates are not available for all loaded upcoming videos.", true);
        } else if (step !== "undo" && upcoming.every((item) => key === "duration" ? item.duration === null : key === "title" ? !item.title : false)) {
          report(`No ${key === "title" ? "titles" : "durations"} are available yet.`, true);
        } else {
          const baseline = existing?.key === key ? existing.baseline : ids2(snapshot);
          const byId = new Map(snapshot.items.map((item) => [item.id, item]));
          const target = step === "undo" ? baseline : sortUpcoming(
            baseline.map((id) => byId.get(id)),
            snapshot.currentIndex,
            key,
            step
          ).map((item) => item.id);
          const cycle = {
            key,
            phase: "partial",
            baseline,
            expected: ids2(snapshot),
            currentIndex: snapshot.currentIndex,
            currentId: snapshot.items[snapshot.currentIndex].id
          };
          cycles.set(snapshot.playlistId, cycle);
          attempted = { playlistId: snapshot.playlistId, cycle };
          const moves = await reorderPanel(panel, snapshot, target, abort.signal, report);
          if (step === "undo") {
            cycles.delete(snapshot.playlistId);
            report("Restored the order from before this sort cycle.");
          } else {
            cycle.phase = step;
            cycle.expected = target;
            report(`Sorted loaded upcoming videos ${descriptions[key][step]} (${moves} native moves).`);
          }
        }
      } catch (error) {
        report(abort.signal.aborted ? "Stopped. Completed native moves remain applied." : error instanceof Error ? error.message : String(error), !abort.signal.aborted);
        if (!abort.signal.aborted) console.warn("[YouTube Up Next Sort]", error);
        if (attempted) {
          try {
            const after = readSnapshot(panel);
            const { cycle } = attempted;
            const order = ids2(after);
            if (after.playlistId === attempted.playlistId && after.currentIndex === cycle.currentIndex && order.length === cycle.baseline.length && order.every((id) => cycle.baseline.includes(id)) && sameOrder(order.slice(0, after.currentIndex + 1), cycle.baseline.slice(0, after.currentIndex + 1))) {
              cycle.expected = order;
            } else cycles.delete(attempted.playlistId);
          } catch {
            cycles.delete(attempted.playlistId);
          }
        }
      } finally {
        running = null;
        delete button.dataset.running;
        refreshControls();
      }
    });
    panel.prepend(host);
    controls.set(host, describe);
    describe();
    panel.addEventListener("yt-rendererstamper-finished", () => {
      if (!running) describe();
    });
  }
  var scheduled = false;
  function scan() {
    scheduled = false;
    document.querySelectorAll("ytd-playlist-panel-renderer").forEach(mount);
    if (!running) refreshControls();
  }
  var observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-start", () => {
    running?.abort();
    cycles.clear();
  });
  document.addEventListener("yt-navigate-finish", scan);
  scan();
})();
