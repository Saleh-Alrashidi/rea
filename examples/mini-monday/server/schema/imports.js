/**
 * Imported boards in the API (SPEC-4 §5): `Board.import` tells where a
 * board came from (shown as a badge with the source link). Anyone who can
 * open the board reads it; `imported_by` resolves through the caller's
 * directory like every other User field. Whether the caller may import
 * at all is `me.capabilities` (`import_data`, from `access.can`).
 * `source_name` and `folder` say what the source called the board and the
 * folder it sat in (and whether that was private), when the import knew
 * them (absent keys read as null).
 */
import { lookupUser } from "./common.js";

const Board = {
  import: (board) => board.import ?? null,
};

const BoardImport = {
  imported_by: (meta, _a, ctx) => lookupUser(ctx, meta.imported_by),
};

export const definition = {
  types: {
    Board: "import:BoardImport",
    BoardImport: `source:String! source_id:String! source_url:String
      source_name:String folder:ImportFolder imported_at:String! imported_by:User`,
    ImportFolder: "source_id:String! name:String! private:Boolean",
  },
  resolvers: { Board, BoardImport },
  extras: {
    "Board.import": {
      description:
        "Where the board was imported from (monday, clickup, csv or xlsx); null for boards made here.",
    },
    "BoardImport.source_url": {
      description: "The board in its source (http or https), when known.",
    },
    "BoardImport.source_name": {
      description:
        "The board's own name in its source (a ClickUp list's name, without its folder), when known.",
    },
    "BoardImport.folder": {
      description:
        "The source folder the board was in (a ClickUp folder); null when it was in none or the source has none.",
    },
    "ImportFolder.private": {
      description:
        "Whether the source folder was private, as the source said; null when it did not say.",
    },
  },
};
