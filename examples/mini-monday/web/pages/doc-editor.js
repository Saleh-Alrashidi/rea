/**
 * Doc editor (`#/docs/<id>`): the editable title and the block editor
 * (`ui/docs/editor.js`), saved by a debounced autosave that sends
 * `expected_version` (`ui/docs/autosave.js`). A version conflict, lost
 * access or a failed save stops editing and shows a banner (reload, copy
 * my version, try again); viewers get the same page read-only.
 *
 * Owners also get Share (the shared share dialog), the visibility control
 * and Delete. A missing or inaccessible doc shows the shared not-found view,
 * so the page never reveals that a doc exists.
 */

import { h } from "../dom.js";
import { docHash, docsHash } from "../router.js";
import { formatDay, timeAgo, todayString } from "../ui/components/format.js";
import { setDocumentTitle } from "../ui/components/page-header.js";
import { SHARE_MUTATIONS } from "../ui/components/share-model.js";
import { skeletonBlock, skeletonLine } from "../ui/components/skeleton.js";
import { emptyState } from "../ui/components/empty-state.js";
import { createAutosave } from "../ui/docs/autosave.js";
import { blocksToPlainText } from "../ui/docs/blocks.js";
import { renderDocHeader } from "../ui/docs/doc-header.js";
import {
  DELETE_DOC_MUTATION,
  docCapabilities,
  loadDoc,
  saveDoc,
} from "../ui/docs/doc-data.js";
import { createBlockEditor } from "../ui/docs/editor.js";
import {
  copyText,
  createSaveStatus,
  saveBanner,
} from "../ui/docs/save-status.js";
import { BUS_EVENTS } from "../ui/shell/bus.js";
import { rememberVisit } from "../ui/shell/recent.js";
import { notFoundView } from "./not-found.js";

const TITLE_MAX = 255;
const META_REFRESH_MS = 60_000;

function loadingView() {
  return h(
    "div",
    { class: "doc-page" },
    skeletonBlock({
      label: "Loading doc",
      className: "doc-skeleton",
      children: [
        skeletonLine({ width: "30%" }),
        skeletonLine({ variant: "title", width: "60%" }),
        skeletonLine({ width: "90%" }),
        skeletonLine({ width: "84%" }),
        skeletonLine({ width: "70%" }),
      ],
    }),
  );
}

// ------------------------------------------------------------- display

function personName(ctx, person) {
  if (!person) return null;
  return person.id === String(ctx.me.id) ? "you" : person.name;
}

function renderMeta(page) {
  const { doc, ctx } = page;
  const parts = [];
  const creator = personName(ctx, doc.created_by);
  if (creator) {
    const day = formatDay(todayString(new Date(doc.created_at)));
    parts.push(`Created by ${creator} on ${day}`);
  }
  const editor = personName(ctx, doc.updated_by);
  const edited = `Edited ${timeAgo(doc.updated_at)}`;
  parts.push(editor ? `${edited} by ${editor}` : edited);
  page.dom.meta.textContent = parts.join(" · ");
}

function renderHeader(page) {
  renderDocHeader(page.dom.bar, {
    doc: page.doc,
    caps: page.caps,
    status: page.status.element,
    onShare: () => share(page),
    onVisibility: (value) => setVisibility(page, value),
    onDelete: () => deleteDoc(page),
    onCopyLink: () => copyLink(page),
    onCopyText: () => copyVersion(page, { label: "Doc copied as text" }),
  });
}

function titleText(page) {
  return page.dom.title?.value ?? page.doc.title;
}

