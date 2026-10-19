# Worklane specification, part 5: ClickUp-style List view, task view and real subtasks

Parts 1–4 describe the product, hosting and the importer. Part 5 makes boards
imported from ClickUp look and work like ClickUp, starting with a meetings
list such as **"Weekly Meetings"**, without changing how monday-style boards
look by default. The reference board (real data, measured on the hosted
site; nothing from it is committed) has:

- 102 tasks: 63 top-level tasks and 39 subtasks, under 13 parents with 1–6
  subtasks each. One level deep.
- 17 columns:
  - The ClickUp **Status** holds departments ("facility", "psych dept",
    "slp dept", … "Closed"), each with its own color; 11 are in use.
  - Assignees (20 of 102 set), Due/Start dates (3–4 set), Priority (empty).
  - Time estimate and Tags (empty).
  - **Description** (49 set, up to 904 characters, multi-line).
  - A long-text custom field **"Minuts"** (69 set, up to 865 characters,
    multi-line).
  - A text field holding file names, a second dropdown "Status" (Working on
    it/Done/On hold/…), a numbers field "#", and a second, empty "Priority"
    dropdown.
- 470 comments: up to 30 per task, 251 with line breaks, 169 by authors
  without a Worklane account.
- Mostly English, with some Arabic (names, comments).

Rules from `AGENTS.md` apply:

- Fix the producing representation, not downstream repairs.
- Keep each fact's owner.
- Files ≤ 500 lines, functions ≤ 100 lines, complexity ≤ 20, ≤ 4 params,
  depth ≤ 4.
- `oxlint --max-warnings=0` and `oxfmt --check` must be clean.

## 1. Data model (server)

### 1.1 Real subitems

An item may have a parent item on the same board.

**Store (`server/store/items.js`, `boards.js`, `store-state.js`):**

- The item record gains optional `parent_id`. It is **absent** for top-level
  items, never null.
- Invariants, enforced on every write and checked on load:
  - The parent exists, is active, and is on the same board.
  - The parent is not the item itself.
  - There are no cycles.
  - Depth is at most `MAX_SUBITEM_DEPTH = 5`, where a top-level item has
    depth 0.
- A subitem may sit in a different group than its parent. ClickUp subtasks
  carry their own status, and moving a parent never moves its children.
- `createItem({ boardId, groupId, name, values, parentId })`: when `parentId`
  is given and no `groupId`, the child goes into the parent's group. A bad
  parent fails with `not_found` (unknown or not on this board) or
  `invalid_parent` (too deep).
- **Deleting cascades.** `removeItems` is the single removal owner. It also
  removes every descendant (and their updates), across groups, so no
  dangling `parent_id` can exist. This covers `deleteItem`, `deleteGroup`
  and board deletion.
  - `deleteItem` logs one `item_deleted` activity entry for the item the
    caller deleted, with `subitems_deleted: n` in its payload when n > 0.
  - It emits one `item_deleted` SSE event per removed item.
  - `deleteGroup` logs `group_deleted` with `subitems_deleted: n` when n
    subitems in other groups went with the group's items, and emits one
    `item_deleted` SSE event for each of them after `group_deleted`. Its
    confirmation counts them too.
- Ordering stays `group position → item position → id`. Nesting is by
  `parent_id`, never by position.

**Persistence (`server/store/persistence.js`):**

- The format becomes `"mini-monday-store/4"`. `/3` files load unchanged
  (they have no parents) and are saved as `/4` with a `<file>.v3.bak` copy,
  the same way `/2` keeps `.v2.bak`. The suffix is derived from the version,
  not hard-coded. `/2` still upgrades, through the `/3` path. Older servers
  refuse `/4`; that is the existing downgrade rule.
- Shape changes:
  - items: `parent_id:id~`
  - updates: `author_name:str~`
  - columns: `role:columnRole~`
- `checkItems` validates the parent invariants above and refuses a file that
  breaks them, with a precise message.

### 1.2 Column roles

