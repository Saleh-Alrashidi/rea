// Notes logic, plus the autosave controller (web/ui/docs/autosave.js) that
// the note and doc editors share.
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../server/graphql/parse.js";
import { ApiError } from "../web/api.js";
import { createAutosave } from "../web/ui/docs/autosave.js";
import {
  DELETE_NOTE_MUTATION,
  NOTES_QUERY,
  NOTE_COLORS,
  UPDATE_NOTE_MUTATION,
  colorName,
  loadNotes,
  noteCapabilities,
  noteText,
  noteTone,
  notesView,
  safeNoteColor,
  saveNote,
} from "../web/ui/notes/note-model.js";
import { startTestServers } from "./helpers.js";

/** Fake timers: `tick()` runs due callbacks in order. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    timers: {
      set(callback, ms) {
        seq += 1;
        due.set(seq, { at: now + ms, callback });
        return seq;
      },
      clear: (id) => due.delete(id),
    },
    async tick(ms) {
      now += ms;
      for (const [id, entry] of due) {
        if (entry.at > now) continue;
        due.delete(id);
        entry.callback();
      }
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
    pending: () => due.size,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("autosave debounces, merges patches and sends the last version", async () => {
  const clock = fakeTimers();
  const calls = [];
  const states = [];
  const autosave = createAutosave({
    version: 3,
    timers: clock.timers,
    save: async (changes, expectedVersion) => {
      calls.push({ changes, expectedVersion });
      return { version: expectedVersion + 1 };
    },
    onState: (snapshot) => states.push(snapshot.status),
  });
  autosave.change({ title: "A" });
  await clock.tick(500);
  autosave.change({ title: "AB", blocks: ["x"] });
  await clock.tick(799);
  assert.equal(calls.length, 0, "the debounce restarts on every change");
  await clock.tick(1);
  assert.deepEqual(calls, [
    { changes: { title: "AB", blocks: ["x"] }, expectedVersion: 3 },
  ]);
  assert.equal(autosave.snapshot().status, "saved");
  assert.equal(autosave.snapshot().version, 4);
  autosave.change({ pinned: true }, { immediate: true });
  await clock.tick(0);
  assert.deepEqual(calls[1], { changes: { pinned: true }, expectedVersion: 4 });
  assert.deepEqual(states.slice(0, 4), [
    "pending",
    "pending",
    "saving",
    "saved",
  ]);
  autosave.dispose();
  autosave.change({ title: "ignored" });
  assert.equal(clock.pending(), 0);
});

test("autosave queues edits made during a save behind it", async () => {
  const clock = fakeTimers();
  const gates = [deferred(), deferred()];
  const calls = [];
  const autosave = createAutosave({
    version: 1,
    timers: clock.timers,
    save: (changes, expectedVersion) => {
      calls.push({ changes, expectedVersion });
      return gates[calls.length - 1].promise;
    },
  });
  autosave.change({ body: "one" });
  await clock.tick(800);
  autosave.change({ body: "two" });
  await clock.tick(800);
  assert.equal(calls.length, 1, "one save at a time");
  assert.equal(autosave.snapshot().status, "saving");
  gates[0].resolve({ version: 2 });
  await clock.tick(0);
  assert.deepEqual(calls[1], { changes: { body: "two" }, expectedVersion: 2 });
  const flushed = autosave.flush();
  gates[1].resolve({ version: 3 });
  const final = await flushed;
  assert.equal(final.status, "saved");
  assert.equal(final.version, 3);
  assert.equal(final.unsaved, false);
});

test("autosave stops on a version conflict and keeps the edits", async () => {
  const clock = fakeTimers();
  let fail = true;
  const calls = [];
  const autosave = createAutosave({
    version: 5,
    timers: clock.timers,
    save: async (changes, expectedVersion) => {
      calls.push(expectedVersion);
      if (fail) {
        throw Object.assign(new Error("changed"), {
          code: "VERSION_CONFLICT",
          version: 9,
        });
      }
      return { version: expectedVersion + 1 };
    },
  });
  autosave.change({ title: "mine" });
  await clock.tick(800);
  let snapshot = autosave.snapshot();
  assert.equal(snapshot.status, "conflict");
  assert.equal(snapshot.serverVersion, 9);
  assert.deepEqual(snapshot.pending, { title: "mine" });
  autosave.change({ body: "more" });
  await clock.tick(5000);
  assert.deepEqual(calls, [5], "nothing is saved over a conflict");
  assert.deepEqual(autosave.snapshot().pending, {
    title: "mine",
    body: "more",
  });
  assert.equal((await autosave.flush()).status, "conflict");
  fail = false;
  autosave.rebase(9);
  snapshot = autosave.snapshot();
  assert.equal(snapshot.status, "saved");
  assert.equal(snapshot.pending, null);
  autosave.change({ title: "after reload" });
  await clock.tick(800);
  assert.deepEqual(calls, [5, 9]);
});

test("autosave keeps failed edits and retries on the next change", async () => {
  const clock = fakeTimers();
  let attempts = 0;
  const autosave = createAutosave({
    version: 1,
    timers: clock.timers,
    save: async (changes) => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return { version: 2, changes };
    },
    onSaved: (result, changes) => assert.deepEqual(changes, result.changes),
  });
  autosave.change({ title: "a" });
  await clock.tick(800);
  assert.equal(autosave.snapshot().status, "failed");
  assert.equal(autosave.snapshot().error.message, "offline");
  autosave.change({ body: "b" });
  await clock.tick(800);
  assert.equal(attempts, 2);
  assert.equal(autosave.snapshot().status, "saved");
  // flush() tries a failed save once more, then reports it.
  const broken = createAutosave({
    version: 1,
    timers: clock.timers,
    save: async () => {
      throw new Error("down");
    },
  });
  broken.change({ title: "x" });
  const result = await broken.flush();
  assert.equal(result.status, "failed");
  assert.deepEqual(result.pending, { title: "x" });
});

const note = (overrides) => ({
  id: "1",
  title: "Note",
  body: "",
  color: "#fff4c2",
  pinned: false,
  my_access: "owner",
  owner: { id: "1", name: "Alex" },
  shares: [],
  ...overrides,
});

test("the note palette, tones and color names", () => {
  for (const seeded of ["#fff4c2", "#dff4ff", "#e8f5e9", "#fde7ef"]) {
    assert.ok(
      NOTE_COLORS.some((entry) => entry.value === seeded),
      `${seeded} is in the palette`,
    );
  }
  assert.equal(new Set(NOTE_COLORS.map((entry) => entry.value)).size, 8);
  for (const entry of NOTE_COLORS) {
    assert.match(entry.value, /^#[0-9a-f]{6}$/);
    assert.equal(noteTone(entry.value), "light", entry.label);
  }
  // Colors set through the API can be anything: dark ones get light text.
  assert.equal(noteTone("#1f2937"), "dark");
  assert.equal(colorName("#EFE5FD"), "Lavender");
  assert.equal(colorName("#123456"), "Custom");
  assert.equal(safeNoteColor("red"), NOTE_COLORS[0].value);
  assert.equal(safeNoteColor("#123456"), "#123456");
  assert.equal(noteText({ title: "T", body: "" }), "T");
  assert.equal(noteText({ title: "T", body: "b" }), "T\n\nb");
});

test("notes view: pinned first, filters, search and counts", () => {
  const notes = [
    note({ id: "1", title: "Ideas", pinned: true }),
    note({ id: "2", title: "1:1", body: "career goals" }),
    note({
      id: "3",
      title: "Checklist",
      owner: { id: "4" },
      my_access: "editor",
    }),
    note({ id: "4", title: "Pinned shared", owner: { id: "4" }, pinned: true }),
  ];
  const all = notesView(notes, { meId: "1" });
  assert.deepEqual(
    all.pinned.map((entry) => entry.id),
    ["1", "4"],
  );
  assert.deepEqual(
    all.others.map((entry) => entry.id),
    ["2", "3"],
  );
  assert.deepEqual(all.counts, { all: 4, mine: 2, shared: 2 });
  const shared = notesView(notes, { meId: "1", filter: "shared" });
  assert.deepEqual(
    [...shared.pinned, ...shared.others].map((entry) => entry.id),
    ["4", "3"],
  );
  const search = notesView(notes, { meId: "1", query: " CAREER " });
  assert.deepEqual(
    search.others.map((entry) => entry.id),
    ["2"],
  );
  assert.deepEqual(search.counts, { all: 1, mine: 1, shared: 0 });
  assert.deepEqual(noteCapabilities(notes[2], { id: "1" }), {
    edit: true,
    manage: false,
    viewOnly: false,
    mine: false,
  });
  assert.deepEqual(
    noteCapabilities(note({ my_access: "viewer" }), { id: "2" }),
    {
      edit: false,
      manage: false,
      viewOnly: true,
      mine: false,
    },
  );
  assert.equal(noteCapabilities(notes[0], { id: 1 }).mine, true);
});

/** `ctx.api` for a seeded user over real HTTP (a browser session). */
function apiAs(servers, userId) {
  const client = servers.as(userId);
  return {
    async request(query, variables = {}) {
      const { body } = await client.call(query, variables);
      if (body.errors?.length) throw new ApiError(body.errors);
      return body.data;
    },
  };
}

