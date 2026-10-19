# Worklane specification, part 6: ClickUp everywhere, drag and drop, mentions, Spaces and Folders, monday-style updates

Part 5 (`SPEC-5.md`) built the ClickUp-style List view, the task view and
real subitems for imported ClickUp boards. Part 6 extends that work to the
whole product. The owner chose:

- **ClickUp style is the default for every board.** The monday-style Main
  table stays available as a tab.
- **Order of work:**
  1. drag and drop (movement);
  2. @mentions;
  3. a Space/Folder/List sidebar;
  4. comments that work like **monday.com updates**.
- **Behavior is studied with REA.** The REA study of ClickUp's public web
  app is `/workspace/clickup-rea-report.md` in CranL sandbox
  `sbx_xanvr5eu3rah`. It cites Evidence
  `ev_874605b21d2da4eea073df3312ac006932dc754ffed835944574cbc25715c3e3`
  (a targeted run) and bundle and API-doc references.
- **What we take from that study:** behaviors and data shapes, but never
  ClickUp code, assets, wording or private endpoints. Worklane defines its
  own contract.

`AGENTS.md` and the SPEC-5 rules apply:

- Fix producers, one owner per fact.
- Files ≤ 500 lines (CSS too), functions ≤ 100 lines, complexity ≤ 20,
  ≤ 4 params, depth ≤ 4.
- `oxlint --max-warnings=0` and `oxfmt --check` must be clean.
- Data-file changes are additive, with an upgrade path and a version-named
  backup.

The work ships in three phases. Each phase is reviewed, passes every gate,
and is deployed before the next one starts.

---

## Phase 1: ClickUp everywhere and drag and drop

### 1.1 Default views and the task view for every board

- **Views:**
  - Every board has a List view. New boards are created with
    `List, Main table, Kanban`.
  - Loading a data file adds a List view to any board that lacks one. This
    is an idempotent normalization done in the store upgrade step, and the
    file is saved afterwards.
  - The default view is the List view when one exists, else the first
    non-app view.
  - Tabs are ordered List, Main table, Kanban, then apps, Activity and
    Forms.
  - `Board.views` lists a board's views in that tab order (list, table,
    kanban, app; record order within a type), so the first non-app view
    of the list is the default view. The seed adds its boards' List views
    after its other records, so the seeded IDs stay as they were.
- **Item route:** `#/boards/<id>/items/<itemId>` always opens the
  **task view**, from every view.
  - The monday-style item card (`item-card.js`, `board-card.css`) is
    superseded and removed.
  - Shared pieces (the modal shell, composer, update entry) move to the
    task modules. The e2e scripts switch to task-view selectors.
- **Status menu:** List rows, the task view and Kanban cards use one compact
  status menu:
  - a search box;
  - one row per label, with a color dot and the label in normal case;
  - a check mark on the current label;
  - "Clear" at the end;
  - full keyboard support.

  The full-bleed monday picker stays only in the Main table.

- **Sidebar icons:** each board shows the icon of its default view (the
  list icon for List).
- **At 360px:**
  - The List toolbar collapses Group by, Subtasks, Columns and Show closed
    into one "View options" menu.
  - The view tabs scroll horizontally inside their strip.
  - The page itself never scrolls sideways.

### 1.2 One manual order per board

- `item.position` becomes a **board-wide** sortable number. It is still a
  float, still persisted as `position:num`.
  - The upgrade to format `/5` renumbers each board's items in their current
    display order (group position, then item position, then id) at a
    spacing of 1024, with a `.v4.bak` backup.
  - New items get `max(position on the board) + 1024`. This holds for
    every creation path: items, subitems, form responses and imports
    (an import gives its items 1024, 2048, … in spec order).
  - Every view sorts by its grouping first, then by `position`, then by id.
    The Main table's order is unchanged by the upgrade.
  - `Item.position: Float!` exposes the position, so clients can sort.
- **Moves use midpoints.** A move places the item between two neighbors
  (`before_item_id` / `after_item_id`) at the midpoint of their positions.
  - The neighbors are adjacent places in the board's **manual order**:
    all of its items by `position`, then id, without the moved item.
  - When the gap is smaller than `1e-6` (or no float lies between the
    two), or either neighbor is missing, the server renumbers that board
    (spacing 1024) inside the same commit, then places the item.
    "Missing" means the item goes before the first or after the last
    item of the board: after renumbering it takes 512 or the last
    position + 512.
  - Renumbering follows the manual order, so every grouping keeps its
    order. It changes positions only, not `updated_at`, and emits no
    events of its own.
  - The client never computes positions.

