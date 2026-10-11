/**
 * In-memory `ctx.db` for the mock. It enforces the same rules the real host does (own tables only, known columns, notNull, unique, types come
 * back as declared); the contract scenarios check both against each other.
 */
import { PLUGIN_TABLE_NAME_PATTERN, type PluginDb, type PluginTable } from './index';
import type { ColumnDescription, TableDescription } from './schema';

type Row = Record<string, unknown>;

export function createMockDb(opts: {
  tables: Map<string, TableDescription>;
  fail: (message: string) => Error;
  allowed: () => boolean;
}): PluginDb {
  const { tables, fail, allowed } = opts;
  const rows = new Map<string, Row[]>();
  const nextId = new Map<string, number>();

  const columnOf = (table: string, name: string): ColumnDescription | undefined => {
    if (name === 'id')
      return { type: 'integer', notNull: true, default: undefined, indexed: true, unique: true };
    return tables.get(table)!.columns.get(name);
  };
  const need = (table: string, name: string): ColumnDescription => {
    const column = columnOf(table, name);
    if (!column) throw fail(`table "${table}" has no column "${name}"`);
    return column;
  };

  /** What a value becomes when stored: the declared type, or an error. */
  function normalize(
    table: string,
    name: string,
    column: ColumnDescription,
    value: unknown
  ): unknown {
    if (value === null || value === undefined) {
      if (column.notNull && column.default === undefined)
        throw fail(`column "${name}" of "${table}" cannot be null`);
      return value === undefined ? null : null;
    }
    const bad = (expected: string) => fail(`column "${name}" of "${table}" expects ${expected}`);
    switch (column.type) {
      case 'string':
      case 'text':
        if (typeof value !== 'string') throw bad('a string');
        if (column.type === 'string' && value.length > (column.length ?? 191))
          throw bad(`at most ${column.length ?? 191} characters`);
        return value;
      case 'integer':
      case 'bigInteger':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw bad('an integer');
        return value;
      case 'decimal':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('a number');
        return value;
      case 'boolean':
        if (typeof value !== 'boolean') throw bad('true or false');
        return value;
      case 'datetime': {
        const date = value instanceof Date ? value : new Date(value as string | number);
        if (Number.isNaN(date.getTime())) throw bad('a date');
        return date;
      }
      case 'json':
        return JSON.parse(JSON.stringify(value));
    }
  }

  const same = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
  const copy = (row: Row): Row => {
    const out: Row = {};
    for (const [key, value] of Object.entries(row))
      out[key] =
        value instanceof Date
          ? new Date(value.getTime())
          : value !== null && typeof value === 'object'
            ? JSON.parse(JSON.stringify(value))
            : value;
    return out;
  };

  function matcher(table: string, where: Row | undefined) {
    const checks = Object.entries(where ?? {}).map(([name, wanted]) => {
      const column = need(table, name);
      if (column.type === 'json')
        throw fail(`column "${name}" of "${table}" is json and cannot be used to filter`);
      const expected =
        wanted === null || wanted === undefined
          ? null
          : normalize(table, name, { ...column, notNull: false }, wanted);
      return (row: Row) => same(row[name] ?? null, expected);
    });
    return (row: Row) => checks.every((check) => check(row));
  }

  function checkUnique(table: string, candidate: Row, ignoreId?: unknown) {
    for (const [name, column] of tables.get(table)!.columns) {
      if (!column.unique || candidate[name] === null || candidate[name] === undefined) continue;
      if (rows.get(table)!.some((r) => r.id !== ignoreId && same(r[name], candidate[name]))) {
        throw fail(
          `unique constraint failed: column "${name}" of "${table}" already has this value`
        );
      }
    }
  }

  function tableFor(name: string): PluginTable {
    if (!allowed()) throw fail('missing permission db');
    if (typeof name !== 'string' || !PLUGIN_TABLE_NAME_PATTERN.test(name))
      throw fail(`table name ${JSON.stringify(name)} is not allowed`);
    if (!tables.has(name)) throw fail(`table "${name}" does not exist (create it in a migration)`);
    if (!rows.has(name)) {
      rows.set(name, []);
      nextId.set(name, 1);
    }

    function prepare(values: Row, forInsert: boolean): Row {
      const out: Row = {};
      for (const key of Object.keys(values)) {
        if (key === 'id') throw fail(`column "id" of "${name}" is generated and cannot be set`);
        need(name, key);
      }
      for (const [column, description] of tables.get(name)!.columns) {
        if (!(column in values)) {
          if (!forInsert) continue;
          out[column] = description.default !== undefined ? description.default : null;
          if (out[column] === null && description.notNull)
            throw fail(`column "${column}" of "${name}" cannot be null`);
          continue;
        }
        out[column] = normalize(
          name,
          column,
          { ...description, default: undefined },
          values[column]
        );
      }
      return out;
    }

    return {
      async insert(values) {
        const row = prepare(values as Row, true);
        checkUnique(name, row);
        const id = nextId.get(name)!;
        nextId.set(name, id + 1);
        const stored = { id, ...row };
        rows.get(name)!.push(stored);
        return copy(stored) as any;
      },
      async find(where, findOpts) {
        const match = matcher(name, where as Row);
        let found = rows.get(name)!.filter(match);
        if (findOpts?.orderBy) {
          const [column, direction] = findOpts.orderBy;
          need(name, column);
          if (direction !== 'asc' && direction !== 'desc')
            throw fail('orderBy direction must be "asc" or "desc"');
          const sign = direction === 'asc' ? 1 : -1;
          const key = (row: Row) =>
            row[column] instanceof Date ? (row[column] as Date).getTime() : row[column];
          found = [...found].sort((a, b) =>
            key(a)! < key(b)! ? -sign : key(a)! > key(b)! ? sign : 0
          );
        }
        const offset = findOpts?.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0)
          throw fail('offset must be an integer of at least 0');
        if (
          findOpts?.limit !== undefined &&
          (!Number.isInteger(findOpts.limit) || findOpts.limit < 0)
        )
          throw fail('limit must be an integer of at least 0');
        found = found.slice(
          offset,
          findOpts?.limit === undefined ? undefined : offset + findOpts.limit
        );
        return found.map((row) => copy(row)) as any;
      },
      async findOne(where) {
        const match = matcher(name, where as Row);
        const row = rows.get(name)!.find(match);
        return row ? (copy(row) as any) : null;
      },
      async update(where, patch) {
        const match = matcher(name, where as Row);
        const changes = prepare(patch as Row, false);
        const targets = rows.get(name)!.filter(match);
        // all or nothing, like one UPDATE statement: check the result of every row before changing any
        for (const row of targets) checkUnique(name, { ...row, ...changes }, row.id);
        if (targets.length > 1) {
          for (const [column, description] of tables.get(name)!.columns) {
            if (description.unique && column in changes && changes[column] !== null)
              throw fail(
                `unique constraint failed: column "${column}" of "${name}" would get the same value in several rows`
              );
          }
        }
        for (const row of targets) Object.assign(row, changes);
        return targets.length;
      },
      async delete(where) {
        const match = matcher(name, where as Row);
        const kept = rows.get(name)!.filter((row) => !match(row));
        const removed = rows.get(name)!.length - kept.length;
        rows.set(name, kept);
        return removed;
      },
      async count(where) {
        return rows.get(name)!.filter(matcher(name, where as Row)).length;
      },
    };
  }

  return { table: (name) => tableFor(name) as any };
}
