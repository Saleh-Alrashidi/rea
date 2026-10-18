/**
 * The docs of the fake ClickUp account (`clickup-data.js`) in ClickUp's v3
 * shapes: "Engineering handbook" (public; nested pages with every
 * markdown construct), docs parented to a folder, a list, the whole
 * workspace and an unknown space, a deleted doc and 50 notes (two pages
 * of the docs listing).
 */
export const HANDBOOK_MARKDOWN = [
  "# Welcome",
  "Intro paragraph with **bold** text",
  "",
  "## Setup",
  "### Deep heading ###",
  "- Install Node",
  "* Clone the repo",
  "- [ ] Read the guide",
  "- [x] Get access",
  "1. First step",
  "2) Second step",
  "> Remember this",
  "---",
  "```js",
  "const x = 1;",
  "",
  "console.log(x);",
  "```",
  "Last line",
].join("\n");

/** The docs of team 9001 created at `T0` (epoch ms), with their page trees. */
export function clickupDocs(T0) {
  const page = (id, name, content, pages = []) => ({
    id,
    doc_id: id.split(".")[0],
    name,
    content,
    date_created: T0,
    pages,
  });
  const doc = ([id, name], parent, pages, extra = {}) => ({
    team_id: "9001",
    id,
    name,
    parent,
    public: false,
    deleted: false,
    archived: false,
    workspace_id: 9001,
    creator: 101,
    date_created: T0,
    type: 1,
    pages,
    ...extra,
  });
  const space = (id) => ({ id, type: 4 });
  const notes = Array.from({ length: 50 }, (_, n) =>
    doc([`8cnote-${n + 1}`, `Note ${n + 1}`], space("90010001"), [
      page(`8cnote-${n + 1}.p`, `Note ${n + 1}`, `Note body ${n + 1}`),
    ]),
  );
  return [
    doc(
      ["8chand-1", "Engineering handbook"],
      space("90010001"),
      [
        page("8chand-1.p1", "Engineering handbook", HANDBOOK_MARKDOWN, [
          page("8chand-1.p2", "Onboarding", "- [x] Laptop\r\n- [ ] Badge", [
            page("8chand-1.p3", "Day one", "Say hi"),
          ]),
        ]),
        page(
          "8chand-1.p4",
          "Release process",
          "1. Branch\n2. Ship\n~~~\nunclosed code",
        ),
      ],
      { public: true },
    ),
    doc(["8csecret-1", "Secret plan"], { id: "90011002", type: 5 }, [
      page("8csecret-1.p", "Plan", "Quiet"),
    ]),
    doc(["8chire-1", "Hiring rubric"], { id: "901105", type: 6 }, [
      page("8chire-1.p", "Rubric", "Be kind"),
    ]),
    doc(["8cwiki-1", "Company wiki"], { id: "9001", type: 12 }, [
      page("8cwiki-1.p", "Company wiki", "Hello"),
    ]),
    doc(["8clost-1", "Lost doc"], space("90019999"), []),
    doc(["8cgone-1", "Deleted doc"], space("90010001"), [], { deleted: true }),
    ...notes,
  ];
}