A column may carry a **role**: what the column means in its source, owned by
whoever created it. Roles are set by the importer. Users can't set them yet.

| role            | column type | ClickUp field |
| --------------- | ----------- | ------------- |
| `status`        | status      | Status        |
| `assignees`     | people      | Assignees     |
| `due_date`      | date        | Due date      |
| `start_date`    | date        | Start date    |
| `priority`      | status      | Priority      |
| `time_estimate` | numbers     | Time estimate |
| `tags`          | text        | Tags          |
| `description`   | text        | Description   |

- At most one column per role on a board.
- A role whose type does not match is refused: by the snapshot validator
  with a warning (the role is dropped), and by persistence on load.
- GraphQL: `Column.role: ColumnRole` (nullable enum).
- The UI finds columns **by role** first. It never matches by title.

### 1.3 Status label types

- Status column settings may carry
  `labels_types: { [index]: "open" | "custom" | "done" | "closed" }`, next to
  `labels` and `labels_colors`.
- The ClickUp connector sets it from each status's `type`. Snapshot labels
  gain optional `type`.
- Any code that rewrites status settings keeps `labels_types` for retained
  indexes.
- `isDoneStatus` (web) uses `done`/`closed` types when present, else the
  existing rule.

### 1.4 Update authors

- The update record gains optional `author_name`. The importer sets it only
  when the source author has no Worklane user (`creator_id` null).
- The body is stored **as written**. The `"<name> wrote on ClickUp:\n"`
  prefix is gone.
- GraphQL: `Update.author_name: String`.
- Already-stored prefixed bodies stay as they are; nothing parses them.

### 1.5 Board views

- View types: `table`, `kanban`, `list`, `app`.
- `create_board_view(board_id:ID!, type:BoardViewType!, name:String):BoardView!`:
  - Needs editor access.
  - Allowed types are `table`, `kanban` and `list`; each type at most once
    per board.
  - At most 20 views.
  - The name defaults to "List", "Main table" or "Kanban".
- No delete in this part.
- The **default view** of a board is its first non-app view in record order.
  - ClickUp imports create views in the order List, Main table, Kanban.
  - Every other board keeps Main table, Kanban, so its default stays the
    table.

### 1.6 GraphQL additions

The web keeps `API-Version 2026-01`, so none of these are version-gated.

```
Item.parent_item_id: ID          # 1 field; null for top-level items
Item.parent_item: Item
Item.subitems(limit:Int=100): [Item!]!     # direct children, board order
Item.subitems_count: Int!                  # direct children
Item.updates_count: Int!
Column.role: ColumnRole
Update.author_name: String
Board.views → BoardView.type includes "list"
Mutation.create_subitem(parent_item_id:ID!, item_name:String!, column_values:String): Item!
Mutation.create_board_view(board_id:ID!, type:BoardViewType!, name:String): BoardView!
```

- Children and update counts are indexed once per request with `perRequest`.
- `create_subitem` needs editor access on the parent's board. It goes
  through the same store path as `create_item`.
- The web's per-item field estimate in `itemsPageLimit` adds the new fields
  it selects.

## 2. Importer

1. **Real parents** (`board-spec.js`, `store/imports.js`):
   - Spec items carry `key` (source id) and `parentKey`.
   - `insertRecords` assigns all ids first, then writes `parent_id`, so a
     child may come before its parent or sit in another group.
   - The "Parent item" text column and `parentColumn` / `PARENT_TITLE` are
     removed.
   - Nesting deeper than `MAX_SUBITEM_DEPTH` attaches the item to its
     deepest allowed ancestor, with warning `subitems_flattened`.
   - `itemOrder` places parents before their children inside each group
     where possible.
   - monday and file imports get real parents the same way.
2. **Roles and status types:**
   - Snapshot columns accept optional `role`; snapshot status labels accept
     optional `type`.
   - The ClickUp connector sets roles for its standard columns (§1.2) and
     `type` for every status.
   - The monday connector sets no roles.
