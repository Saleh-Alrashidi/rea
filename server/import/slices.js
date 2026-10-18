/**
 * Cooperative time slicing for the importer's long synchronous work (file
 * parsing and conversion, snapshot validation), so one large scan never
 * stalls the server and a cancel is seen within one slice.
 *
 * The work is written once as a generator that `yield`s at cheap,
 * regular points (every few hundred rows or items, between columns). Then:
 *
 * - `drain(steps)` runs it to its end synchronously (the plain API);
 * - `drainSliced(steps, { signal, sliceMs })` runs it in slices of about
 *   `sliceMs` (default SLICE_MS) of work, yielding one event-loop turn
 *   (`setImmediate`) between slices and throwing ABORTED once `signal`
 *   fires.
 */
import { setImmediate as nextTurn } from "node:timers/promises";
import { ImportError } from "./engine.js";

export const SLICE_MS = 15;

export const aborted = () =>
  new ImportError("ABORTED", "The import was cancelled");

export function throwIfAborted(signal) {
  if (signal?.aborted) throw aborted();
}

/** Runs generator `steps` to its end and returns its result. */
export function drain(steps) {
  for (;;) {
    const { done, value } = steps.next();
    if (done) return value;
  }
}

/** Runs generator `steps` in slices (see the module comment). */
export async function drainSliced(
  steps,
  { signal = null, sliceMs = SLICE_MS } = {},
) {
  throwIfAborted(signal);
  let start = performance.now();
  for (;;) {
    const { done, value } = steps.next();
    if (done) return value;
    if (performance.now() - start < sliceMs) continue;
    await nextTurn();
    throwIfAborted(signal);
    start = performance.now();
  }
}
