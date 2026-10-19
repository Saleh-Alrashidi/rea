/**
 * The update composers of the task view (SPEC-6 §2.2, §2.3): "Write an
 * update…" on top of the Updates pane, the reply box under a card and
 * the edit box of an update. Each is a textarea that grows with its text
 * (Ctrl/⌘+Enter posts) with the mention picker (`mention-picker.js`).
 *
 * A composer's state lives in the task view's `store` (a Map) under its
 * `key`, not in the DOM: `{ text, mentions, picker, cache, searchSeq,
 * paint }`. A live refresh rebuilds the composer from it, so typing, the
 * inserted mentions (the side-table, `mention-tokens.js`) and an open
 * picker all survive; the textarea's focus key keeps focus and caret.
 *
 * Submitting encodes the text as a body (`encodeBody`: intact mentions
 * become tokens, everything else reads as typed), clears the composer at
 * once and hands `{ body, parts }` to `onSubmit`; when that resolves
 * false (the server refused), the text and mentions come back.
 */

import { h } from "../../dom.js";
import { button } from "../components/button.js";
import { isRebuilding } from "../components/focus.js";
import { showToast } from "../components/toast.js";
import {
  applyPick,
  closedPicker,
  pickerForText,
  pickerKey,
  taskOptions,
  withOptions,
} from "./mention-picker-model.js";
import { createPickerList } from "./mention-picker.js";
import {
  bodyLength,
  draftParts,
  encodeBody,
  intactMentions,
  mentionName,
  rebaseMentions,
} from "./mention-tokens.js";

/** The server's limits on a body (SPEC-6 §2.4): characters as it reads. */
export const MAX_BODY = 10_000;
export const MAX_TOKENS = 50;
const SEARCH_DELAY_MS = 150;
/** Keys that move the caret without typing (the picker follows it). */
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/** The state of composer `key` in `store`, created from `initial()`. */
export function composerState(store, key, initial) {
  let state = store.get(key);
  if (!state) {
    const start = initial?.() ?? { text: "", mentions: [] };
    state = {
      text: start.text,
      mentions: start.mentions,
      picker: closedPicker(),
      cache: new Map(),
      searchSeq: 0,
      paint: null,
    };
    store.set(key, state);
  }
  return state;
}

/**
 * The draft of a composer's text and mentions: `{ body, parts }`, or
 * null (with a toast saying why) when it is empty or over a limit.
 */
export function composerDraft(text, mentions) {
  const body = encodeBody(text, mentions);
  if (body === "") return null;
  if (bodyLength(body) > MAX_BODY) {
    showToast({
      type: "error",
      message: `An update can be at most ${MAX_BODY.toLocaleString()} characters`,
    });
    return null;
  }
  if (intactMentions(text, mentions).length > MAX_TOKENS) {
    showToast({
      type: "error",
      message: `An update can mention at most ${MAX_TOKENS} people, teams or tasks`,
    });
    return null;
  }
  return { body, parts: draftParts(text, mentions) };
}

/**
 * Runs the picker's search for its query (people now, tasks debounced);
 * a newer search, a pick or a closed picker drops an older answer.
 */
function searchOptions(state, sources) {
  state.searchSeq += 1;
  const seq = state.searchSeq;
  const { picker } = state;
  if (!picker.open) return;
  if (picker.mode === "people") {
    state.picker = withOptions(picker, sources.people(picker.query));
    return;
  }
  const query = picker.query.trim();
  if (query === "") {
    state.picker = withOptions(picker, taskOptions(sources.boardTasks()));
    return;
  }
  globalThis.setTimeout(async () => {
    if (seq !== state.searchSeq) return;
    let tasks = [];
    try {
      tasks = await sources.tasks(query, state.cache);
    } catch (error) {
      globalThis.console?.error?.("Task search failed", error);
    }
    if (seq !== state.searchSeq || !state.picker.open) return;
    state.picker = withOptions(state.picker, taskOptions(tasks));
    state.paint?.();
  }, SEARCH_DELAY_MS);
}

function autosize(textarea) {
  // `field-sizing: content` grows it where supported; this covers the rest.
  if (!("fieldSizing" in (textarea.style ?? {})) && textarea.scrollHeight) {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }
}