3. **Authors:**
   - Spec updates carry `authorName` when no Worklane user maps.
   - The store keeps it as `author_name`, with the body unchanged.
4. **Views:**
   - `boardSpec` returns `views`. ClickUp boards get
     `[List, Main table, Kanban]`; other sources keep `[Main table, Kanban]`.
   - Both view lists live in one place, shared with `insertContent`.
5. **One import per scan job:**
   - `startImport` refuses a scan job that already started an import, with
     reason `already_imported` and that import's job id. The check comes
     before plan and busy checks, and is synchronous.
   - `POST /import/run` answers
     `409 { code: "ALREADY_IMPORTED", import_job_id }`.
   - Job views expose `import_job_id` on scans.
   - The wizard handles `ALREADY_IMPORTED` by following that import (its
     progress, or its finished report). The "ready to review" offer skips
     scans that were already imported.
   - Importing the same source again from a **new** scan still makes
     "(imported again)" copies, by design.
6. The README and SPEC-4 notes about the "Parent item" column and re-import
   are updated.

## 3. List view (ClickUp style)

New modules:

- `web/ui/board/list-model.js` (pure, unit-tested)
- `list-view.js`, `list-row.js` (DOM)
- `web/styles/board-list.css`
- `web/styles/clickup-tokens.css`

### 3.1 Routing and tabs

- Routes:
  - `#/boards/<id>` opens the board's **default view** (§1.5).
  - `#/boards/<id>/views/table` and `#/boards/<id>/views/list` are explicit.
  - Kanban, activity, forms and app routes are unchanged.
- Tabs come from `Board.views` in record order, followed by Activity and
  Forms:
  - List: icon `list`, label "List".
  - Table: "Main table".
  - Kanban.
  - Apps.
- Editors see a "+ View" menu that adds a missing `list`, `table` or
  `kanban` view (`create_board_view`).
- Boards without a list view look exactly as before.

### 3.2 Toolbar (List view)

- "+ Add task" primary button. Editors only; uses the accent.
- Search tasks (name). Matches keep their ancestors visible, and matched
  names are highlighted with `<mark>`.
- **Group by** menu:
  - Status (default): the `role=status` column, else the first status
    column.
  - Priority: the `role=priority` column.
  - Assignee: one group per assignee, plus "Unassigned".
  - Board group.
  - None.
- **Subtasks** toggle: Collapsed (default) or Expanded. Per-parent toggles
  override it.
- **Columns** menu: show or hide each column.
  - Default: columns that are empty for every item on the board are hidden.
  - The name column is always shown.
- **Show closed** toggle: label types `closed`/`done` are shown, collapsed,
  at the end (default on).
- The item count.
- Toolbar choices live in per-board session memory, like collapsed groups.

### 3.3 Groups

- One group per status label, in label order, with `closed`/`done` types
  last, then "No status".
- Groups with no tasks are hidden; "Show empty groups" in the Group-by menu
  turns them on.
- Header:
  - Chevron toggle (`aria-expanded`).
  - A **pill**: background = label color (`safeColor`), text from
    `textColorOn`, uppercase 11–12px/600, radius 4–6px, padding 2px 8px.
  - Task count, muted.
  - "+ Add task" ghost button, editors only.
- Below the header, a column-header row: small uppercase gray labels at
  4.5:1 contrast, sticky at the top of the scroll container.
- Each group ends with a "+ Add task" row (editors). It creates a top-level
  item with that group's status value (or other grouping value) and the
  board's first group.

### 3.4 Rows

The grid is `role="treegrid"`: rows are `role="row"` with `aria-level`, and
parents carry `aria-expanded`. Cells are `gridcell`, headers `columnheader`.
Rows are 36px (40px when `(hover: none)`), 14px text, with a 1px subtle
bottom border and no vertical borders. Hover is a light gray.

The name cell is sticky at the inline start and holds, in order:

1. Expand toggle, only when the item has subtasks. Indent =
   `depth × --cu-indent` (24px).
