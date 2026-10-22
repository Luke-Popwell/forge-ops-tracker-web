// Finds the SQL behind a database error and reduces it to something safe to send: the names of
// the stored procedures, tables and views it touched, and (only if Configuration#
// captureSqlStatement is on) the statement itself with every string and number replaced by "?".
// Ported from sdks/node/src/sqlStatement.js, which is itself ported from the server's own
// SqlStatementMasker/SqlObjectExtractor: same rules everywhere, and the server applies them again
// on arrival, so a difference here can only ever mean less is masked client-side, never that
// something unmasked gets stored.
//
// Deliberately a single pass over a few patterns, not a SQL parser. What it recognizes:
//   * 'single quoted' strings, with '' or a backslash as the escape ('it''s', 'o\'brien'),
//     including one cut off by truncation, even right after a backslash (masked to the end,
//     never left half-visible)
//   * a string's type prefix along with it (E'', X'', N'', B'', U&''), so X'DEADBEEF' is one "?"
//   * $tag$ dollar-quoted strings (PostgreSQL function bodies and DO blocks)
//   * numbers: integers, decimals, exponents (3e10, 1.5E-3), hex (0x1F) and binary (0b101), but
//     never the digits inside an identifier (orders2, $1 placeholders, sp_v2)
//   * "double quoted" strings, but only for MySQL and MariaDB, where that's a string rather than
//     a name; everywhere else a column named "user id" is left alone
//
// No regex lookbehind: an older browser engine would fail to even parse one. The server only
// takes a prefix, and only counts a number, when the character before it isn't part of a word,
// so mask() checks that character itself and, when it is, does what a failed lookbehind does: no
// match there, and the search goes on one character later.

const MASK = "?";
const MAX_LENGTH = 4000;
const MAX_NAMES = 10;
const MAX_NAME_LENGTH = 200;
const MAX_CAUSE_DEPTH = 5;