### 1.3 `move_item` (server)

```
move_item(item_id:ID!, before_item_id:ID, after_item_id:ID,
          parent_item_id:ID, detach_parent:Boolean=false,
          group_id:String, column_values:String): Item!
```

**What one call does, in one commit:**

- **Order:** places the item between its neighbors. The neighbors must be
  on the same board. If none are given, the item keeps its position.
  - `after_item_id: A` alone: the item lands immediately **after** A,
    between A and the item that follows A in the manual order.
  - `before_item_id: B` alone: the item lands immediately **before** B,
    between the item that precedes B and B.
  - Both: the item lands between A and B. A must come before B in the
    manual order. Items between them (for example those of other groups)
    keep their places.
- **Parent:** `parent_item_id` makes the item a subitem of that parent.
  `detach_parent` makes it top-level.
- **Group:** `group_id` changes the board group.
- **Values:** `column_values` applies the values of the target grouping,
  e.g. `{ "status": 3 }` when it is dropped into the "facility" group. This
  uses the same parser as `change_multiple_column_values`.
- The subitems of a moved item keep their parent and move with it in the
  tree. Their positions are untouched.

**Validation:**

- Editor access is required.
- The parent invariants of SPEC-5 §1.1 hold: same board, not inside its
  own subtree, depth ≤ 5.
- Neighbors must not be descendants of the moved item.
- A refused move fails as a whole and changes nothing. Codes:
  `invalid_parent`, `invalid_neighbor`, `not_found`.
  - `not_found` (GraphQL `NOT_FOUND`): a neighbor, parent or group that
    is unknown or on another board, worded the same either way.
  - `invalid_neighbor` (`BAD_USER_INPUT`): the item itself or one of its
    subitems, or `after_item_id` not before `before_item_id`.
  - `invalid_parent` (`BAD_USER_INPUT`): the item itself, one of its
    subitems, or a parent so deep that the item's subtree would pass 5
    levels.
  - Giving both `parent_item_id` and `detach_parent: true` is
    `BAD_USER_INPUT`.

**Events:**

- One `item_moved` event with `{ position, parent_item_id, group_id }`.
- `column_value_changed` events for the changed values (a value equal to
  the stored one emits and logs nothing; a `name` renames, with
  `item_renamed`).
- Activity entries "moved", "changed status" and so on, as single changes
  already log them.
  - A new group logs `item_moved` with the group titles.
  - A new parent logs `item_moved` from/to "Top level" or
    "Subitem of “<parent>”".
  - A new place in the order alone is not logged, as a move within a
    group was not before.

`move_item_to_group` stays, and is implemented through `move_item`'s
store path. It keeps its contract: an item that changes group goes to the
end of that group (after every item of the board); a move within its own
group changes nothing.

### 1.4 Drag and drop in the List view

**Starting a drag:**

- **Handle:** a 6-dot drag handle appears at the inline start of a row on
  hover and focus. Editors only; viewers get no handle and no drag.
- **Threshold:** a drag starts after 4px of pointer movement. Pointer
  events give mouse, pen and touch support; touch needs a 400ms
  long-press.
- **Ignored targets:** a drag never starts from
  `input, textarea, select, button, a, [contenteditable], [data-no-drag]`.

**Drop zones:** each row has three bands.

- The top 35% means **before**.
- The bottom 35% means **after**.
- The middle 30% means **inside**, which makes the item a subtask of that
  row. The row gets an accent outline.
- _Before_ and _after_ show a 2px accent line, indented to the level the
  item will land at.
- Hovering a collapsed parent's middle band for 800ms expands it.
- A drop on a group header, or on an empty group, means "end of that
  group".

**What a drop does:**

- **Between groups:** dropping into another group applies that group's
  value through `column_values`. Only a drag does this; keyboard moves
  and the row menu keep the task's own values.
  - Status / Priority: that label.
  - Assignee: replace the assignees with that person, or none for
    "Unassigned".
  - Board group: `group_id`.
  - None: no value change.
- **Between rows:** dropping before or after a row takes that row's parent,
  so the item becomes its sibling; at depth 0 it is detached.

**Invalid drops** show a "not allowed" cursor and a red line, and do
nothing:

- into the item's own subtree;
- deeper than 5 levels;
- a no-op next to its own position;
- a selection that mixes a parent with its descendant.

**Moving the view and the selection:**

- **Auto-scroll:** the list scrolls automatically when the pointer is within
  48px of the scroll container's top or bottom edge, every 16ms.