2. **Status circle**: a 14px ring in the status color, filled with a check
   for `done`/`closed` types. Editors get a button that opens the status
   menu; others a static indicator.
3. Name, with `dir="auto"`. A click opens the task view. Rename uses a
   pencil button shown on hover/focus (editors).
4. Subtask chip (`subtask` icon + count), which toggles expansion.
5. Description indicator, when the description is non-empty.
6. Comment count chip (`chat` icon + count), which opens the task view.

Other cells, in order: assignees, due date, priority, then the remaining
visible columns in board order.

| Kind                 | Rendering                                                                                                     | Editing (editors)                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Assignees            | Avatar stack (24px, max 3, +n); empty → faint add-person icon on hover                                        | Existing people picker                                                              |
| Dates                | Short day ("Oct 3"); red when overdue and the status is not done/closed; empty → faint calendar icon on hover | Date input                                                                          |
| Priority             | Flag icon in the label color plus the label; empty → faint flag                                               | Label menu                                                                          |
| Other status columns | Rounded pill (radius 4, 22px, label color), not the full-bleed table block                                    | Label menu                                                                          |
| Text                 | One line, truncated, `dir="auto"`. A multi-line value shows its first line and "…"                            | Single-line edits only for single-line values; multi-line values open the task view |
| Numbers              | Right-aligned                                                                                                 | Inline input                                                                        |
| People               | Avatar stack                                                                                                  | People picker                                                                       |

Subtasks render under their parent in the parent's group, whatever their own
status, like ClickUp's default.

Loading uses the shared `.skeleton` classes. Empty boards show the shared
empty state.

## 4. Task view (ClickUp style)

New modules:

- `web/ui/board/task-view.js` (dialog and layout)
- `task-fields.js`
- `task-activity.js`
- `task-model.js` (pure)
- `web/styles/task-view.css`

### 4.1 When it opens

The item route `#/boards/<id>/items/<itemId>` renders the **task view** when
the view the user came from is List. On a direct link, it renders when the
board's default view is List. Otherwise it renders the existing item card,
so monday-style boards are unchanged.

### 4.2 Layout

**Dialog:**

- A modal `<dialog class="task-view">` sized
  `min(1200px, 100vw - 32px)` × `100dvh - 48px`.
- Grid: `minmax(0,1fr) minmax(320px, 400px)`.
- Under 900px it is a single full-screen column, with Activity below.
- Escape, backdrop click and the close button close it. Focus returns to the
  opener, the same contract as the item card.

**Top bar:**

- Breadcrumb `Workspace / Board`.
- For a subtask, a "Subtask of <parent>" link.
- `#<id>`.
- Close.

**Left pane** (scrolls):

1. **Title.** 26px/600, `dir="auto"`. Inline rename for editors; viewers get
   an access badge.
2. **Fields grid.** Two columns of label/value rows with small icons, for
   role columns that exist:
   - **Status:** a pill button with a menu, plus a "✓ Complete" button that
     sets the first `done`/`closed` label when the board has one.
   - **Assignees.**
   - **Dates:** Start → Due.
   - **Priority:** flag.
   - **Time estimate.**
   - **Tags:** chips split from the comma text.

   An empty value shows a muted "Empty" that editors can edit.

3. **Description.**
   - Shows the `role=description` column with `white-space: pre-wrap` and
     `dir="auto"`.
   - Editors click to edit in an auto-growing textarea. Save on blur or
     Ctrl/⌘+Enter, cancel on Escape. It commits **only when the text
     changed**.
   - When empty: "Add a description".
4. **Custom fields.** Every other non-name column, as label/editor rows.
   - Text renders multi-line, pre-wrap, with a textarea editor (same commit
     rule).
   - Status columns render as rounded pills.
   - Empty fields collapse behind "Show N empty fields".
5. **Subtasks.**
   - Heading, "done/total", and a thin progress bar.
   - One row per direct child: status circle, name (opens that subtask's
     task view), assignee avatars, due date.
   - "+ Add subtask" inline input for editors (`create_subitem`).

