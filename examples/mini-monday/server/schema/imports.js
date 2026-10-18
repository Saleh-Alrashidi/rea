/**
 * Imported boards in the API (SPEC-4 §5): `Board.import` tells where a
 * board came from (shown as a badge with the source link). Anyone who can
 * open the board reads it; `imported_by` resolves through the caller's
 * directory like every other User field. Whether the caller may import
 * at all is `me.capabilities` (`import_data`, from `access.can`).
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
      imported_at:String! imported_by:User`,
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
  },
};
