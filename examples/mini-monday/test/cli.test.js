import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSafeEndpoint,
  main,
  operationType,
  parseArgs,
  UsageError,
} from "../cli/mm.js";

const CLI_PATH = fileURLToPath(new URL("../cli/mm.js", import.meta.url));
const HELPERS_PATH = fileURLToPath(new URL("./helpers.js", import.meta.url));
const CLOSED = { MM_ENDPOINT: "http://127.0.0.1:9/v2", MM_TOKEN: "t" };

/** Splits a block of lines into argv arrays (words split on whitespace). */
const argvLines = (text) =>
  text
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));

function sink() {
  const target = { text: "" };
  target.write = (chunk) => {
    target.text += chunk;
    return true;
  };
  return target;
}

/** Runs main() in-process with an explicit env (never the ambient one). */
async function run(argv, env = {}) {
  const [stdout, stderr] = [sink(), sink()];
  const code = await main(argv, { env, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Runs an executable in a child process. */
function spawnCli(file, args, env = {}) {
  const options = { env: { ...process.env, ...env }, timeout: 30_000 };
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

/** A local HTTP(S) server recording every request; `handler` responds. */
async function fakeServer(t, handler, create = http.createServer) {
  const requests = [];
  const server = create(async (req, res) => {
    res.on("error", () => {});
    let body = "";
    for await (const chunk of req) body += chunk;
    const { method, url, headers } = req;
    requests.push({ method, url, headers, body: body && JSON.parse(body) });
    handler(req, res, requests.at(-1));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `127.0.0.1:${server.address().port}`;
  const env = { MM_ENDPOINT: `http://${origin}/v2`, MM_TOKEN: "t" };
  return { requests, origin, env };
}

const sendJson = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

// ---------------------------------------------------------------- parseArgs

test("parseArgs reads bare and explicit --read-only", () => {
  assert.equal(parseArgs(["me"]).options.readOnly, false);
  assert.equal(parseArgs(["me", "--read-only"]).options.readOnly, true);
  assert.equal(parseArgs(["--read-only=true", "me"]).options.readOnly, true);
  assert.equal(parseArgs(["me", "--read-only=false"]).options.readOnly, false);
  for (const bad of ["--read-only=yes", "--read-only=", "--read-only=1"]) {
    assert.throws(() => parseArgs(["me", bad]), UsageError, bad);
  }
  // A bare flag never swallows the next word.
  const parsed = parseArgs(["--read-only", "items", "4"]);
  assert.deepEqual([parsed.command, parsed.positionals], ["items", ["4"]]);
});

test("parseArgs rejects bad options, commands and positionals", () => {
  const cases = argvLines(`
    me --frob
    me -x
    me --Endpoint http://localhost/v2
    me --json --json
    boards --group topics
    me --variables {}
    me --token
    me --token --json
    me --endpoint=
    me --timeout 0
    me --timeout 1.5
    me --api-version latest
    query {me{id}} --variables [1]
    query {me{id}} --variables {bad
    --json
    frobnicate
    items
    create-item 4
    set-status 4 5
    query
    me extra
  `);
  for (const argv of [[], ["items", " "], ...cases]) {
    assert.throws(() => parseArgs(argv), UsageError, argv.join(" "));
  }
  // The rejected option's value is not echoed (it may be a secret).
  assert.throws(
    () => parseArgs(["me", "--tokn=s3cret"]),
    (error) => /--tokn/.test(error.message) && !/s3cret/.test(error.message),
  );
  assert.equal(parseArgs(["--help"]).command, null);
  assert.equal(parseArgs(["items", "--help"]).options.help, true);
});

test("parseArgs returns command, positionals and typed options", () => {
  const words =
    "create-item --endpoint=https://mm.example/v2 4 --group next_up " +
    "--timeout 2500 --token=--starts-with-dashes --";
  const parsed = parseArgs([...words.split(" "), "--literal name"]);
  assert.equal(parsed.command, "create-item");
  assert.deepEqual(parsed.positionals, ["4", "--literal name"]);
  assert.equal(parsed.options.endpoint, "https://mm.example/v2");
  assert.equal(parsed.options.group, "next_up");
  assert.equal(parsed.options.timeout, 2500);
  assert.equal(parsed.options.token, "--starts-with-dashes");
  assert.equal(parsed.options.json, false);
  const query = parseArgs(["query", "{ me { id } }", "--variables", '{"a":1}']);
  assert.deepEqual(query.options.variables, { a: 1 });
});

test("main exits 2 on usage errors and 0 for --help", async () => {
  const unknown = await run(["me", "--frob"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown option --frob[\s\S]*mm --help/);
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: mm <command>/);
  const noToken = await run(["me"], { MM_ENDPOINT: CLOSED.MM_ENDPOINT });
  assert.equal(noToken.code, 2);
  assert.match(noToken.stderr, /MM_TOKEN/);
});

// ------------------------------------------------------ assertSafeEndpoint

test("assertSafeEndpoint allows https and loopback-only http", async () => {
  const allowed = `
    http://localhost:4100/v2 http://LOCALHOST/v2 http://127.0.0.1/v2
    http://127.0.0.5:8080/v2 http://127.1/v2 http://[::1]:4100/v2
    https://example.com/v2 https://10.0.0.8/v2`;
  for (const url of allowed.trim().split(/\s+/)) {
    assert.ok(assertSafeEndpoint(url) instanceof URL, url);
  }
  const refused = `
    http://example.com/v2 http://10.0.0.8/v2 http://0.0.0.0/v2
    http://127.0.0.1.example.com/v2 http://localhost.example.com/v2
    http://[::ffff:127.0.0.1]/v2 ftp://localhost/v2 file:///etc/passwd
    https://user:pass@example.com/v2 localhost:4100/v2 not-a-url`;
  for (const url of refused.trim().split(/\s+/)) {
    assert.throws(() => assertSafeEndpoint(url), UsageError, url);
  }
  const env = { MM_ENDPOINT: "http://example.com/v2", MM_TOKEN: "t" };
  const result = await run(["me"], env);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /non-loopback host example\.com.*https:/);
});

// ----------------------------------------------------------- operationType

test("operationType uses the GraphQL parser", () => {
  const cases = [
    ["{ me { id } }", "query"],
    ["query { me { id } }", "query"],
    ["query Me($n: Int = 1) { me { id } }", "query"],
    ['mutation { create_board(board_name: "x") { id } }', "mutation"],
    ["mutation Named($n: ID!) { delete_item(item_id: $n) { id } }", "mutation"],
    ["# mutation in a comment\n{ me { id } }", "query"],
    ["# a comment\nmutation { delete_item(item_id: 1) { id } }", "mutation"],
    ['{ me(note: "mutation { x }") { id } }', "query"],
    [",,\n\tquery { me { id } }", "query"],
    ["query A { me { id } } mutation B { x { id } }", "mutation"],
    ["fragment F on User { id }", null],
    ["subscription { changes { id } }", null],
    ["{ me { id }", null],
    ["", null],
  ];
  for (const [source, expected] of cases) {
    assert.equal(operationType(source), expected, source);
  }
  assert.equal(operationType(42), null);
});

// -------------------------------------------------------- read-only and TLS

test("read-only refuses mutations with exit 3 before sending", async (t) => {
  const data = { me: { id: "1" }, create_item: { id: "9", name: "N" } };
  const server = await fakeServer(t, (req, res) => sendJson(res, { data }));
  const refused = [
    ["--read-only", "create-item", "4", "Name"],
    ["--read-only=true", "set-status", "4", "5", "Done"],
    ["query", "mutation { delete_item(item_id: 1) { id } }", "--read-only"],
    ["query", "{ me { id }", "--read-only"],
  ];
  for (const argv of refused) {
    const result = await run(argv, server.env);
    assert.equal(result.code, 3, argv.join(" "));
    assert.match(result.stderr, /read-only mode refused/);
  }
  assert.equal(server.requests.length, 0);
  const query = await run(
    ["--read-only", "query", "{ me { id } }"],
    server.env,
  );
  assert.equal(query.code, 0);
  const off = ["--read-only=false", "create-item", "4", "N"];
  assert.equal((await run(off, server.env)).stdout, "Created item 9 N\n");
  assert.equal(server.requests.length, 2);
});

test("cli/mm.js never disables TLS verification", async () => {
  const source = await readFile(CLI_PATH, "utf8");
  assert.equal(source.includes("rejectUnauthorized"), false);
  assert.equal(source.includes("NODE_TLS_REJECT_UNAUTHORIZED"), false);
});

test("--ca-file trusts a private CA; without it TLS fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mm-cli-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [key, cert] = [join(dir, "key.pem"), join(dir, "cert.pem")];
  const args =
    "req -x509 -newkey rsa:2048 -nodes -days 1 -keyout KEY -out CERT " +
    "-subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1";
  const paths = { KEY: key, CERT: cert };
  const argv = args.split(" ").map((word) => paths[word] ?? word);
  if ((await spawnCli("openssl", argv)).code !== 0) {
    return t.skip("openssl is not available");
  }
  const tlsOptions = { key: await readFile(key), cert: await readFile(cert) };
  const create = (handler) => https.createServer(tlsOptions, handler);
  const me = { id: "1", name: "Alex Rivera", email: "a@x", is_admin: true };
  const respond = (req, res) => sendJson(res, { data: { me } });
  const server = await fakeServer(t, respond, create);
  const env = { MM_ENDPOINT: `https://${server.origin}/v2`, MM_TOKEN: "t" };
  const untrusted = await run(["me"], env);
  assert.equal(untrusted.code, 1);
  assert.match(untrusted.stderr, /--ca-file/);
  assert.equal(server.requests.length, 0);
  const trusted = await run(["me", "--ca-file", cert], env);
  assert.equal(trusted.code, 0, trusted.stderr);
  assert.match(trusted.stdout, /Name\s+Alex Rivera/);
  const notPem = join(dir, "not.pem");
  await writeFile(notPem, "hello");
  for (const file of [notPem, join(dir, "missing.pem")]) {
    assert.equal((await run(["me", "--ca-file", file], env)).code, 2);
  }
  assert.equal((await run(["me", "--ca-file", cert], CLOSED)).code, 2);
});

// ---------------------------------------------------------------- transport

test("requests carry the token, API version and typed variables", async (t) => {
  const me = { id: "1", name: "A", email: "a@x", is_admin: false };
  const updated = { id: "5", name: "N", column_values: [] };
  const data = { me, change_simple_column_value: updated };
  const server = await fakeServer(t, (req, res) => sendJson(res, { data }));
  const env = { ...server.env, MM_TOKEN: "env-token" };
  const label = 'Done") { id } } mutation { delete_board(board_id: 4';
  const argv = ["set-status", "4", "5", label, "--api-version", "2026-04"];
  const result = await run(argv, env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "", "no token warning for MM_TOKEN");
  const [request] = server.requests;
  assert.deepEqual([request.method, request.url], ["POST", "/v2"]);
  assert.equal(request.headers.authorization, "Bearer env-token");
  assert.equal(request.headers["api-version"], "2026-04");
  assert.match(request.headers["content-type"], /^application\/json/);
  assert.deepEqual(request.body.variables, { board: "4", item: "5", label });
  assert.equal(operationType(request.body.query), "mutation");
  assert.doesNotMatch(request.body.query, /delete_board/);
  const flag = await run(["me", "--token", "cli-token"], env);
  assert.match(flag.stderr, /warning: --token is visible to other local/);
  assert.equal(server.requests[1].headers.authorization, "Bearer cli-token");
});

test("responses over 10 MiB are aborted", async (t) => {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  const streamed = await fakeServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    let sent = 0;
    const pump = () => {
      while (sent < 12) {
        sent += 1;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      return res.end();
    };
    pump();
  });
  const declared = await fakeServer(t, (req, res) => {
    res.writeHead(200, { "content-length": String(11 * 1024 * 1024) });
    res.write("{");
  });
  for (const server of [streamed, declared]) {
    const result = await run(["me"], server.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /exceeds 10 MiB/);
  }
});

test("--timeout aborts a request that never answers", async (t) => {
  const server = await fakeServer(t, () => {});
  const started = Date.now();
  const result = await run(["me", "--timeout", "150"], server.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out after 150 ms/);
  assert.ok(Date.now() - started < 5000);
});

test("HTTP and GraphQL failures exit 1 with their messages", async (t) => {
  const error = { message: "Missing scope", extensions: { code: "FORBIDDEN" } };
  const server = await fakeServer(t, (req, res, { body }) => {
    if (body.query.includes("CliMe")) {
      return sendJson(res, { errors: [error], data: null });
    }
    res.writeHead(502, { "content-type": "text/html" });
    return res.end("<h1>Bad gateway</h1>");
  });
  const forbidden = await run(["me"], server.env);
  assert.equal(forbidden.code, 1);
  assert.match(forbidden.stderr, /Missing scope \[FORBIDDEN\]/);
  const gateway = await run(["boards"], server.env);
  assert.equal(gateway.code, 1);
  assert.match(gateway.stderr, /unexpected HTTP 502/);
  assert.equal((await run(["me"], CLOSED)).code, 1);
});

test("server text is escaped for terminals; --json stays exact", async (t) => {
  // ESC (a CSI sequence), RIGHT-TO-LEFT OVERRIDE and NEXT LINE (C1).
  const [esc, rlo, nel] = [0x1b, 0x202e, 0x85].map((c) =>
    String.fromCharCode(c),
  );
  const name = `${esc}[2Jevil${rlo}name${nel}`;
  const boards = [{ id: "1", name, items_count: 0 }];
  const respond = (req, res) => sendJson(res, { data: { boards } });
  const server = await fakeServer(t, respond);
  const table = await run(["boards"], server.env);
  assert.equal(table.code, 0);
  assert.match(table.stdout, /^ID\s+NAME\s+ITEMS\n1\s+/);
  assert.ok(table.stdout.includes("\\u001b[2Jevil\\u202ename\\u0085"));
  const json = await run(["boards", "--json"], server.env);
  for (const output of [table.stdout, json.stdout]) {
    assert.ok(![esc, rlo, nel].some((char) => output.includes(char)));
  }
  assert.deepEqual(JSON.parse(json.stdout), boards);
});

test("schema fetches SDL from get_schema without the token", async (t) => {
  const server = await fakeServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("type Query {\n  me: User!\n}");
  });
  const result = await run(["schema", "--api-version", "2026-04"], server.env);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "type Query {\n  me: User!\n}\n");
  const [request] = server.requests;
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/v2/get_schema?version=2026-04&format=sdl");
  assert.equal(request.headers.authorization, undefined);
});

