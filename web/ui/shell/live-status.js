/**
 * The "Live updates paused" banner. A live-update stream the app relies
 * on can be refused (the server allows a user a fixed number of open
 * streams and answers 429) or end for good (the session ended); nothing
 * on the page would change on its own after that, so instead of stopping
 * silently the shell shows a banner with a "Reload" button until every
 * paused stream is resumed or the page reloads. It sits in the page flow
 * under the top bar (`index.html`, a "Live updates" region), so it covers
 * no control, comes early in the Tab order and stays under the drawer.
 *
 * Streams report through the bus (`BUS_EVENTS.live`, `{ key, paused }`):
 * the user stream as "me" (`main.js`), an open board as "board:<id>"
 * (the board page, which resumes it when it unmounts).
 *
 * ```js
 * const live = createLiveStatus({ element, reload });
 * live.set("board:12", true);   // shows the banner
 * live.set("board:12", false);  // hides it again
 * ```
 */

import { h } from "../../dom.js";
import { icon } from "../components/icon.js";

export const LIVE_PAUSED_TEXT = "Live updates paused";

/**
 * The paused-stream bookkeeping without DOM: `set(key, paused)` returns
 * whether any stream is paused afterwards. Exported for tests.
 */
export function pausedStreams() {
  const keys = new Set();
  return {
    set(key, paused) {
      if (paused) keys.add(String(key));
      else keys.delete(String(key));
      return keys.size > 0;
    },
    keys: () => [...keys],
  };
}

/**
 * Renders the banner into `element` (a `role="status"` region that stays
 * in the page, so the change is announced) while any stream is paused.
 * @param {{ element: HTMLElement, reload?: () => void }} options
 */
export function createLiveStatus({ element, reload }) {
  const streams = pausedStreams();
  const doReload = reload ?? (() => globalThis.location.reload());
  let shown = false;

  function render(paused) {
    if (paused === shown) return;
    shown = paused;
    element.classList.toggle("is-paused", paused);
    element.replaceChildren(
      paused
        ? h(
            "div",
            { class: "live-status-banner" },
            icon("alert", { size: 14 }),
            h("span", { class: "live-status-text" }, LIVE_PAUSED_TEXT),
            h(
              "button",
              {
                type: "button",
                class: "live-status-reload",
                on: { click: () => doReload() },
              },
              "Reload",
            ),
          )
        : "",
    );
  }

  return {
    set(key, paused) {
      render(streams.set(key, paused));
    },
    isShown: () => shown,
  };
}