const STRING = String.raw`(?:[EeXxNnBb]|[Uu]&)?'(?:[^'\\]|\\(?:[\s\S]|$)|'')*(?:'|$)`;
const DOUBLE_QUOTED_STRING = String.raw`"(?:[^"\\]|\\(?:[\s\S]|$)|"")*(?:"|$)`;
const DOLLAR_QUOTED = String.raw`(\$[A-Za-z_]*\$)[\s\S]*?(?:\1|$)`;
const NUMBER = String.raw`(0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(?!\w)`;
// 1: dollar-quote tag  2: a number; a match with neither is a string literal
const LITERAL = new RegExp(`${STRING}|${DOLLAR_QUOTED}|${NUMBER}`, "g");
const LITERAL_WITH_DOUBLE_QUOTES = new RegExp(`${STRING}|${DOUBLE_QUOTED_STRING}|${DOLLAR_QUOTED}|${NUMBER}`, "g");
// db.system values where "double quotes" are a string, not a name.
const DOUBLE_QUOTED_STRING_SYSTEMS = new Set(["mysql", "mariadb"]);
const PART_OF_WORD = /[\w$]/;
const PART_OF_NUMBER_OR_WORD = /[\w$.]/;
const STRING_PREFIX = /^(?:[EeXxNnBb]|[Uu]&)(?=')/;

const PART = '(?:[\\w$#@]+|"[^"]+"|\\[[^\\]]+\\]|`[^`]+`)';
const NAME = `${PART}(?:\\.${PART})*`;
const OPERATIONS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH", "CALL", "EXEC", "EXECUTE", "CREATE", "ALTER", "DROP", "TRUNCATE"]);
const PROCEDURE_CALL = new RegExp(`\\b(?:CALL|EXEC(?:UTE)?|PERFORM)\\s+(?!IMMEDIATE\\b|FUNCTION\\b|PROCEDURE\\b)(${NAME})`, "gi");
const RELATION = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|TABLE)\\s+(${NAME})(\\s*\\()?`, "gi");
const SELECT_FUNCTION = new RegExp(`^\\s*SELECT\\s+(${NAME})\\s*\\(`, "i");
const BUILTINS = new Set([
  "count", "sum", "min", "max", "avg", "now", "coalesce", "nullif", "lower", "upper", "length", "concat",
  "cast", "date_trunc", "current_timestamp", "current_date", "row_number", "rank", "json_build_object",
  "json_agg", "array_agg",
]);
const FROM_INSIDE_FUNCTION = /\b(?:EXTRACT|SUBSTRING|TRIM|OVERLAY)\s*\([^()]*\)/gi;
const KEYWORDS_NOT_NAMES = new Set(["select", "set", "values", "where", "lateral", "only", "unnest", "generate_series"]);
const FULL_NAME = new RegExp(`^${NAME}$`);
const FROM_WORD = /\bFROM\b/i;

// Properties that carry the statement on the errors JavaScript database libraries raise:
// Sequelize and mysql2 use .sql (Sequelize also nests the driver's own error under
// .parent/.original), TypeORM's QueryFailedError uses .query. Only a string counts, never an
// object that happens to share the name.
const STATEMENT_PROPERTIES = ["sql", "query"];

export interface SqlObjects {
  operation?: string;
  procedures: string[];
  relations: string[];
}

/**
 * The raw statement off the error itself or, for an app that wraps a database error in its own
 * exception, off whatever it was raised from (.cause, or Sequelize's .parent/.original).
 */
export function findIn(error: unknown): string | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  let depth = 0;
  while (queue.length > 0 && depth < MAX_CAUSE_DEPTH * 3) {
    const current = queue.shift() as Record<string, unknown> | null | undefined;
    depth += 1;
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const property of STATEMENT_PROPERTIES) {
      const value = current[property];
      if (typeof value === "string" && value.trim() !== "") {
        return value;
      }
    }
    queue.push(current["cause"], current["parent"], current["original"]);
  }
  return null;
}

/**
 * `system` is the statement's `db.system`, when known: for "mysql" or "mariadb", "double quoted"
 * text is masked too.
 */
export function mask(statement: string | null | undefined, system?: string | null): string | null {
  if (typeof statement !== "string" || statement.trim() === "") {
    return null;
  }
  const pattern = DOUBLE_QUOTED_STRING_SYSTEMS.has(String(system ?? "").toLowerCase()) ? LITERAL_WITH_DOUBLE_QUOTES : LITERAL;
  let masked = "";
  let copied = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(statement); match !== null; match = pattern.exec(statement)) {
    const before = statement.charAt(match.index - 1);
    const lookbehindFails =
      match[2] !== undefined ? PART_OF_NUMBER_OR_WORD.test(before) : STRING_PREFIX.test(match[0]) && PART_OF_WORD.test(before);
    if (lookbehindFails) {
      // What a failed lookbehind does: nothing matches here, so try again one character on
      // (LIKE'%x%' then matches at the quote, and 1e+5 inside a word still masks the 5).
      pattern.lastIndex = match.index + 1;
      continue;
    }
    masked += `${statement.slice(copied, match.index)}${MASK}`;
    copied = pattern.lastIndex;
  }
  masked += statement.slice(copied);
  return masked.length > MAX_LENGTH ? `${masked.slice(0, MAX_LENGTH)}...` : masked;
}

/**
 * Takes an already-masked statement (so a keyword inside a string value can't be mistaken for
 * SQL). Returns null when nothing recognizable was found.
 */
export function objects(masked: string | null): SqlObjects | null {
  if (typeof masked !== "string" || masked.trim() === "") {
    return null;
  }

  const sql = masked.replace(FROM_INSIDE_FUNCTION, " ");
  const procedures: string[] = [...sql.matchAll(PROCEDURE_CALL)].map((m) => m[1] ?? "");
  const relations: string[] = [];

  for (const match of sql.matchAll(RELATION)) {
    const keyword = match[1] ?? "";
    const name = match[2] ?? "";
    if (KEYWORDS_NOT_NAMES.has(name.toLowerCase())) {
      continue;
    }
    const functionCall = Boolean(match[3]) && ["FROM", "JOIN"].includes(keyword.toUpperCase());
    (functionCall ? procedures : relations).push(name);
  }

  const fn = SELECT_FUNCTION.exec(sql)?.[1];
  if (fn && !BUILTINS.has(fn.toLowerCase()) && !FROM_WORD.test(sql)) {
    procedures.push(fn);
  }

  const operation = (/^\s*(\w+)/.exec(sql)?.[1] ?? "").toUpperCase();
  const result: SqlObjects = { procedures: clean(procedures), relations: clean(relations) };
  if (OPERATIONS.has(operation)) {
    return { operation, ...result };
  }
  if (result.procedures.length === 0 && result.relations.length === 0) {
    return null;
  }
  return result;
}

function clean(names: string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of names) {
    const name = raw.trim().slice(0, MAX_NAME_LENGTH);
    if (FULL_NAME.test(name) && !cleaned.includes(name)) {
      cleaned.push(name);
    }
  }
  return cleaned.slice(0, MAX_NAMES);
}

/**
 * Attaches the SQL statement that caused `error` to it and returns the same error, so the code
 * that ran the query can hand it over where the reporter finds it with no extra call. Use it when
 * the database library's own errors don't carry the statement (most drivers don't):
 *
 *     try { await db.query(sql, params); }
 *     catch (error) { throw withSql(error as Error, sql); }
 *
 * Only the names of the stored procedure, table and view are sent by default, and the statement
 * itself only with `captureSqlStatement` on, with every string and number replaced by "?" first;
 * the raw statement never leaves the process. Non-enumerable, so it doesn't show up when the error
 * is logged or serialized.
 */
export function withSql<E extends object>(error: E, statement: string): E {
  Object.defineProperty(error, "sql", { value: statement, enumerable: false, configurable: true, writable: true });
  return error;
}