const DOCUMENTS = { NOTES_QUERY, UPDATE_NOTE_MUTATION, DELETE_NOTE_MUTATION };

test("note documents parse and validate against the real API", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const client = servers.as(servers.ids.users.sam);
  for (const [name, source] of Object.entries(DOCUMENTS)) {
    assert.doesNotThrow(() => parse(source), name);
    const { body } = await client.call(source, {});
    const codes = (body.errors ?? []).map((error) => error.extensions.code);
    assert.equal(codes.includes("GRAPHQL_VALIDATION_FAILED"), false, name);
    assert.equal(codes.includes("GRAPHQL_PARSE_FAILED"), false, name);
  }
});

test("notes stay private, shares set access, saves use versions", async (t) => {
  const servers = await startTestServers();
  t.after(() => servers.close());
  const { users, notes: seeded } = servers.ids;
  const alex = apiAs(servers, users.alex);
  const sam = apiAs(servers, users.sam);
  const alexNotes = await loadNotes(alex);
  assert.deepEqual(
    alexNotes.map((entry) => entry.title),
    ["Ideas for Q1", "1:1 with Sam"],
    "an admin sees only their own notes, pinned first",
  );
  const samNotes = await loadNotes(sam);
  const view = notesView(samNotes, { meId: users.sam, filter: "shared" });
  assert.deepEqual(
    [...view.pinned, ...view.others].map((entry) => entry.title).sort(),
    ["1:1 with Sam", "Launch checklist"],
  );
  assert.equal(view.counts.mine, 1);
  const byTitle = (title) => samNotes.find((entry) => entry.title === title);
  assert.equal(
    noteCapabilities(byTitle("1:1 with Sam"), { id: users.sam }).viewOnly,
    true,
  );
  const checklist = byTitle("Launch checklist");
  assert.deepEqual(noteCapabilities(checklist, { id: users.sam }), {
    edit: true,
    manage: false,
    viewOnly: false,
    mine: false,
  });

  // An editor (through the Marketing team) saves with the version.
  const saved = await saveNote(sam, {
    id: checklist.id,
    changes: { body: "Blog post\nNewsletter", color: "#efe5fd", pinned: true },
    expectedVersion: checklist.version,
  });
  assert.equal(saved.version, checklist.version + 1);
  assert.equal(saved.pinned, true);
  assert.equal(saved.color, "#efe5fd");
  await assert.rejects(
    saveNote(sam, {
      id: checklist.id,
      changes: { title: "Stale" },
      expectedVersion: checklist.version,
    }),
    (error) =>
      error.code === "VERSION_CONFLICT" && error.version === saved.version,
  );
  // Viewers cannot write; only the owner deletes; private notes stay hidden.
  const oneOnOne = byTitle("1:1 with Sam");
  await assert.rejects(
    saveNote(sam, {
      id: oneOnOne.id,
      changes: { body: "x" },
      expectedVersion: oneOnOne.version,
    }),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    sam.request(DELETE_NOTE_MUTATION, { id: checklist.id }),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    saveNote(alex, {
      id: seeded.crit,
      changes: { body: "x" },
      expectedVersion: 1,
    }),
    (error) => error.code === "NOT_FOUND",
    "an admin cannot reach someone else's private note",
  );
  await alex.request(DELETE_NOTE_MUTATION, { id: oneOnOne.id });
  assert.equal(
    (await loadNotes(sam)).some((entry) => entry.id === oneOnOne.id),
    false,
  );
});