function fitTitle(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

// ------------------------------------------------------------- actions

function plainVersion(page) {
  const title = page.caps.edit ? titleText(page) : page.doc.title;
  return `${title}\n\n${blocksToPlainText(page.editor.getBlocks())}`;
}

async function copyVersion(
  page,
  { label = "Your version is on the clipboard" } = {},
) {
  const text = plainVersion(page);
  if (await copyText(text)) {
    page.ctx.toast.success(label);
    return;
  }
  // No clipboard access: show the text so it can be copied by hand.
  page.ctx.dialog.open({
    title: "Your version",
    description: "Select the text and copy it.",
    content: h("textarea", {
      class: "input",
      rows: 14,
      readonly: true,
      "aria-label": "Your version of the doc",
      value: text,
    }),
  });
}

async function copyLink(page) {
  const url = new URL(docHash(page.doc.id), `${globalThis.location.origin}/`)
    .href;
  if (await copyText(url)) page.ctx.toast.success("Doc link copied");
  else page.ctx.toast.show({ message: url, type: "info", timeout: 15_000 });
}

async function setVisibility(page, visibility) {
  try {
    await page.ctx.api.request(SHARE_MUTATIONS.docVisibility, {
      id: page.doc.id,
      visibility,
    });
  } catch (error) {
    page.ctx.toast.error(error, "Couldn’t change who can read this doc");
    return;
  }
  page.doc.visibility = visibility;
  renderHeader(page);
  page.ctx.toast.success(
    visibility === "private"
      ? "Only invited people can open this doc now"
      : "Everyone in the workspace can read this doc now",
  );
  await page.ctx.refreshShell();
}

/** Reopens the page from the server (after a conflict or access change). */
function reload(page) {
  page.autosave.dispose();
  page.ctx.router.reload();
}

async function share(page) {
  const result = await page.ctx.openShare({
    resourceKind: "doc",
    resourceId: page.doc.id,
  });
  if (!result.changed || result.lostAccess || !page.active) return;
  const fresh = await loadDoc(page.ctx.api, page.doc.id).catch(() => null);
  if (!fresh || !page.active) return;
  if (fresh.my_access !== page.doc.my_access) {
    await page.autosave.flush();
    reload(page);
    return;
  }
  Object.assign(page.doc, {
    visibility: fresh.visibility,
    members: fresh.members,
  });
  renderHeader(page);
}

async function deleteDoc(page) {
  const confirmed = await page.ctx.dialog.confirm({
    title: "Delete this doc?",
    message: `“${page.doc.title}” will be deleted for everyone with access. This can’t be undone.`,
    confirmButton: "Delete doc",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await page.ctx.api.request(DELETE_DOC_MUTATION, { id: page.doc.id });
  } catch (error) {
    page.ctx.toast.error(error, "Couldn’t delete the doc");
    return;
  }
  page.autosave.dispose();
  page.ctx.toast.success("Doc deleted");
  await page.ctx.refreshShell();
  page.ctx.router.navigate(docsHash());
}

// ------------------------------------------------------------ autosave

function lock(page) {
  if (page.locked) return;
  page.locked = true;
  page.editor.setReadOnly(true);
  if (page.dom.title) page.dom.title.readOnly = true;
}

function onSaveState(page, snapshot) {
  page.status.update(snapshot);
  const banner = saveBanner(snapshot, {
    what: "doc",
    onReload: () => reload(page),
    onCopy: () => copyVersion(page),
    onRetry: () => page.autosave.retry(),
  });
  page.dom.banners.replaceChildren(...(banner ? [banner] : []));
  const code = snapshot.error?.code;
  const stopped =
    snapshot.status === "conflict" ||
    (snapshot.status === "failed" &&
      (code === "NOT_FOUND" || code === "FORBIDDEN"));
  if (stopped) lock(page);
}

function onSaved(page, result) {
  Object.assign(page.doc, {
    title: result.title,
    version: result.version,
    updated_at: result.updated_at,
    updated_by: result.updated_by,
  });
  renderMeta(page);
}

function createDocAutosave(page) {
  return createAutosave({
    version: page.doc.version,
    save: (changes, expectedVersion) =>
      saveDoc(page.ctx.api, { id: page.doc.id, changes, expectedVersion }),
    onState: (snapshot) => onSaveState(page, snapshot),
    onSaved: (result) => onSaved(page, result),
  });
}

// --------------------------------------------------------------- title

/**
 * The sidebar lists doc titles: after a renamed title is saved, refresh
 * the shell once (on blur or leave), not on every autosave.
 */
function syncShellTitle(page) {
  if (page.doc.title === page.shellTitle) return;
  page.shellTitle = page.doc.title;
  page.ctx.refreshShell();
}

function titleField(page) {
  const textarea = h("textarea", {
    class: "doc-title",
    rows: 1,
    maxlength: TITLE_MAX,
    "aria-label": "Doc title",
    placeholder: "Untitled",
    spellcheck: "true",
    value: page.doc.title,
    on: {
      input() {
        const clean = textarea.value.replace(/[\r\n]+/g, " ");
        if (clean !== textarea.value) textarea.value = clean;
        fitTitle(textarea);
        const title = clean.trim();
        setDocumentTitle(title || "Untitled");
        if (title) page.autosave.change({ title });
      },
      keydown(event) {
        const atEnd = textarea.selectionStart === textarea.value.length;
        if (event.key === "Enter" || (event.key === "ArrowDown" && atEnd)) {
          event.preventDefault();
          page.editor.focusStart();
        }
      },
      blur() {
        // A title can't be empty; an emptied one goes back to the saved one.
        if (textarea.value.trim() === "") {
          textarea.value = page.doc.title;
          setDocumentTitle(page.doc.title);
          fitTitle(textarea);
        }
        page.autosave.flush().then(() => syncShellTitle(page));
      },
    },
  });
  return textarea;
}

function titleHeading(page) {
  page.dom.title = page.caps.edit ? titleField(page) : null;
  page.dom.heading = h(
    "h1",
    {
      class: ["doc-title-heading", !page.caps.edit && "plain"],
      id: "doc-title",
    },
    page.dom.title ?? page.doc.title,
  );
  return page.dom.heading;
}

// --------------------------------------------------------------- build

function buildEditor(page) {
  page.editor = createBlockEditor({
    blocks: page.doc.blocks,
    readOnly: !page.caps.edit,
    onChange: (blocks) => page.autosave.change({ blocks }),
    onExitUp: () => page.dom.title?.focus(),
    notify: (message) => page.ctx.toast.info(message),
  });
}

function emptyReadOnly(page) {
  if (page.caps.edit || page.doc.blocks.length > 0) return null;
  return emptyState({
    icon: "docs",
    compact: true,
    title: "This doc is empty",
    text: "Nothing has been written here yet.",
  });
}

function build(page) {
  const { dom } = page;
  dom.bar = h("header", { class: "doc-bar" });
  dom.banners = h("div", { class: "doc-banners" });
  dom.meta = h("p", { class: "doc-meta" });
  buildEditor(page);
  const tail = page.caps.edit
    ? h("div", {
        class: "doc-tail",
        "aria-hidden": "true",
        on: { click: () => page.editor.focusEnd({ append: true }) },
      })
    : null;
  renderHeader(page);
  renderMeta(page);
  return h(
    "div",
    { class: ["doc-shell", !page.caps.edit && "read-only"] },
    dom.bar,
    h(
      "div",
      { class: "doc-page" },
      dom.banners,
      h(
        "article",
        { class: "doc-article", "aria-labelledby": "doc-title" },
        titleHeading(page),
        dom.meta,
        emptyReadOnly(page),
        page.editor.element,
        tail,
      ),
    ),
  );
}

// ------------------------------------------------------ freshness, exit

/**
 * When the tab comes back, picks up a newer version saved elsewhere, as
 * long as nothing here is unsaved or being typed into.
 */
async function refreshIfStale(page) {
  const before = page.autosave.snapshot();
  if (before.unsaved || before.status !== "saved" || page.locked) return;
  const fresh = await loadDoc(page.ctx.api, page.doc.id).catch(() => null);
  if (
    !fresh ||
    !page.active ||
    fresh.version === page.autosave.snapshot().version
  )
    return;
  const busy = page.autosave.snapshot().unsaved;
  const typing = page.root.contains(globalThis.document.activeElement);
  if (busy || typing) return;
  if (fresh.my_access !== page.doc.my_access) {
    reload(page);
    return;
  }
  page.doc = fresh;
  page.editor.setBlocks(fresh.blocks);
  if (page.dom.title) {
    page.dom.title.value = fresh.title;
    fitTitle(page.dom.title);
  } else {
    page.dom.heading.textContent = fresh.title;
  }
  page.autosave.rebase(fresh.version);
  setDocumentTitle(fresh.title);
  renderHeader(page);
  renderMeta(page);
  page.ctx.toast.info("Updated to the latest version");
}

function watchPage(page) {
  const doc = globalThis.document;
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") page.autosave.flush();
    else refreshIfStale(page);
  };
  const onBeforeUnload = (event) => {
    if (!page.autosave.snapshot().unsaved) return;
    page.autosave.flush();
    event.preventDefault();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener("beforeunload", onBeforeUnload);
  const timer = globalThis.setInterval(() => renderMeta(page), META_REFRESH_MS);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    globalThis.removeEventListener("beforeunload", onBeforeUnload);
    globalThis.clearInterval(timer);
  };
}

/** Page contract. */
export async function mount(container, ctx, params) {
  setDocumentTitle("Doc");
  container.replaceChildren(loadingView());
  let doc;
  try {
    doc = await loadDoc(ctx.api, params.docId);
  } catch (error) {
    container.replaceChildren(
      emptyState({
        icon: "alert",
        title: "Couldn’t open this doc",
        text: error.message,
        action: {
          label: "Try again",
          icon: "refresh",
          onClick: () => ctx.router.reload(),
        },
      }),
    );
    return undefined;
  }
  if (!doc) {
    setDocumentTitle("Doc not available");
    container.replaceChildren(notFoundView({ what: "doc" }));
    return undefined;
  }
  const page = {
    ctx,
    doc,
    caps: docCapabilities(doc),
    dom: {},
    active: true,
    locked: false,
    shellTitle: doc.title,
  };
  page.status = createSaveStatus();
  page.autosave = createDocAutosave(page);
  page.root = build(page);
  container.replaceChildren(page.root);
  setDocumentTitle(doc.title);
  if (page.dom.title) fitTitle(page.dom.title);
  rememberVisit(ctx.me.id, "doc", doc.id);
  if (doc.workspaceAccessible)
    ctx.bus.emit(BUS_EVENTS.workspace, doc.workspace.id);
  // The router focuses the page after mount; a new doc then starts typing.
  if (page.caps.edit && doc.blocks.length === 0) {
    globalThis.setTimeout(() => page.active && page.editor.focusStart(), 0);
  }
  const unwatch = watchPage(page);
  return () => {
    page.active = false;
    unwatch();
    page.autosave.flush().finally(() => {
      page.autosave.dispose();
      syncShellTitle(page);
    });
  };
}
