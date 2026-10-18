/**
 * Step 3, "Review" (SPEC-4 §6.3): what the scan found (the tree with
 * include checkboxes, counts and target workspaces), the people table,
 * the warnings grouped by code, and "Import" with a sentence that sums
 * up the plan. The plan's choices live in `selection` (`plan-model.js`);
 * a refused or failed import shows its message and, for an invalid plan,
 * each problem with its path.
 *
 * `reviewStep({ state, selection, people, onImport, onBack })` →
 * `{ element, update(state), focusTarget }`.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { peopleTable } from "./people-table.js";
import { summarize, summaryText } from "./plan-model.js";
import { reviewTree } from "./review-tree.js";
import { importPanel, messageBanner, stepHeading } from "./step-parts.js";
import { warningsList } from "./warnings-view.js";

const number = (value) => (value ?? 0).toLocaleString("en-US");
const counted = (value, noun, plural = `${noun}s`) =>
  `${number(value)} ${value === 1 ? noun : plural}`;

function foundText(preview) {
  const { totals } = preview;
  const parts = [
    counted(totals.workspaces, "workspace"),
    counted(totals.boards, "board"),
    counted(totals.items, "item"),
  ];
  if (totals.subitems > 0) parts.push(counted(totals.subitems, "subitem"));
  if (totals.updates > 0) parts.push(counted(totals.updates, "update"));
  parts.push(
    counted(totals.docs, "doc"),
    counted(totals.users, "person", "people"),
  );
  return `${preview.source_label}: found ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
}

function errorBanner(error) {
  if (!error) return "";
  const details = (error.errors ?? [])
    .slice(0, 10)
    .map((entry) => `${entry.path}: ${entry.message}`);
  return messageBanner({ tone: "danger", text: error.message, details });
}

function drawFooter(r) {
  const summary = summarize(r.selection, r.state.preview);
  r.summary.textContent = summaryText(summary);
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
  const r = { state, selection, blocked: false };
  const { preview } = state;
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
    variant: "ghost",
    onClick: () => onBack(),
  });
  const element = h(
    "section",
    {
      class: "import-step import-step-review",
      "aria-labelledby": "import-step-title",
    },
    heading,
    h("p", { class: "import-step-text" }, foundText(preview)),
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