**Right pane — Activity** (sunken background):

- **Header:** "Activity" and the comment count.
- **Body:** a chronological stream, oldest first, scrolled to the end on
  open.
  - A system line first: "<creator> created this task · <date>".
  - Then each comment:
    - Avatar: the user's, or the initials of `author_name` on a neutral
      color.
    - Name: the user, or `author_name` with a muted "ClickUp" tag.
    - Time: relative, with the full date in `title`.
    - Body: `pre-wrap`, `dir="auto"`. `http(s)` URLs become links with
      `rel="noopener noreferrer" target="_blank"`, built as DOM nodes,
      never HTML.
- **Footer:** a composer pinned at the bottom.
  - Textarea "Write a comment…" with a "Comment" button.
  - Ctrl/⌘+Enter posts. The draft is kept like the card's.
  - Hidden for view-only users, with a note.
- Up to 500 comments per task are loaded (`updates(limit:500)`).

All editors reuse the card's actions (`renameItem`, `setValue`, `addUpdate`,
`moveItem`, `createItem`) and keep focus keys, so live refreshes don't steal
focus.

## 5. Look and feel

- **Tokens** (`clickup-tokens.css`, defined in all three theme blocks):
  - `--cu-accent #7b68ee`, used for fills, borders and focus only.
  - `--cu-accent-strong #6a57e3`, for buttons and accent text.
  - `--cu-accent-soft`.
  - `--cu-border`.
  - `--cu-header-text #646d7a`, which meets 4.5:1. ClickUp's own gray
    would not.
  - `--cu-row-hover`, `--cu-indent`.
  - `--cu-priority-urgent/high/normal/low`, using ClickUp's flag colors:
    red, yellow, blue, gray.
- Every new color has its dark value, and text meets 4.5:1 in both themes.
- `.board-page[data-view="list"]` gives the board header the ClickUp feel:
  - Compact title, 20px.
  - Breadcrumb.
  - Tab underline in the accent.
  - Icons in tabs.
- Monday-style table, kanban and card CSS are untouched. Existing class
  names that e2e relies on are not renamed.
- **RTL:** user content gets `dir="auto"`. New CSS uses logical properties
  and `text-align: start`.
- No horizontal page scroll at 360px. The list scrolls inside
  `.board-view`.

## 6. Fixes that belong here

- **`inlineInput` newline loss.** Focusing and leaving a text input whose
  value contains line breaks no longer saves the stripped text. It commits
  only after a real edit. Multi-line values are edited in textareas (§3.4,
  §4.2).
- **One import per scan** (§2.5).

## 7. Verification

**Unit tests:**

- Store invariants, cascade delete, persistence /3 → /4 and the bad-parent
  refusals.
- GraphQL fields and the two mutations.
- Import with real parents, roles, label types, author names and views.
- The 409 path.
- `list-model` (grouping, ordering, closed handling, hidden columns, tree
  and search with ancestors) and `task-model` (field partition by role).
- Router defaults.

**E2E:**

- New `scripts/e2e-clickup.mjs` with a synthetic fixture
  (`test/fixtures/import/clickup-meetings-data.js`) shaped like the
  reference board:
  - Department statuses with colors, plus Closed.
  - About 60 tasks and 40 subtasks.
  - A multi-line Description and a long-text field.
  - Many comments on one task (> 25), some by authors who are not
    teammates.
  - A little Arabic text.
- It imports in code, opens the board (List is the default), and checks:
  - groups and pills;
  - nesting and expansion;
  - the status menu;
  - opening the task view: description, custom fields, subtasks, the
    activity stream with author names, and posting a comment.
- Screenshots: light, dark, and 360px.
- `e2e-import`, `e2e-smoke`, `e2e-roles` and `e2e-hosted` keep passing,
  updated only where this spec changes behavior.

**Gates:**

- `node --test "test/**/*.test.js"`
- `oxlint --max-warnings=0 examples/mini-monday`
- `oxfmt --check examples/mini-monday`
