/**
 * Shared data of the import wizard tests: a small Preview (two source
 * workspaces, three people, one existing target) in the shape
 * `server/import/engine.js` returns, and `liveServer(t)`: the real host
 * server with stub connectors, `globalThis.fetch` sending the web app's
 * same-origin requests there as Alex (an admin) for the test.
 */
import { startTestServers } from "./helpers.js";
import { sampleSnapshot } from "./import-engine-fixtures.js";

export const PREVIEW = Object.freeze({
  source_label: "monday.com account Acme",
  workspaces: [
    {
      source_id: "w1",
      name: "Acme",
      target: "new",
      boards: [
        {
          source_id: "b1",
          name: "Roadmap",
          included: true,
          counts: { items: 3, subitems: 1, updates: 2 },
        },
        {
          source_id: "b2",
          name: "Hiring",
          included: false,
          counts: { items: 1, subitems: 0, updates: 0 },
        },
      ],
      docs: [{ source_id: "d1", title: "Handbook", included: true, blocks: 2 }],
    },
    {
      source_id: "w2",
      name: "Archive",
      target: "7",
      boards: [
        {
          source_id: "b3",
          name: "Old",
          included: true,
          counts: { items: 0, subitems: 0, updates: 0 },
        },
      ],
      docs: [],
    },
  ],
  users: [
    {
      source_id: "u1",
      name: "Sam",
      email: "sam@x.test",
      proposal: "match:2",
      action: "match:2",
      match: { id: "2", name: "Sam Lee", email: "sam@x.test" },
    },
    {
      source_id: "u2",
      name: "Nia",
      email: "nia@x.test",
      proposal: "skip",
      action: "skip",
      match: null,
    },
    {
      source_id: "u3",
      name: "Anon",
      email: null,
      proposal: "skip",
      action: "skip",
      match: null,
    },
  ],
  targets: [{ id: "7", name: "Marketing", kind: "open" }],
  warnings: [],
});

/**
 * Starts the servers (see the module comment); the connectors return
 * `sampleSnapshot()` and record the files they were given in `files`.
 */
export async function liveServer(t) {
  const files = [];
  const stub = (source) => ({
    scan: async (args) => {
      if (args.file) files.push(args.file);
      return { ...sampleSnapshot(), source: args.file?.kind ?? source };
    },
  });
  const servers = await startTestServers({
    importConnectors: {
      monday: stub("monday"),
      clickup: stub("clickup"),
      files: stub("csv"),
    },
  });
  t.after(() => servers.close());
  const session = servers.sessionFor(servers.ids.users.alex);
  const original = globalThis.fetch;
  globalThis.fetch = (path, init = {}) =>
    original(new URL(path, servers.hostUrl), {
      ...init,
      headers: { ...init.headers, ...session },
      duplex: init.body instanceof Blob ? "half" : undefined,
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  return { servers, files };
}
