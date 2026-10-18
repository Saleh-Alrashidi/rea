/**
 * Follows one import job until it ends (SPEC-4 §5 progress). Live
 * `event: import` messages (`push`) update the job at once; a poll of
 * `GET /import/jobs/<id>` runs whenever no message arrived for `interval`
 * ms, so the wizard keeps moving while the stream is down or was opened
 * after the job's first messages. A message that ends the job without
 * what its end shows (the preview, report or error) is followed by one
 * read of the full job.
 *
 * The first read happens at once: a short scan can end before its first
 * message reaches the page. A job the server no longer has (404) ends
 * the watch with `onGone`; other read failures are retried by the poll.
 */

import { isTerminal, needsDetails } from "./wizard.js";

export const POLL_INTERVAL_MS = 1500;

/**
 * @param {{ jobId: string, getJob: (id: string) => Promise<object>,
 *   onJob: (job: object) => void, onGone?: (id: string) => void,
 *   interval?: number, timers?: { setTimeout: Function,
 *   clearTimeout: Function } }} options
 * @returns {{ push(event: object): void, stop(): void,
 *   readonly stopped: boolean }}
 */
export function watchJob(options) {
  const { jobId, getJob, onJob, onGone = () => {} } = options;
  const interval = options.interval ?? POLL_INTERVAL_MS;
  const timers = options.timers ?? globalThis;
  const w = {
    stopped: false,
    timer: null,
    fresh: false,
    reading: null,
    again: false,
  };

  const stop = () => {
    w.stopped = true;
    if (w.timer !== null) timers.clearTimeout(w.timer);
    w.timer = null;
  };
  const deliver = (job) => {
    if (w.stopped) return;
    onJob(job);
    if (isTerminal(job.state) && !needsDetails(job)) stop();
  };
  const failed = (error) => {
    if (w.stopped || error?.status !== 404) return;
    stop();
    onGone(jobId);
  };
  // A read asked for while one is in flight runs after it: the earlier
  // answer may predate the message that asked.
  const read = () => {
    if (w.reading) {
      w.again = true;
      return w.reading;
    }
    w.reading = getJob(jobId)
      .then(deliver, failed)
      .finally(() => {
        w.reading = null;
        if (!w.again || w.stopped) return;
        w.again = false;
        read();
      });
    return w.reading;
  };
  const tick = () => {
    w.timer = null;
    if (w.stopped) return;
    const due = !w.fresh;
    w.fresh = false;
    const next = due ? read() : Promise.resolve();
    next.finally(() => {
      if (!w.stopped) w.timer = timers.setTimeout(tick, interval);
    });
  };

  read().finally(() => {
    if (!w.stopped && w.timer === null) {
      w.timer = timers.setTimeout(tick, interval);
    }
  });
  return {
    push(event) {
      if (w.stopped || event?.job_id !== jobId) return;
      w.fresh = true;
      const job = {
        id: event.job_id,
        kind: event.kind,
        state: event.state,
        progress: event.progress,
      };
      if (needsDetails(job)) {
        onJob(job);
        read();
      } else deliver(job);
    },
    stop,
    get stopped() {
      return w.stopped;
    },
  };
}