- **Multi-select:**
  - Row checkboxes appear on hover. Shift-click selects a range and
    Ctrl/⌘-click toggles one row.
  - Dragging a selected row moves the whole selection, in display order,
    with a count badge.
  - A bulk bar appears while anything is selected: Set status, Move to…,
    Delete, Clear.

**Keyboard, undo and failures:**

- **Keyboard alternatives:**
  - On a focused row, Alt+↑ / Alt+↓ move it among its siblings.
  - Alt+→ makes it a subtask of the previous sibling.
  - Alt+← moves it out of its parent, right after the parent. It keeps
    its own values (status, priority, assignees and board group), so it
    may land in another group than the parent's.
  - The row's "…" menu offers Move up, Move down, Make subtask of…, Move
    out of parent, and Move to… (another board, Phase 3).
  - Moves are announced in a polite live region.
- **Undo:**
  - Every move shows a toast "Moved "<name>" · Undo" for 8s.
  - Ctrl/⌘+Z undoes the last move while the toast is showing.
  - Undo calls `move_item` back to the recorded neighbors, parent, group
    and previous values. A move without neighbors kept the position, so
    its undo names none either.
  - Limit: `move_item` refuses a task's own subitems as neighbors, so a
    task that sat strictly between two of its subitems in the manual
    order comes back after them.
- **Optimistic updates:** the row moves at once. A refused call reverts it
  and shows the error toast.

### 1.5 Drag and drop in Kanban

- Cards reorder within a lane using `move_item` with neighbors. Lanes
  already change status.
- Each lane shows the same drop line as the List view.
- The neighbors come from the board's manual order, since a lane can show
  the card's own subtasks (no neighbors) and other lanes' items sit
  between its cards. A drop that changes nothing, or at a place only the
  card's own subtasks could name, shows red and does nothing: no call and
  no "Moved" toast.
- Kanban cards open the task view.

---

## Phase 2: @mentions and monday-style updates

### 2.1 Update model (monday-style)

- **Replies:** updates gain `parent_update_id~` (one level of replies only).
- **Edits:** updates gain `edited_at:str~`. The body stays a string of at
  most 10,000 characters.
- **Pins:** updates gain `pinned_at:str~`. Pinned updates show first;
  replies can't be pinned.
- **Likes:** a new persisted collection `likes: "update_id:id user_id:id
  created_at:str"`, unique per user and update. Deleting an update removes
  its likes and replies.
- **Cascades:** deleting an item removes its updates, their replies and
  their likes, through the existing single removal owner.
- **GraphQL** (monday-compatible names where monday has them):

  ```
  Update.parent_update_id: ID
  Update.replies: [Update!]!
  Update.edited_at: String
  Update.pinned: Boolean!
  Update.likes_count: Int!
  Update.liked_by_me: Boolean!
  Update.likers(limit:Int=20): [User!]!
  Update.body_parts: [BodyPart!]!
  Update.can_edit: Boolean!
  create_update(item_id:ID!, body:String!, parent_id:ID): Update!
  edit_update(id:ID!, body:String!): Update!
  delete_update(id:ID!): Update!
  like_update(update_id:ID!): Update!
  unlike_update(update_id:ID!): Update!
  pin_to_top(id:ID!, item_id:ID!): Update!
  unpin_from_top(id:ID!, item_id:ID!): Update!
  ```

  `Item.updates` returns top-level updates only: pinned first, then newest
  first. `Item.updates_count` counts top-level updates and replies.

- **Permissions:**
  - Posting, replying, liking and pinning need editor access, like
    `create_update` today.
  - Edit: only the author.
  - Delete: the author or a board owner.
  - Viewers can read.
- **Importer:**
  - ClickUp and monday replies become real replies (`parent_update_id`).
    The flattened `"Reply: "` prefix is removed at the producer.
  - Imported likes and reactions are out of scope.

### 2.2 Mentions

**Stored form and parsing:**

- Mentions are stored in the body as tokens: `@[Display name](user:12)`,
  `@[Team name](team:3)` and `@[Task name](item:345)`.
- One server module, `server/mentions.js`, owns parsing and validation. It
  is the only code that reads the token syntax.
- The display name in a token is a snapshot. Rendering uses the current
  name when the target is visible to the reader, and the snapshot otherwise.
- `Update.body_parts` gives the parsed parts:
  - `text{text}`
  - `user{user{id name initials color}}`
  - `team{team{id name}}`
  - `item{item_id, name, board_id}`. The name is null when the reader
    can't open that item's board, rendered as "Private task".
  - `link{url}`, for http(s) URLs found in text.

  The web renders only `body_parts`; it never parses bodies.

