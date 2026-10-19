/**
 * The Worklane (mini-monday) GraphQL API: merges the schema modules in
 * `server/schema/` into one `buildSchema` call (see SPEC.md
 * "server/schema.js" and SPEC-2 §3).
 *
 * Each module exports `definition = { enums?, types, resolvers?, extras? }`
 * where `types` maps a type name to field specs
 * `name(arg:Type=default,...):Type` separated by whitespace (defaults are
 * JSON). Several modules may add fields to one type (Query, Mutation,
 * Board); a field or enum defined twice is an error.
 *
 * Resolvers receive the context built by `server/routes/graphql.js`:
 * `{ store, principal, apiVersion, hostOrigin, appsOrigin, log,
 * requireScope(scope) }`. Every root field checks its scope first and all
 * authorization goes through `server/access.js`.
 */
import { buildSchema } from "./graphql/schema.js";
import { definition as boards } from "./schema/boards.js";
import { definition as common } from "./schema/common.js";
import { definition as docs } from "./schema/docs.js";
import { definition as folders } from "./schema/folders.js";
import { definition as forms } from "./schema/forms.js";
import { definition as imports } from "./schema/imports.js";
import { definition as inbox } from "./schema/inbox.js";
import { definition as items } from "./schema/items.js";
import { definition as notes } from "./schema/notes.js";
import { definition as people } from "./schema/people.js";
import { definition as search } from "./schema/search.js";
import { definition as sharing } from "./schema/sharing.js";
import { definition as storage } from "./schema/storage.js";
import { definition as updates } from "./schema/updates.js";
import { definition as workspaces } from "./schema/workspaces.js";

const MODULES = [
  common,
  people,
  boards,
  items,
  updates,
  storage,
  workspaces,
  sharing,
  docs,
  notes,
  forms,
  folders,
  inbox,
  search,
  imports,
];

const FIELD_SPEC = /^(\w+)(?:\(([^)]*)\))?:(\S+)$/;
const ARG_SPEC = /^(\w+):([^=]+)(?:=(.+))?$/;

function parseArg(text) {
  const [, name, type, value] = ARG_SPEC.exec(text) ?? [];
  if (!name) throw new Error(`Invalid argument spec ${text}`);
  const defaults =
    value === undefined ? {} : { defaultValue: JSON.parse(value) };
  return [name, { type, ...defaults }];
}

/** Parses one module's field specs for `typeName` into field definitions. */
function fieldsOf(module, typeName) {
  const resolvers = module.resolvers?.[typeName] ?? {};
  const entries = module.types[typeName].trim().split(/\s+/);
  const fields = entries.map((entry) => {
    const [, name, argList, type] = FIELD_SPEC.exec(entry) ?? [];
    if (!name) throw new Error(`Invalid field spec ${entry}`);
    const field = { type, ...module.extras?.[`${typeName}.${name}`] };
    if (argList)
      field.args = Object.fromEntries(argList.split(",").map(parseArg));
    if (resolvers[name]) field.resolve = resolvers[name];
    return [name, field];
  });
  const unknown = Object.keys(resolvers).filter(
    (name) => !fields.some(([field]) => field === name),
  );
  if (unknown.length > 0) {
    throw new Error(`Resolvers without fields: ${typeName}.${unknown}`);
  }
  return fields;
}

/** Merges the module definitions; duplicate fields or enums throw. */
function mergeModules(modules) {
  const enums = {};
  const types = {};
  for (const module of modules) {
    for (const [name, values] of Object.entries(module.enums ?? {})) {
      if (Object.hasOwn(enums, name)) throw new Error(`Duplicate enum ${name}`);
      enums[name] = values;
    }
    for (const typeName of Object.keys(module.types)) {
      types[typeName] ??= { fields: {} };
      for (const [name, field] of fieldsOf(module, typeName)) {
        if (Object.hasOwn(types[typeName].fields, name)) {
          throw new Error(`Duplicate field ${typeName}.${name}`);
        }
        types[typeName].fields[name] = field;
      }
    }
  }
  return { enums, types };
}

/**
 * Builds the API schema: part-1 boards API (snake_case as in monday.com's
 * API, cursor pagination, the version-gated `Board.items` and `Item.url`)
 * plus the SPEC-2 workspace product (people, workspaces, sharing, docs,
 * notes, forms, inbox, search), SPEC-4 `Board.import` and the SPEC-6
 * Spaces, folders and moves.
 */
export function createSchema() {
  const { enums, types } = mergeModules(MODULES);
  return buildSchema({ enums, types, query: "Query", mutation: "Mutation" });
}
