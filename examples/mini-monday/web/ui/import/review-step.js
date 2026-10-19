/**
 * Step 3, "Review" (SPEC-4 §6.3): what the scan found (the tree with
 * include checkboxes, counts and target workspaces), the people table,
 * the warnings grouped by code, and "Import" with a sentence that sums
 * up the plan. The plan's choices live in `selection` (`plan-model.js`);
 * a refused or failed import shows its message and, for an invalid plan,
 * each problem with its path. A scan that stopped at a limit says so
 * first; a scan that found nothing says so instead of offering Import.
 * "Skip to Import" (shown on keyboard focus) jumps past the long lists.
 *
 * `reviewStep({ state, selection, people, onImport, onBack })` →
 * `{ element, update(state), focusTarget }`.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { peopleTable } from "./people-table.js";
import { summarize, summaryText } from "./plan-model.js";
import { hasContent, reviewTree } from "./review-tree.js";
import { importPanel, messageBanner, stepHeading } from "./step-parts.js";
import { limitWarnings } from "./warnings.js";
import { warningsList } from "./warnings-view.js";

const number = (value) => (value ?? 0).toLocaleString("en-US");
const counted = (value, noun, plural = `${noun}s`) =>
  `${number(value)} ${value === 1 ? noun : plural}`;

function foundText(preview) {
  const { totals } = preview;
  const parts = [
    counted(totals.workspaces, "Space"),
    counted(totals.boards, "board"),
    counted(totals.items, "item"),
  ];
  if (totals.subitems > 0) parts.push(counted(totals.subitems, "subitem"));
  if (totals.updates > 0) parts.push(counted(totals.updates, "update"));
  parts.push(
    counted(totals.docs, "doc"),
    counted(totals.users, "person", "people"),
  );
  const cut = limitWarnings(preview.warnings).length > 0;
  const found = `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${preview.source_label}: found ${found}${cut ? " (the scan stopped at a limit)" : ""}.`;
}

function errorBanner(error) {
  if (!error) return "";
  const details = (error.errors ?? [])
    .slice(0, 10)
    .map((entry) => `${entry.path}: ${entry.message}`);
  if (error.detail) details.unshift(error.detail);
  return messageBanner({ tone: "danger", text: error.message, details });
}

/** The scan stopped before it read everything: say so before anything. */
function limitBanner(preview) {
  const cut = limitWarnings(preview.warnings);
  if (cut.length === 0) return null;
  return messageBanner({
    tone: "warning",
    text: "The scan stopped at a limit, so this is only part of the source. Scan again with higher limits, or import it in parts.",
    details: cut.slice(0, 3).map((warning) => warning.message),
  });
}

function drawFooter(r) {
  const summary = summarize(r.selection, r.state.preview);
  r.summary.textContent = r.empty
    ? "There is nothing to import from this scan."
    : summaryText(summary);
  const label = r.importButton.querySelector(".btn-label");
  label.textContent = r.state.pending ? "Starting…" : "Import";
  const blocked = summary.empty || r.state.pending;
  r.importButton.setAttribute("aria-disabled", blocked ? "true" : "false");
  r.importButton.title = summary.empty
    ? "Choose at least one board or doc"
    : "";
  r.back.disabled = r.state.pending;
  r.blocked = blocked;
}

/** Builds the step (see the module comment). */
export function reviewStep({ state, selection, people, onImport, onBack }) {
  const { preview } = state;
  const r = { state, selection, blocked: false, empty: !hasContent(preview) };
  const heading = stepHeading("Review what to import");
  const onChange = () => drawFooter(r);
  const tree = reviewTree({ preview, selection, onChange });
  const table = peopleTable({ preview, selection, people, onChange });
  r.banner = h(
    "div",
    { class: "import-banner-slot" },
    errorBanner(state.error),
  );
  r.summary = h("p", { class: "import-summary", "aria-live": "polite" });
  r.importButton = button({
    label: "Import",
    icon: "inbox",
    variant: "primary",
    className: "import-run",
    onClick: () => {
      if (!r.blocked) onImport();
    },
  });
  r.back = button({
    label: "Back",
    icon: "chevronLeft",
    // With nothing to import, going back is the way on.
    variant: r.empty ? "primary" : "ghost",
    onClick: () => onBack(),
  });
  r.importButton.hidden = r.empty;
  const skip = button({
    label: r.empty ? "Skip to Back" : "Skip to Import",
    size: "sm",
    variant: "secondary",
    className: "import-skip",
    onClick: () => (r.empty ? r.back : r.importButton).focus(),
  });
  const element = h(
    "section",
    {
      class: "import-step import-step-review",
      "aria-labelledby": "import-step-title",
    },
    heading,
    skip,
    h("p", { class: "import-step-text" }, foundText(preview)),
    limitBanner(preview),
    r.banner,
    importPanel({
      id: "import-content",
      title: "Boards and docs",
      iconName: "grid",
      body: tree.element,
    }),
    importPanel({
      id: "import-people",
      title: "People",
      iconName: "users",
      count: table.counts,
      body: table.element,
    }),
    importPanel({
      id: "import-warnings",
      title: "Warnings",
      iconName: "alert",
      count: String(preview.warnings.length),
      body: warningsList({ warnings: preview.warnings, preview }),
    }),
    h(
      "div",
      { class: "import-footer" },
      r.summary,
      h("div", { class: "import-actions" }, r.back, r.importButton),
    ),
  );
  drawFooter(r);
  return {
    element,
    focusTarget: heading,
    update(next) {
      const errorChanged = next.error !== r.state.error;
      r.state = next;
      if (errorChanged) {
        r.banner.replaceChildren(errorBanner(next.error));
      }
      drawFooter(r);
    },
  };
}
