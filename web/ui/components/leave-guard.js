/**
 * Keeps a page's unsaved work when the tab is hidden, reloaded or closed,
 * the one place pages register `visibilitychange`, `pagehide` and
 * `beforeunload` for that.
 *
 * - The tab is hidden (switching tabs, minimizing, the first step of closing
 *   on mobile): `flush()` starts saving, as a later close may give no chance.
 * - `pagehide`: `flush()` once more for edits typed since.
 * - `beforeunload` while `unsaved()`: `flush()` and ask the browser to
 *   confirm leaving, so the save can finish while the prompt is open.
 *
 * In-app navigation is not covered here: pages flush in their cleanup, and a
 * page without autosave asks through `ctx.router.guard`.
 */

/**
 * @param {{ unsaved(): boolean, flush?: () => unknown,
 *   onVisible?: () => void }} options `flush` saves pending edits (pages
 *   with an explicit Save button omit it); `onVisible` runs when the tab is
 *   shown again.
 * @returns {() => void} removes the listeners
 */
export function guardUnsaved({ unsaved, flush = null, onVisible = null }) {
  const doc = globalThis.document;
  const save = () => {
    if (flush && unsaved()) flush();
  };
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") save();
    else onVisible?.();
  };
  const onBeforeUnload = (event) => {
    if (!unsaved()) return;
    save();
    event.preventDefault();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener("pagehide", save);
  globalThis.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    globalThis.removeEventListener("pagehide", save);
    globalThis.removeEventListener("beforeunload", onBeforeUnload);
  };
}