**Creating mentions:**

- On create and edit, the server validates every token.
  - Unknown ids become plain text, which keeps the display name.
  - At most 50 mentions per body.

**Notifications:**

- Mentioned users who can open the board get a `mention` notification:
  "<actor> mentioned you in <item>", linking to the item and update.
- A team mention notifies each member who can open the board.
- Users who can't open the board are **not** notified and learn nothing.
  The composer marks them "no access" before posting.
- A reply notifies the parent update's author and earlier repliers, except
  the actor (`reply` kind).
- A like notifies the update's author (`like` kind), once per update and
  liker.
- New `NOTIFICATION_KINDS`: `mention`, `reply`, `like`. The Inbox gets a
  "Mentions" filter.

**Composer picker:**

- Typing `@` at the start of a word opens a people picker.
  - It lists board-assignable users, then teams, matched on name or email
    as you type.
  - Each row shows avatar, name and email. Users without board access
    appear last, marked "No access".
- `@@` opens a task picker: items on boards the author can open, matched by
  name, at most 20, showing the board name and status dot.
- Picker keys:
  - ↑/↓ move.
  - Enter or Tab insert.
  - Escape closes.
  - Mouse works too.
  - The picker keeps `aria-activedescendant`.
- **Inserted mentions:**
  - The composer textarea shows `@Name`, and the composer keeps a
    side-table of inserted mentions.
  - On submit, each still-intact `@Name` occurrence becomes its token. A
    hand-typed `@Name` without a pick stays text.
  - Editing a posted update loads tokens back as `@Name` with the
    side-table.

### 2.3 Updates UI (monday-style, in the task view)

**Layout:** the task view's right pane becomes **Updates**, with tabs
"Updates" and "Activity", in that order.

- "Updates" holds the monday-style stream.
- "Activity" holds the item's field changes, from activity logs filtered by
  item, when available; otherwise it is hidden.

**Top of the pane:** a composer, "Write an update…".

- A textarea that grows with its text, with mention support.
- Ctrl/⌘+Enter posts.
- The "Update" button uses the primary color.

**Update cards**, newest first, pinned first:

- **Header:** avatar, name (or `author_name` plus the source tag), relative
  time (full date on hover), "(edited)", and a "…" menu with Edit, Pin to
  top / Unpin, Copy link, and Delete with a confirm.
- **Body:** `body_parts`, with mention chips. Clicking a person opens their
  profile popover; clicking a task opens the task view. Links, `dir="auto"`
  and `pre-wrap` apply.
- **Footer:**
  - A "👍 Like" toggle with its count; hovering the count lists the likers.
  - A "Reply" button that opens a reply composer under the card.
- **Replies** are listed under the card, indented and smaller, with Like
  and the menu. "Show N more replies" appears when there are more than 3.
- Copy link gives `#/boards/<id>/items/<itemId>/updates/<updateId>`. That
  route opens the task view scrolled to the update, highlighted for 2s.

**Live and empty states:**

- Optimistic posting, liking and replying, with rollback on error.
- Live refresh through the existing board events. Focus keys keep typing
  safe.
- With no updates: "No updates yet", plus a hint about @mentions.

---

## Phase 3: Spaces, Folders and the ClickUp sidebar

### 3.1 Model

- **Naming:** Worklane's _workspaces_ are shown to people as **Spaces**.
  The API keeps the name `workspace`. All UI text changes "Workspace" to
  "Space", including admin, settings, the import wizard and empty states.
  The whole site is the top-level "Workspace" (the company).
- **Folders:** a new collection
  `folders: "id:id workspace_id:id name:str color:color position:num created_by:id? created_at:str"`.
  - Boards, docs and forms gain `folder_id:id~`. A folder belongs to one
    Space; one level only, no subfolders.
  - Boards, docs and folders gain `position:num~`, a sidebar order within
    their Space or folder. Spaces gain `position:num~` too.
- **Folder access:** folders have no access rules of their own. They inherit
  the Space's. A private board stays private inside any folder.
- **Upgrade `/5 → /6`, with a `.v5.bak` backup:**
  - For every board whose `import.folder` is set, a folder is created per
    (Space, `folder.source_id`) and the board moves into it.
  - The board is renamed to `import.source_name` only if its current name
    still equals the name the importer composed
    (`"<folder.name> / <source_name>"`). This applies the importer's own
    rule exactly, and a user rename is never overwritten.
- **Importer:** ClickUp folders become real folders at import time. Lists
  keep their own names; there is no more composed "<Folder> / <List>".
  monday folders are out of scope.