/** The textarea's events: typing, the picker's keys and submitting. */
function wireTextarea(ctx) {
  const { state, textarea, options, list } = ctx;
  const paint = () => list.paint(state.picker);
  const follow = () => {
    const caret = textarea.selectionStart ?? state.text.length;
    const collapsed = caret === (textarea.selectionEnd ?? caret);
    const before = state.picker;
    state.picker = collapsed
      ? pickerForText(before, { text: state.text, caret })
      : closedPicker();
    // The same query keeps its rows (and any search under way).
    if (state.picker !== before) searchOptions(state, options.sources);
    paint();
  };
  textarea.addEventListener("input", () => {
    const before = state.text;
    state.text = textarea.value;
    state.mentions = rebaseMentions(state.mentions, before, state.text);
    autosize(textarea);
    follow();
  });
  textarea.addEventListener("keydown", (event) => onKeydown(ctx, event));
  textarea.addEventListener("keyup", (event) => {
    if (CARET_KEYS.has(event.key)) follow();
  });
  textarea.addEventListener("click", follow);
  textarea.addEventListener("blur", () => {
    if (isRebuilding(textarea) || !state.picker.open) return;
    state.picker = closedPicker();
    state.searchSeq += 1;
    paint();
  });
  return { paint, follow };
}

function onKeydown(ctx, event) {
  const { state, options } = ctx;
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
  const result = plain
    ? pickerKey(state.picker, event.key)
    : { handled: false, pick: null };
  if (result.handled) {
    event.preventDefault();
    event.stopPropagation();
    state.picker = result.state;
    if (!state.picker.open) state.searchSeq += 1;
    if (result.pick) insertPick(ctx, result.pick);
    else ctx.list.paint(state.picker);
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    ctx.form.requestSubmit();
    return;
  }
  if (event.key === "Escape" && options.onCancel) {
    event.preventDefault();
    event.stopPropagation();
    options.onCancel();
  }
}

/** Writes the picked `option` as "@Name " and records its mention. */
function insertPick(ctx, option) {
  const { state, textarea } = ctx;
  const name = mentionName(option.name);
  const picked = applyPick(state.text, { state: state.picker, option, name });
  state.mentions = rebaseMentions(state.mentions, state.text, picked.text);
  if (picked.mention) state.mentions = [...state.mentions, picked.mention];
  state.text = picked.text;
  state.picker = closedPicker();
  state.searchSeq += 1;
  textarea.value = picked.text;
  textarea.setSelectionRange?.(picked.caret, picked.caret);
  autosize(textarea);
  ctx.list.paint(state.picker);
}

async function submit(ctx) {
  const { state, options } = ctx;
  const draft = composerDraft(state.text, state.mentions);
  if (!draft) return;
  const kept = { text: state.text, mentions: state.mentions };
  Object.assign(state, { text: "", mentions: [], picker: closedPicker() });
  state.searchSeq += 1;
  ctx.textarea.value = "";
  ctx.list.paint(state.picker);
  const accepted = await options.onSubmit(draft);
  if (accepted !== false) return;
  Object.assign(state, kept);
  options.onRestore?.();
}

/**
 * A composer form (see the module comment).
 * @param {{ key: string, store: Map<string, object>,
 *   initial?: () => { text: string, mentions: object[] },
 *   placeholder: string, label: string, submitLabel: string,
 *   sources: { people(query: string): object[], boardTasks(): object[],
 *     tasks(query: string, cache: Map): Promise<object[]> },
 *   onSubmit(draft: { body: string, parts: object[] }):
 *     Promise<boolean> | boolean | void,
 *   onCancel?: () => void, onRestore?: () => void, hint?: string,
 *   className?: string }} options
 */
export function updateComposer(options) {
  const state = composerState(options.store, options.key, options.initial);
  const textarea = h("textarea", {
    class: ["input", "update-composer-input"],
    rows: 1,
    maxlength: MAX_BODY,
    placeholder: options.placeholder,
    "aria-label": options.label,
    dir: "auto",
    spellcheck: "true",
    dataset: { focusKey: `composer:${options.key}` },
    value: state.text,
  });
  const ctx = { state, textarea, options };
  ctx.list = createPickerList({
    textarea,
    onPick: (option) => insertPick(ctx, option),
    onActive(index) {
      state.picker = { ...state.picker, active: index };
      ctx.list.paint(state.picker);
    },
  });
  const wired = wireTextarea(ctx);
  state.paint = wired.paint;
  ctx.form = h(
    "form",
    {
      class: ["update-composer", options.className],
      dataset: { composer: options.key },
      on: {
        submit(event) {
          event.preventDefault();
          submit(ctx);
        },
      },
    },
    h("div", { class: "update-composer-field" }, textarea, ctx.list.element),
    h(
      "div",
      { class: "update-composer-actions" },
      h("span", { class: "update-composer-hint" }, options.hint ?? ""),
      options.onCancel
        ? button({
            label: "Cancel",
            variant: "ghost",
            size: "sm",
            onClick: options.onCancel,
          })
        : null,
      button({
        label: options.submitLabel,
        type: "submit",
        variant: "primary",
        size: "sm",
        className: "update-composer-submit",
      }),
    ),
  );
  wired.paint();
  return ctx.form;
}
