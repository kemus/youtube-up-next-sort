// ==UserScript==
// @name         YouTube Up Next — Shortest First
// @namespace    urn:kemus:youtube-up-next-sort
// @version      0.1.2
// @description  Sort loaded upcoming videos by duration using YouTube's native reorder handler.
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
  function parseDuration(text) {
    const value = text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
    if (!/^\d+:\d{2}(?::\d{2})?$/.test(value)) return null;
    const parts = value.split(":").map(Number);
    if (parts.slice(1).some((part) => part >= 60)) return null;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }
  function sortUpcoming(items, currentIndex) {
    if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= items.length) {
      throw new Error("Cannot identify the currently playing item.");
    }
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new Error("YouTube did not provide unique queue item identifiers.");
    }
    const upcoming = items.slice(currentIndex + 1).map((item, index) => ({ item, index }));
    upcoming.sort((a, b) => {
      const left = a.item.duration ?? Infinity;
      const right = b.item.duration ?? Infinity;
      return (left < right ? -1 : left > right ? 1 : 0) || a.index - b.index;
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
    const items = entries.map((entry, index) => {
      const row = rows[index];
      const rowData = row.data;
      const id = entry.playlistSetVideoId;
      if (typeof id !== "string" || !id || rowData?.playlistSetVideoId !== id) {
        throw new Error("Queue data and visible rows disagree. Wait for YouTube to finish updating.");
      }
      return { id, duration: durationOf(entry, row) };
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
  async function sortPanel(panel, signal, report) {
    const initial = readSnapshot(panel);
    const target = sortUpcoming(initial.items, initial.currentIndex).map((item) => item.id);
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
      report(`Shortest first: ${position - initial.currentIndex}/${target.length - initial.currentIndex - 1} upcoming positions checked\u2026`);
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
  function mount(panel) {
    if (panel.querySelector(HOST_TAG)) return;
    const host = document.createElement(HOST_TAG);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
    :host { display: block; padding: 4px 8px; color: var(--yt-spec-text-secondary, #aaa); font: 11px/1.4 system-ui, sans-serif; }
    button { border: 1px solid var(--yt-spec-10-percent-layer, #555); border-radius: 4px; padding: 3px 7px; background: transparent; color: inherit; font: 400 11px/16px system-ui, sans-serif; cursor: pointer; }
    button:hover { background: var(--yt-spec-badge-chip-background, #333); color: var(--yt-spec-text-primary, #eee); }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    .notice { margin: 4px 0 0; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  `;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Duration \u2191";
    button.setAttribute("aria-label", "Sort upcoming videos by duration, shortest first");
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.className = "sr-only";
    root.append(style, button, status);
    const report = (message, attention = false) => {
      status.textContent = message;
      status.className = attention ? "notice" : "sr-only";
    };
    function describe() {
      try {
        const snapshot = readSnapshot(panel);
        const upcoming = snapshot.items.length - snapshot.currentIndex - 1;
        const unknown = snapshot.items.slice(snapshot.currentIndex + 1).filter((item) => item.duration === null).length;
        const scope = snapshot.total !== null && snapshot.total > snapshot.items.length ? `Loaded ${snapshot.items.length} of ${snapshot.total}; unloaded items stay outside this sort.` : `${upcoming} upcoming loaded videos.`;
        button.title = `Sort shortest to longest; keep the current video fixed. ${scope} ${unknown ? `${unknown} live/unknown durations go last. ` : ""}${snapshot.playlistId.startsWith("TLPQ") ? "" : "Native playlist moves can also change the saved playlist order."}`.trim();
      } catch (error) {
        button.title = error instanceof Error ? error.message : String(error);
      }
    }
    button.addEventListener("click", async (event) => {
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
      report("Reading upcoming durations\u2026");
      try {
        const snapshot = readSnapshot(panel);
        if (snapshot.items.length - snapshot.currentIndex - 1 < 2) {
          report("Load at least two upcoming videos to sort.", true);
        } else if (snapshot.items.slice(snapshot.currentIndex + 1).every((item) => item.duration === null)) {
          report("No durations are available yet. Wait for the thumbnails and try again.", true);
        } else {
          const moves = await sortPanel(panel, abort.signal, report);
          report(moves ? `Sorted loaded upcoming videos, shortest first (${moves} native moves).` : "Upcoming videos are already shortest first.");
        }
      } catch (error) {
        report(abort.signal.aborted ? "Stopped. Completed native moves remain applied." : error instanceof Error ? error.message : String(error), !abort.signal.aborted);
        if (!abort.signal.aborted) console.warn("[YouTube Up Next Sort]", error);
      } finally {
        running = null;
        delete button.dataset.running;
        button.textContent = "Duration \u2191";
        button.setAttribute("aria-label", "Sort upcoming videos by duration, shortest first");
        describe();
      }
    });
    panel.prepend(host);
    describe();
    panel.addEventListener("yt-rendererstamper-finished", () => {
      if (!running) describe();
    });
  }
  var scheduled = false;
  function scan() {
    scheduled = false;
    document.querySelectorAll("ytd-playlist-panel-renderer").forEach(mount);
  }
  var observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-start", () => running?.abort());
  document.addEventListener("yt-navigate-finish", scan);
  scan();
})();
