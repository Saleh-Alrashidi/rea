/**
 * Forms: managed through their board (`access.formAccess`): reading needs
 * viewer access to the board, creating, changing and deleting editor
 * (creating also needs an account role that creates content). The store
 * validates questions against the board's columns. Public pages and
 * submissions are HTTP routes (`server/routes/forms.js`).
 */
import {
  boardAccess,
  requireBoard,
  requireCapability,
  requireForm,
} from "../access.js";
import {
  allBoards,
  badInput,
  notFound,
  parseJson,
  read,
  readName,
  storeResult,
  viewerOf,
  wrapAll,
  write,
} from "./common.js";

const missing = (id) => () => notFound("Form", id);
const given = (value) => value ?? undefined;

const Query = wrapAll(read, {
  forms(_p, { board_id }, ctx) {
    if (board_id !== undefined && board_id !== null) {
      const board = requireBoard(ctx, board_id, "viewer");
      return ctx.store.listForms({ boardId: board.id });
    }
    const viewer = viewerOf(ctx);
    const boards = allBoards(ctx.store).filter(
      (board) => boardAccess(ctx.store, viewer, board) !== null,
    );
    return boards.flatMap((board) =>
      ctx.store.listForms({ boardId: board.id }),
    );
  },
});

function readQuestionsJson(text) {
  if (text === undefined || text === null) return undefined;
  const questions = parseJson(text, "questions_json");
  return Array.isArray(questions)
    ? questions
    : badInput("questions_json must be a JSON array of questions");
}

function updateForm(_p, args, ctx) {
  const form = requireForm(ctx, args.form_id, "editor");
  const target = args.target_group_id;
  const result = ctx.store.updateForm(form.id, {
    title: args.title == null ? undefined : readName(args.title, "Form title"),
    description: args.description,
    accentColor: given(args.accent_color),
    questions: readQuestionsJson(args.questions_json),
    targetGroupId: target === "" ? null : target,
    access: given(args.access),
    submitMessage: args.submit_message,
  });
  return storeResult(result, missing(form.id));
}

const Mutation = wrapAll(write, {
  create_form(_p, args, ctx) {
    const creator = requireCapability(ctx, "create_content");
    const board = requireBoard(ctx, args.board_id, "editor");
    const result = ctx.store.createForm({
      boardId: board.id,
      title: readName(args.title, "Form title"),
      creatorId: creator.id,
    });
    return storeResult(result, () => notFound("Board", board.id));
  },
  update_form: updateForm,
  regenerate_form_link(_p, args, ctx) {
    const form = requireForm(ctx, args.form_id, "editor");
    return storeResult(
      ctx.store.regenerateFormToken(form.id),
      missing(form.id),
    );
  },
  delete_form(_p, args, ctx) {
    const form = requireForm(ctx, args.form_id, "editor");
    return storeResult(ctx.store.deleteForm(form.id), missing(form.id));
  },
});

const Form = {
  board: (form, _a, { store }) => store.getBoard(form.board_id),
  questions_json: (form) => JSON.stringify(form.questions),
  public_url: (form, _a, { hostOrigin }) => `${hostOrigin}/f/${form.token}`,
};

export const definition = {
  types: {
    Query: "forms(board_id:ID):[Form!]!",
    Board: "forms:[Form!]!",
    Form: `id:ID! board:Board! title:String! description:String
      accent_color:String! questions_json:String! target_group_id:String
      access:FormAccess! public_url:String! submit_message:String
      response_count:Int! created_at:String! updated_at:String!`,
    Mutation: `create_form(board_id:ID!,title:String!):Form!
      update_form(form_id:ID!,title:String,description:String,accent_color:String,questions_json:String,target_group_id:String,access:FormAccess,submit_message:String):Form!
      regenerate_form_link(form_id:ID!):Form!
      delete_form(form_id:ID!):Form!`,
  },
  resolvers: {
    Query,
    Mutation,
    Form,
    Board: {
      forms: (board, _a, { store }) => store.listForms({ boardId: board.id }),
    },
  },
  extras: {
    "Query.forms": { description: "Forms on boards the caller can access." },
  },
};
