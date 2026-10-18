/**
 * The lifecycle of a board view that owns its data (Activity, Forms): a
 * placeholder while the first load runs, the ready content afterwards and
 * a "Try again" message when the first load fails (a later failure keeps
 * the last content). The board's change events reload it, debounced;
 * results that arrive after a newer load started or after `destroy()` are
 * discarded.
 */

import { renderMessage } from "../components/empty-state.js";

const RELOAD_DELAY_MS = 400;

/**
 * @param {HTMLElement} root
 * @param {{ load(): Promise<unknown>, placeholder(): Node,
 *   ready(data: unknown): Node, failure: string, label: string }} options
 *   `load()` fetches the data; `failure` is the error title; `label` names
 *   the data in console errors.
 * @returns {{ emit(type: string, data: unknown): boolean, reload(): void,
 *   render(): void, destroy(): void }}
 */
export function mountLiveView(root, options) {
  let status = "loading";
  let data = null;
  let destroyed = false;
  let timer = null;
  let sequence = 0;

  function render() {
    if (destroyed) return;
    if (status === "ready") {
      root.replaceChildren(options.ready(data));
    } else if (status === "error") {
      renderMessage(root, {
        iconName: "alert",
        title: options.failure,
        text: "Check your connection and try again.",
        action: { label: "Try again", onClick: () => reload() },
      });
    } else {
      root.replaceChildren(options.placeholder());
    }
  }

  async function reload() {
    const current = (sequence += 1);
    try {
      const next = await options.load();
      if (destroyed || current !== sequence) return;
      data = next;
      status = "ready";
    } catch (error) {
      if (destroyed || current !== sequence) return;
      globalThis.console?.error?.(`${options.label} unavailable`, error);
      if (status !== "ready") status = "error";
    }
    render();
  }

  render();
  reload();
  return {
    /** Board change events schedule a reload; returns whether it did. */
    emit(type) {
      if (type !== "events" || destroyed) return false;
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(reload, RELOAD_DELAY_MS);
      return true;
    },
    reload,
    render,
    destroy() {
      destroyed = true;
      globalThis.clearTimeout(timer);
      root.replaceChildren();
    },
  };
}
