/**
 * App storage (part 1): only the app principal of an install reaches its
 * own instance segment (`install:<id>`) and its app's global segment
 * (`app:<appId>`). App principals exist only for installs on boards their
 * user can access (`server/auth.js` asks `server/access.js`), and they act
 * as that user: reading needs viewer access to the install's board,
 * writing or deleting needs editor (SPEC-2 §1.2), so viewers never change
 * state that every user of the board view sees.
 */
import { requireInstall } from "../access.js";
import { badInput, fail } from "./common.js";

const MAX_STORAGE_KEY_LENGTH = 256;
const MAX_STORAGE_VALUE_LENGTH = 65_536;

/** True when `text` has a C0 control character (U+0000-U+001F) or U+007F. */
const hasControlCharacter = (text) =>
  Array.prototype.some.call(text, (unit) => unit < " " || unit === "\x7f");

const ACCESS = Object.freeze({
  "storage:read": "viewer",
  "storage:write": "editor",
});

/**
 * Checks `scope`, that the caller is the app principal of `install_id` and
 * that its user has the board role the scope needs, validates the key and
 * returns the storage scope key of the segment.
 */
function storageScope(ctx, args, scope) {
  ctx.requireScope(scope);
  const { principal } = ctx;
  if (principal?.kind !== "app" || args.install_id !== principal.installId) {
    fail("FORBIDDEN", "App storage is only available to the install's app");
  }
  requireInstall(ctx, principal.installId, ACCESS[scope]);
  const { length } = args.key;
  if (length < 1 || length > MAX_STORAGE_KEY_LENGTH) {
    badInput(`Storage keys must be 1-${MAX_STORAGE_KEY_LENGTH} characters`);
  }
  if (hasControlCharacter(args.key)) {
    badInput("Storage keys must not contain control characters");
  }
  const { installId, appId } = principal;
  return args.segment === "instance" ? `install:${installId}` : `app:${appId}`;
}

const writeResult = ({ success, version, reason }) => ({
  success,
  version: version ?? null,
  reason: reason ?? null,
});

function setAppStorage(_parent, args, ctx) {
  const scopeKey = storageScope(ctx, args, "storage:write");
  if (args.value.length > MAX_STORAGE_VALUE_LENGTH) {
    badInput(`Storage values must be at most ${MAX_STORAGE_VALUE_LENGTH}`);
  }
  const previous = args.previous_version ?? null;
  if (previous !== null && previous < 0) {
    badInput("previous_version must not be negative");
  }
  const { key, value } = args;
  const result = ctx.store.setAppStorage(scopeKey, key, value, previous);
  if (result.ok === false) badInput(result.message ?? result.reason);
  return writeResult(result);
}

const STORAGE_ARGS = "install_id:ID!,segment:StorageSegment!,key:String!";

export const definition = {
  types: {
    Query: `app_storage(${STORAGE_ARGS}):StorageValue`,
    StorageValue: "key:String! value:String! version:Int!",
    StorageWriteResult: "success:Boolean! version:Int reason:String",
    Mutation: `set_app_storage(${STORAGE_ARGS},value:String!,previous_version:Int):StorageWriteResult!
      delete_app_storage(${STORAGE_ARGS}):StorageWriteResult!`,
  },
  resolvers: {
    Query: {
      app_storage(_parent, args, ctx) {
        const scopeKey = storageScope(ctx, args, "storage:read");
        const entry = ctx.store.getAppStorage(scopeKey, args.key);
        return entry ? { key: args.key, ...entry } : null;
      },
    },
    Mutation: {
      set_app_storage: setAppStorage,
      delete_app_storage(_parent, args, ctx) {
        const scopeKey = storageScope(ctx, args, "storage:write");
        return writeResult(ctx.store.deleteAppStorage(scopeKey, args.key));
      },
    },
  },
  extras: {
    "Query.app_storage": { description: "App storage (app sessions only)." },
  },
};
