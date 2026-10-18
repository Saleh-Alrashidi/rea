/**
 * What a job's progress (`{ phase, done, total, message }`, SPEC-4 §3 and
 * the engine's run) looks like on the scanning and importing steps: a
 * phase title, a determinate or indeterminate bar, a count line and the
 * connector's own message. Pure, so the view only draws it.
 *
 * `announcement` is the text of the polite live region: it changes only
 * when the phase changes, so screen readers hear "Reading items" once,
 * not every count update (the bar's `aria-valuetext` carries the count).
 */

const SCAN_PHASES = Object.freeze({
  starting: "Starting",
  account: "Connecting",
  users: "Reading people",
  workspaces: "Reading workspaces",
  boards: "Finding boards and lists",
  items: "Reading items",
  docs: "Reading docs",
  reading: "Reading the file",
  converting: "Converting rows to items",
  done: "Scan finished",
});

const IMPORT_PHASES = Object.freeze({
  starting: "Starting",
  boards: "Importing boards",
  docs: "Importing docs",
  done: "Import finished",
});

/** What `done`/`total` count, per scan phase and source. */
const SCAN_UNITS = Object.freeze({
  items: { monday: "boards", clickup: "lists" },
  users: { monday: "people", clickup: "people" },
  converting: { csv: "rows", xlsx: "rows" },
});

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

function phaseTitle(phase, kind) {
  const table = kind === "import" ? IMPORT_PHASES : SCAN_PHASES;
  if (Object.hasOwn(table, phase)) return table[phase];
  const text = String(phase ?? "").replaceAll("_", " ");
  return text ? text[0].toUpperCase() + text.slice(1) : "Working";
}

function unitOf(phase, { kind, source }) {
  if (kind === "import") return "boards and docs";
  return SCAN_UNITS[phase]?.[source] ?? "";
}

/**
 * @param {{ phase?: string, done?: number | null, total?: number | null,
 *   message?: string | null } | null} progress
 * @param {{ kind: "scan" | "import", source?: string | null }} context
 * @returns {{ title: string, percent: number | null, countText: string,
 *   message: string, valueText: string, announcement: string }}
 */
export function progressView(progress, { kind, source = null }) {
  const phase = progress?.phase ?? "starting";
  const title = phaseTitle(phase, kind);
  const done = count(progress?.done);
  const total = count(progress?.total);
  const known = done !== null && total !== null && total > 0;
  const percent = known
    ? Math.min(100, Math.round((done / total) * 100))
    : null;
  const unit = unitOf(phase, { kind, source });
  let countText = "";
  if (known) countText = `${done} of ${total}${unit ? ` ${unit}` : ""}`;
  else if (done !== null && done > 0)
    countText = `${done}${unit ? ` ${unit}` : ""} so far`;
  const message = typeof progress?.message === "string" ? progress.message : "";
  const valueText = [title, countText].filter(Boolean).join(": ");
  return { title, percent, countText, message, valueText, announcement: title };
}
