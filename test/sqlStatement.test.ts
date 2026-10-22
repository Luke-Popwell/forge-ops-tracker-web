import { describe, expect, it } from "vitest";
import { Configuration } from "../src/configuration.js";
import { EventBuilder } from "../src/eventBuilder.js";
import { findIn, mask, objects, withSql } from "../src/sqlStatement.js";

describe("sqlStatement.findIn", () => {
  it("reads .sql or .query off the error", () => {
    expect(findIn(Object.assign(new Error("boom"), { sql: "SELECT 1" }))).toBe("SELECT 1");
    expect(findIn(Object.assign(new Error("boom"), { query: "SELECT 2" }))).toBe("SELECT 2");
  });

  it("follows .cause and Sequelize's .parent/.original", () => {
    const inner = Object.assign(new Error("db"), { sql: "CALL refund_order(1)" });
    expect(findIn(new Error("refund failed", { cause: inner }))).toBe("CALL refund_order(1)");
    expect(findIn(Object.assign(new Error("seq"), { parent: inner }))).toBe("CALL refund_order(1)");
    expect(findIn(Object.assign(new Error("seq"), { original: inner }))).toBe("CALL refund_order(1)");
  });

  it("ignores a non-string property and returns null without SQL", () => {
    expect(findIn(Object.assign(new Error("x"), { query: { text: "SELECT 1" } }))).toBeNull();
    expect(findIn(new Error("nope"))).toBeNull();
    expect(findIn(null)).toBeNull();
  });
});

describe("sqlStatement.mask", () => {
  it("replaces strings and numbers, leaving identifiers and placeholders", () => {
    expect(mask("SELECT * FROM orders2 WHERE email = 'a@b.co' AND id = 42 AND x = $1")).toBe(
      "SELECT * FROM orders2 WHERE email = ? AND id = ? AND x = $1",
    );
    expect(mask("SELECT price * 1.5 FROM t WHERE a IN (1,2,3)")).toBe("SELECT price * ? FROM t WHERE a IN (?,?,?)");
  });

  it("handles an escaped quote, a cut-off string and a dollar-quoted body", () => {
    expect(mask("EXEC sp_x @t = 'it''s'")).toBe("EXEC sp_x @t = ?");
    expect(mask("SELECT 1 WHERE n = 'oops")).toBe("SELECT ? WHERE n = ?");
    expect(mask("DO $b$ BEGIN PERFORM 1; END $b$")).toBe("DO ?");
  });

  it("is idempotent, truncates, and returns null for blank input", () => {
    const once = mask("SELECT * FROM t WHERE a = 'x' AND b = 9");
    expect(mask(once)).toBe(once);
    expect(mask(`SELECT ${"a, ".repeat(3000)} b`)?.length).toBe(4003);
    expect(mask("  ")).toBeNull();
    expect(mask(undefined)).toBeNull();
  });

  // The corpus every SDK's masker is checked against, embedded since this package is published on
  // its own: each input must mask to exactly what the server's SqlStatementMasker produces.
  const corpus: { input: string; system: string | null; expected: string }[] = [
    { input: "SELECT * FROM orders WHERE email = 'a@b.co' AND id = 42 LIMIT 10", system: null, expected: "SELECT * FROM orders WHERE email = ? AND id = ? LIMIT ?" },
    { input: "EXEC sp_note @text = 'it''s broken'", system: null, expected: "EXEC sp_note @text = ?" },
    { input: "SELECT 1 WHERE name = 'unterminated", system: null, expected: "SELECT ? WHERE name = ?" },
    { input: "DO $body$ BEGIN PERFORM 1; END $body$", system: null, expected: "DO ?" },
    { input: "SELECT \"user id\" FROM orders2 WHERE id = $1 AND v = sp_v2(?)", system: null, expected: "SELECT \"user id\" FROM orders2 WHERE id = $1 AND v = sp_v2(?)" },
    { input: "SELECT price * 1.5 FROM t", system: null, expected: "SELECT price * ? FROM t" },
    { input: "SELECT * FROM users WHERE name = E'o\\'brien' AND id = 1", system: null, expected: "SELECT * FROM users WHERE name = ? AND id = ?" },
    { input: "SELECT * FROM users WHERE name = 'o\\'brien' AND id = 1", system: null, expected: "SELECT * FROM users WHERE name = ? AND id = ?" },
    { input: "SELECT * FROM t WHERE b = X'DEADBEEF' AND s = N'uni' AND u = U&'d\\0061t' AND e = e'x'", system: null, expected: "SELECT * FROM t WHERE b = ? AND s = ? AND u = ? AND e = ?" },
    { input: "SELECT * FROM t WHERE a LIKE'%secret%'", system: null, expected: "SELECT * FROM t WHERE a LIKE?" },
    { input: "SELECT * FROM t WHERE f = 0x1F AND b = 0b101 AND n = 3e10 AND m = 1.5E-3 AND k = .5", system: null, expected: "SELECT * FROM t WHERE f = ? AND b = ? AND n = ? AND m = ? AND k = ?" },
    { input: "SELECT e, t.col, 1e5e FROM t", system: null, expected: "SELECT e, t.col, 1e5e FROM t" },
    { input: "SELECT \"user id\" FROM t WHERE token = \"abc123secret\"", system: "mysql", expected: "SELECT ? FROM t WHERE token = ?" },
    { input: "SELECT \"user id\" FROM t WHERE token = \"abc123secret\"", system: "MariaDB", expected: "SELECT ? FROM t WHERE token = ?" },
    { input: "SELECT \"user id\" FROM t WHERE token = \"abc123secret\"", system: "postgresql", expected: "SELECT \"user id\" FROM t WHERE token = \"abc123secret\"" },
    { input: "SELECT \"user id\" FROM t WHERE token = \"abc123secret\"", system: null, expected: "SELECT \"user id\" FROM t WHERE token = \"abc123secret\"" },
    { input: "SELECT * FROM t WHERE a = 'x' AND b = 9", system: null, expected: "SELECT * FROM t WHERE a = ? AND b = ?" },
    { input: "SELECT * FROM t WHERE a = ? AND b = ?", system: null, expected: "SELECT * FROM t WHERE a = ? AND b = ?" },
    { input: "SELECT * FROM t WHERE path = 'C:\\\\dir\\\\' AND n = 5", system: null, expected: "SELECT * FROM t WHERE path = ? AND n = ?" },
    { input: "INSERT INTO t (a, b) VALUES (-5, +3.25e+2)", system: null, expected: "INSERT INTO t (a, b) VALUES (-?, +?)" },
    { input: "SELECT * FROM t WHERE a = 'secret\\", system: null, expected: "SELECT * FROM t WHERE a = ?" },
    { input: "SELECT * FROM t WHERE a = \"secret\\", system: "mysql", expected: "SELECT * FROM t WHERE a = ?" },
  ];

  it.each(corpus)("masks $input (system $system) exactly like the server", ({ input, system, expected }) => {
    expect(mask(input, system)).toBe(expected);
    expect(mask(expected, system)).toBe(expected);
  });
});