test("the executable has a shebang and runs main only when run", async () => {
  const source = await readFile(CLI_PATH, "utf8");
  assert.ok(source.startsWith("#!/usr/bin/env node\n"));
  assert.notEqual(statSync(CLI_PATH).mode & 0o111, 0, "chmod +x");
  const help = await spawnCli(CLI_PATH, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: mm/);
  const usage = await spawnCli(process.execPath, [CLI_PATH, "--bogus"]);
  assert.equal(usage.code, 2);
});

test("a reader that closes early ends the output quietly", async (t) => {
  // Far more than a pipe buffer, so writes continue after the reader left.
  const data = { notes: "x".repeat(2 * 1024 * 1024) };
  const server = await fakeServer(t, (req, res) => sendJson(res, { data }));
  const child = spawn(process.execPath, [CLI_PATH, "query", "{ notes }"], {
    env: { ...process.env, ...server.env },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  await once(child.stdout, "data");
  child.stdout.destroy();
  const [code] = await once(child, "close");
  assert.deepEqual({ code, stderr }, { code: 0, stderr: "" });
});

// ------------------------------------------------- end to end (real server)

/** Starts the real servers through test/helpers.js (another module's file). */
async function realServers(t) {
  if (!existsSync(HELPERS_PATH)) {
    t.skip("test/helpers.js is not available yet");
    return null;
  }
  const { startTestServers } = await import("./helpers.js");
  const servers = await startTestServers();
  t.after(() => servers.close());
  const endpoint = new URL("/v2", servers.hostUrl).href;
  const env = (token = servers.tokens.readWrite) => ({
    MM_ENDPOINT: endpoint,
    MM_TOKEN: token,
  });
  const boards = servers.store.listBoards();
  const roadmap = boards.find((board) => board.name === "Product roadmap");
  return { ...servers, endpoint, env, roadmap };
}

test("e2e: me, boards and items print tables and JSON", async (t) => {
  const real = await realServers(t);
  if (!real) return;
  const me = await run(["me"], real.env());
  assert.equal(me.code, 0, me.stderr);
  assert.match(me.stdout, /Name\s+Alex Rivera/);
  const boards = await run(["boards"], real.env());
  assert.match(boards.stdout, /^ID\s+NAME\s+ITEMS\n/);
  assert.match(boards.stdout, /Product roadmap\s+8\n/);
  assert.match(boards.stdout, /Marketing launch\s+3\n/);
  const boardId = real.roadmap.id;
  const items = await run(["items", boardId], real.env(real.tokens.readOnly));
  assert.equal(items.code, 0, items.stderr);
  const lines = items.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "Product roadmap: 8 item(s)");
  assert.match(lines[1], /^ID\s+NAME\s+GROUP\s+STATUS\s+OWNER$/);
  assert.equal(lines.length, 10);
  const json = await run(["items", boardId, "--json"], real.env());
  const stored = real.store.listItems({ boardId, limit: 500 }).items;
  const ids = JSON.parse(json.stdout).items.map((item) => item.id);
  assert.deepEqual(
    ids,
    stored.map((item) => item.id),
  );
  assert.equal((await run(["items", "999999"], real.env())).code, 1);
});

test("e2e: items pages a large, wide board within the field budget", async (t) => {
  const real = await realServers(t);
  if (!real) return;
  const { store } = real;
  const board = store.createBoard({ name: "Wide", creatorId: "1" });
  for (let n = 0; n < 12; n += 1) {
    store.createColumn(board.id, { title: `Extra ${n}`, type: "text" });
  }
  for (let n = 0; n < 450; n += 1) {
    store.createItem({ boardId: board.id, name: `Item ${n}`, creatorId: "1" });
  }
  // One 500-item page of this board would exceed the 5,000-field budget.
  const json = await run(["items", board.id, "--json"], real.env());
  assert.equal(json.code, 0, json.stderr);
  const ids = JSON.parse(json.stdout).items.map((item) => item.id);
  const stored = store.listItems({ boardId: board.id, limit: 500 }).items;
  assert.deepEqual(
    ids,
    stored.map((item) => item.id),
  );
  const text = await run(["items", board.id], real.env());
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Wide: 450 item\(s\)\n/);
});