### 3.2 GraphQL

```
Folder { id name color workspace boards docs position }
Workspace.folders: [Folder!]!
Board.folder: Folder
Doc.folder: Folder
create_folder(workspace_id:ID!, name:String!, color:String): Folder!
update_folder(folder_id:ID!, name:String, color:String): Folder!
delete_folder(folder_id:ID!): Folder!
move_board(board_id:ID!, workspace_id:ID, folder_id:ID, to_root:Boolean,
           before_id:ID, after_id:ID): Board!
move_doc(...same shape...): Doc!
move_folder(folder_id:ID!, before_id:ID, after_id:ID): Folder!
move_workspace(workspace_id:ID!, before_id:ID, after_id:ID): Workspace!
move_item_to_board(item_id:ID!, board_id:ID!, group_id:String): MoveResult!
```

- `delete_folder` moves its boards and docs to the Space root; it never
  deletes content.
- `MoveResult` is `{ item: Item!, dropped_columns: [String!]! }`.

**Permissions:**

- Creating, editing and deleting folders, and moving inside a Space: Space
  editor.
- Moving a board to another Space: board owner, and editor on the target
  Space.
- Reordering Spaces: admins.

**`move_item_to_board`:**

- Moves the item, its subitems, updates, replies and likes.
- Values are mapped first by column role, then by an exact title-and-type
  match. Status labels are matched by name, case-insensitively, else the
  item gets no status.
- Unmapped columns are reported in `dropped_columns`.
- It needs editor access on both boards. The UI shows a confirm dialog
  listing the dropped columns before calling.

### 3.3 Sidebar (ClickUp style)

**Sections, top to bottom:**

1. Home.
2. Inbox (notifications, with a count).
3. My Work.
4. Favorites. This is per-user and stored in browser storage; it is only a
   convenience, and it is hidden when empty.
5. **Spaces**: every Space the user can open, as a tree.

**The Spaces tree:**

- **Space row:** a colored letter tile, the name, and on hover "+" and "…".
  The row is expandable, and its expanded state is remembered per user in
  browser storage.
- **Inside a Space:** Folders (folder icon, expandable), folderless Lists
  (the icon of the default view), Docs and Forms, each in its own position
  order.
- **Folder rows** list their Lists and Docs.
- **"+" menus:**
  - On a Space: List, Folder, Doc, Form.
  - On a Folder: List, Doc.
- **"…" menus:**
  - Rename.
  - Color, for a Space or Folder.
  - Move to…
  - Space settings, on a Space.
  - Delete, with the existing confirms.
- The current item is highlighted. Long names truncate with a title
  tooltip. "+ New Space" sits at the end, for admins.

**Drag and drop in the sidebar:**

- Lists and Docs reorder inside a folder or Space root, move between
  folders, and move to another Space (with the cross-Space permission
  checks).
- Folders reorder within a Space.
- Spaces reorder (admins).
- Hovering a collapsed folder or Space for 1000ms expands it.
- Invalid targets show "not allowed".
- Undo toast as in §1.4.
- A **task row** dragged from the List view onto a List in the sidebar
  calls `move_item_to_board`, after the confirm when columns would be
  dropped.

**Keyboard:**

- The tree has `role="tree"`.
- Arrows navigate, Enter opens, → and ← expand and collapse.
- The "…" menus offer the same moves.

**Small screens:** the sidebar becomes the existing off-canvas drawer under
900px.

---

## Verification (every phase)

- **Unit tests:**
  - Store invariants and upgrades: `/4→/5` renumbering, `/5→/6` folders and
    renames, each with a version-named backup.
  - Permissions for every new mutation.
  - The mentions parser: tokens, unknown ids, limits, and no notification
    leaks to users without access.
  - Notifications for mention, reply and like.
  - The move math: midpoints and renumbering.
  - Pure web models: drop resolution, mention picker, update ordering, the
    sidebar tree.
- **E2E (Chromium):** extend `scripts/e2e-clickup.mjs`, or add
  `e2e-dnd.mjs`, `e2e-updates.mjs` and `e2e-sidebar.mjs`, to cover each
  behavior with real pointer drags and keyboard moves, plus screenshots in
  light, dark and at 360px.
- **Existing suites:** `e2e-smoke`, `e2e-roles`, `e2e-import` and
  `e2e-hosted` keep passing, with selectors updated where this spec
  replaces UI.
- **Gates:**
  - `node --test "test/**/*.test.js"`
  - `oxlint --max-warnings=0 examples/mini-monday`
  - `oxfmt --check examples/mini-monday`
