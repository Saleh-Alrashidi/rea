/**
 * Step 5, "Done" (SPEC-4 §6.5): created counts, links to the new
 * workspaces, boards and docs, what was not imported and why, the full
 * warning list (grouped, and downloadable as a `.txt` made in the browser
 * from a Blob URL that is revoked once the download started) and
 * "Import more". Long lists of links and of what was not imported show
 * their first entries until "Show all" (`collapsibleList`), and the
 * actions sit under the summary as well as at the end.
 *
 * `doneStep({ state, onMore })` → `{ element, focusTarget }`.
 */

import { h } from "../../dom.js";
import { button, linkButton } from "../components/button.js";
import { icon } from "../components/icon.js";
import {
  createdTiles,
  doneSummary,
  linkSections,
  skippedSections,
} from "./report-model.js";
import {
  collapsibleList,
  importPanel,
  messageBanner,
  stepHeading,
} from "./step-parts.js";
import { warningsFileName, warningsText } from "./warnings.js";
import { warningsList } from "./warnings-view.js";

/**
 * Saves `text` as `fileName` through a temporary Blob URL. The anchor is
 * built with DOM properties (blob: URLs are not page links, so `h()`'s
 * URL check does not apply) and the URL is revoked after the click.
 */
export function downloadText(text, fileName) {
  const doc = globalThis.document;
  const url = globalThis.URL.createObjectURL(
    new globalThis.Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  doc.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 0);
  }
}

function tiles(report) {
  return h(
    "ul",
    { class: "import-tiles", "aria-label": "Created" },
    createdTiles(report.created).map((tile) =>
      h(
        "li",
        { class: ["stat-tile", "import-tile", tile.value === 0 && "empty"] },
        h("span", { class: "stat-icon" }, icon(tile.icon, { size: 18 })),
        h(
          "span",
          { class: "stat-text" },
          h(
            "span",
            { class: "stat-value" },
            tile.value.toLocaleString("en-US"),
          ),
          h("span", { class: "stat-label" }, tile.label),
        ),
      ),
    ),
  );
}

function linksBody(report) {
  const sections = linkSections(report.links);
  if (sections.length === 0) {
    return h("p", { class: "muted" }, "Nothing was created.");
  }
  return sections.map((section) =>
    h(
      "div",
      { class: "import-link-section" },
      h("h4", { class: "import-link-heading" }, section.title),
      collapsibleList(
        section.links.map((link) =>
          h(
            "li",
            null,
            h(
              "a",
              // Long titles are cut with an ellipsis; the title shows all.
              { class: "import-link", href: link.href, title: link.title },
              icon(section.icon, { size: 14 }),
              h("span", null, link.title),
              icon("arrowRight", { size: 14, className: "import-link-arrow" }),
            ),
          ),
        ),
        { class: "import-links" },
      ),
    ),
  );
}

function skippedPanel(report) {
  const sections = skippedSections(report.skipped);
  if (sections.length === 0) return null;
  const total = sections.reduce((sum, s) => sum + s.entries.length, 0);
  return importPanel({
    id: "import-skipped",
    title: "Not imported",
    iconName: "info",
    count: String(total),
    body: sections.map((section) =>
      h(
        "details",
        {
          class: "import-skipped",
          open: section.reason !== "skipped" && section.reason !== "excluded",
        },
        h(
          "summary",
          { class: "import-warning-summary" },
          icon("chevronRight", {
            size: 14,
            className: "import-warning-chevron",
          }),
          h("span", { class: "import-warning-title" }, section.title),
          h(
            "span",
            { class: "import-warning-count" },
            String(section.entries.length),
          ),
        ),
        collapsibleList(
          section.entries.map((entry) =>
            h(
              "li",
              { class: "import-warning" },
              h(
                "p",
                { class: "import-warning-message" },
                `${entry.kindName}: ${entry.name}`,
              ),
            ),
          ),
          { class: "import-warning-items" },
        ),
      ),
    ),
  });
}

/** Builds the step (see the module comment). */
export function doneStep({ state, onMore }) {
  const { report, preview } = state;
  const summary = doneSummary(report);
  const heading = stepHeading(summary.title);
  const download = button({
    label: "Download warnings (.txt)",
    icon: "copy",
    size: "sm",
    onClick: () =>
      downloadText(
        warningsText({
          warnings: report.warnings,
          preview,
          title: `Worklane import from ${preview?.source_label ?? "a source"}`,
        }),
        warningsFileName(preview?.source_label),
      ),
  });
  const first = linkSections(report.links).find((s) => s.kind === "board")
    ?.links[0];
  const actions = () =>
    h(
      "div",
      { class: "import-actions" },
      first
        ? linkButton({
            label: `Open “${first.title}”`,
            href: first.href,
            icon: "grid",
          })
        : null,
      button({
        label: "Import more",
        icon: "plus",
        variant: "primary",
        onClick: onMore,
      }),
    );
  const element = h(
    "section",
    {
      class: "import-step import-step-done",
      "aria-labelledby": "import-step-title",
    },
    heading,
    messageBanner({
      tone: report.cancelled ? "warning" : "success",
      text: summary.text,
    }),
    actions(),
    tiles(report),
    importPanel({
      id: "import-links",
      title: "Open what was imported",
      iconName: "open",
      body: linksBody(report),
    }),
    skippedPanel(report),
    importPanel({
      id: "import-done-warnings",
      title: "Warnings",
      iconName: "alert",
      count: String(report.warnings.length),
      tools: report.warnings.length > 0 ? download : null,
      body: warningsList({ warnings: report.warnings, preview }),
    }),
    actions(),
  );
  return { element, focusTarget: heading };
}