test("e2e: create-item and set-status write; read-only refuses", async (t) => {
  const real = await realServers(t);
  if (!real) return;
  const boardId = real.roadmap.id;
  const argv = ["create-item", boardId, "CLI item", "--group", "next_up"];
  const created = await run([...argv, "--json"], real.env());
  assert.equal(created.code, 0, created.stderr);
  const item = JSON.parse(created.stdout);
  assert.equal(real.store.getItem(item.id).group_id, "next_up");
  const status = await run(
    ["set-status", boardId, item.id, "Done"],
    real.env(),
  );
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /: Done\n$/);
  assert.deepEqual(real.store.getItem(item.id).values.status, { index: 1 });
  const before = real.store.countItems(boardId);
  const refused = await run(["--read-only", ...argv], real.env());
  assert.equal(refused.code, 3);
  const scoped = await run(argv, real.env(real.tokens.readOnly));
  assert.equal(scoped.code, 1);
  assert.match(scoped.stderr, /FORBIDDEN/);
  assert.equal(real.store.countItems(boardId), before);
  const label = await run(["set-status", boardId, item.id, "Nope"], real.env());
  assert.equal(label.code, 1);
  assert.match(label.stderr, /BAD_USER_INPUT/);
});

test("e2e: query, API versions and schema", async (t) => {
  const real = await realServers(t);
  if (!real) return;
  const query = await run(["query", "{ me { name } }"], real.env());
  assert.equal(query.code, 0, query.stderr);
  assert.equal(JSON.parse(query.stdout).data.me.name, "Alex Rivera");
  const [first] = real.store.listItems({ boardId: real.roadmap.id }).items;
  const urlQuery = "query Url($ids: [ID!]!) { items(ids: $ids) { url } }";
  const argv = ["query", urlQuery, "--variables", `{"ids":["${first.id}"]}`];
  const current = await run(argv, real.env());
  assert.equal(current.code, 1, "Item.url is not in the current version");
  const next = await run([...argv, "--api-version", "2026-04"], real.env());
  assert.equal(next.code, 0, next.stderr);
  assert.match(JSON.parse(next.stdout).data.items[0].url, /#\/boards\//);
  const sdl = await run(["schema"], { MM_ENDPOINT: real.endpoint });
  assert.equal(sdl.code, 0, sdl.stderr);
  assert.match(sdl.stdout, /type Query/);
  const sdlNext = await run(["schema", "--api-version", "2026-04"], real.env());
  assert.notEqual(sdlNext.stdout, sdl.stdout);
  const old = await run(["schema", "--api-version", "1999-01"], real.env());
  assert.equal(old.code, 1);
  assert.match(old.stderr, /UNSUPPORTED_API_VERSION/);
  const badToken = await run(["me"], real.env("not-a-real-token"));
  assert.equal(badToken.code, 1);
  assert.match(badToken.stderr, /UNAUTHENTICATED/);
});

test("e2e: the executable talks to the real server", async (t) => {
  const real = await realServers(t);
  if (!real) return;
  const args = [CLI_PATH, "boards", "--json"];
  const result = await spawnCli(process.execPath, args, real.env());
  assert.equal(result.code, 0, result.stderr);
  const names = JSON.parse(result.stdout).map((board) => board.name);
  assert.ok(names.includes("Product roadmap"));
});
