/**
 * Warnings grouped by code (SPEC-4 §6.3, §6.5): one expandable group per
 * code with its count; each warning shows its message, where it is
 * (workspace › board names from the preview) and its exact snapshot path.
 * Long groups draw MAX_SHOWN warnings until "Show all" is pressed. Groups
 * that say the scan stopped at a limit come first and start open.
 *
 * `warningsList({ warnings, preview })` → element.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { icon } from "../components/icon.js";
import { groupWarnings, locate } from "./warnings.js";

export const MAX_SHOWN = 50;

function warningItem(item, preview) {
  const { label, rest } = locate(item.path, preview);
  return h(
    "li",
    { class: "import-warning" },
    h("p", { class: "import-warning-message" }, item.message),
    item.path
      ? h(
          "p",
          { class: "import-warning-where" },
          label ? h("span", { class: "import-warning-place" }, label) : null,
          label && rest ? h("span", { "aria-hidden": "true" }, " · ") : null,
          h(
            "code",
            { class: "import-warning-path", title: item.path },
            label ? rest || item.path : item.path,
          ),
        )
      : null,
  );
}

function groupBlock(group, preview) {
  const list = h("ul", { class: "import-warning-items" });
  const draw = (all) => {
    const items = all ? group.items : group.items.slice(0, MAX_SHOWN);
    list.replaceChildren(...items.map((item) => warningItem(item, preview)));
  };
  draw(false);
  const more =
    group.items.length > MAX_SHOWN
      ? button({
          label: `Show all ${group.items.length}`,
          size: "sm",
          variant: "ghost",
          onClick: (event) => {
            draw(true);
            event.currentTarget.remove();
          },
        })
      : null;
  return h(
    "li",
    { class: "import-warning-group" },
    h(
      "details",
      { open: group.limit },
      h(
        "summary",
        { class: "import-warning-summary" },
        icon("chevronRight", { size: 14, className: "import-warning-chevron" }),
        h("span", { class: "import-warning-title" }, group.title),
        h("span", { class: "import-warning-count" }, String(group.count)),
        // The title says it already; the code is for the download and support.
        h(
          "code",
          { class: "import-warning-code", "aria-hidden": "true" },
          group.code,
        ),
      ),
      list,
      more,
    ),
  );
}

/** Builds the grouped list (see the module comment). */
export function warningsList({ warnings, preview = null }) {
  const groups = groupWarnings(warnings);
  if (groups.length === 0) {
    return h(
      "p",
      { class: "import-no-warnings" },
      icon("check", { size: 16 }),
      h("span", null, "No warnings: everything maps exactly."),
    );
  }
  return h(
    "ul",
    { class: "import-warning-groups" },
    groups.map((group) => groupBlock(group, preview)),
  );
}