describe("sqlStatement.objects", () => {
  it("finds a stored procedure with its schema", () => {
    expect(objects("EXEC dbo.sp_refund_order @id = ?")).toEqual({ operation: "EXEC", procedures: ["dbo.sp_refund_order"], relations: [] });
    expect(objects("CALL refund_order(?, ?)")?.procedures).toEqual(["refund_order"]);
    expect(objects("SELECT refund_order(?, ?)")?.procedures).toEqual(["refund_order"]);
  });

  it("finds views, joined tables and table functions", () => {
    expect(objects("SELECT * FROM v_totals t JOIN public.customers c ON c.id = t.id")?.relations).toEqual(["v_totals", "public.customers"]);
    expect(objects("SELECT * FROM get_open_orders(?) o")?.procedures).toEqual(["get_open_orders"]);
  });

  it("does not misread column lists or builtins, and returns null for garbage", () => {
    expect(objects("INSERT INTO audit_log (a) VALUES (?)")?.procedures).toEqual([]);
    expect(objects("SELECT count(*) FROM orders")?.procedures).toEqual([]);
    expect(objects("garbage")).toBeNull();
  });
});

describe("EventBuilder SQL capture", () => {
  const error = Object.assign(new Error("boom"), { sql: "EXEC dbo.sp_refund_order @order_id = 8814, @note = 'a@b.co'" });
  const builder = (overrides: Partial<Configuration> = {}) => {
    const config = new Configuration();
    config.environment = "production";
    Object.assign(config, overrides);
    return new EventBuilder(config);
  };

  it("sends the procedure name but not the statement by default", () => {
    const payload = builder().build(error);
    expect(payload.sql_objects?.procedures).toEqual(["dbo.sp_refund_order"]);
    expect(payload).not.toHaveProperty("sql_statement");
  });

  it("sends the masked statement when opted in", () => {
    expect(builder({ captureSqlStatement: true }).build(error).sql_statement).toBe("EXEC dbo.sp_refund_order @order_id = ?, @note = ?");
  });

  it("sends neither when both are off, and nothing for an error with no SQL", () => {
    const off = builder({ captureSqlObjects: false }).build(error);
    expect(off).not.toHaveProperty("sql_objects");
    expect(off).not.toHaveProperty("sql_statement");
    expect(builder().build(new Error("nope"))).not.toHaveProperty("sql_objects");
  });
});

describe("withSql", () => {
  it("attaches the statement where findIn reads it, returns the same error, and stays non-enumerable", () => {
    const error = new Error("boom");
    const returned = withSql(error, "CALL refund_order(1)");
    expect(returned).toBe(error);
    expect(findIn(error)).toBe("CALL refund_order(1)");
    expect(Object.keys(error)).not.toContain("sql");
    expect(JSON.stringify(error)).not.toContain("refund_order");
  });
});
