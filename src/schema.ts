/**
 * The pure part of plugin tables: what a migration declares, turned into a plain description (no database). The mock builds its in-memory
 * tables from it; the real host has its own copy of these rules (Strapi cannot import the SDK) and creates real tables from them. The contract
 * scenarios in ./contract.ts hold the two together.
 */
import {
  PLUGIN_TABLE_NAME_PATTERN,
  type ColumnModifiers,
  type PluginMigration,
  type PluginSchema,
  type TableBuilder,
} from './index';

export type ColumnType =
  | 'string'
  | 'text'
  | 'integer'
  | 'bigInteger'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json';

export type ColumnDescription = {
  type: ColumnType;
  notNull: boolean;
  /** `undefined` means no default was declared. */
  default: string | number | boolean | null | undefined;
  indexed: boolean;
  unique: boolean;
  length?: number;
  precision?: number;
  scale?: number;
};

export type TableDescription = { columns: Map<string, ColumnDescription> };

const DEFAULT_STRING_LENGTH = 191;

function checkColumnName(table: string, name: string) {
  if (!PLUGIN_TABLE_NAME_PATTERN.test(name)) {
    throw new Error(
      `table "${table}": column name ${JSON.stringify(name)} is not allowed (lowercase letters, digits and underscores)`
    );
  }
  if (name === 'id') throw new Error(`table "${table}": the column "id" is created for you`);
}

function columnsBuilder(table: string, into: Map<string, ColumnDescription>): TableBuilder {
  const add = (
    name: string,
    type: ColumnType,
    extra: Partial<ColumnDescription> = {}
  ): ColumnModifiers => {
    checkColumnName(table, name);
    if (into.has(name)) throw new Error(`table "${table}": column "${name}" is declared twice`);
    const column: ColumnDescription = {
      type,
      notNull: false,
      default: undefined,
      indexed: false,
      unique: false,
      ...extra,
    };
    into.set(name, column);
    const modifiers: ColumnModifiers = {
      notNull: () => ((column.notNull = true), modifiers),
      default: (value) => ((column.default = value), modifiers),
      index: () => ((column.indexed = true), modifiers),
      unique: () => ((column.unique = true), modifiers),
    };
    return modifiers;
  };
  return {
    string: (name, length = DEFAULT_STRING_LENGTH) => add(name, 'string', { length }),
    text: (name) => add(name, 'text'),
    integer: (name) => add(name, 'integer'),
    bigInteger: (name) => add(name, 'bigInteger'),
    decimal: (name, precision = 18, scale = 4) => add(name, 'decimal', { precision, scale }),
    boolean: (name) => add(name, 'boolean'),
    datetime: (name) => add(name, 'datetime'),
    json: (name) => add(name, 'json'),
  };
}

/** Runs the migrations' `up` against a description only. `tables` is changed in place; a migration that names a table wrongly throws. */
export function describeMigrations(
  migrations: PluginMigration[],
  tables = new Map<string, TableDescription>()
) {
  const schema: PluginSchema = {
    createTable(name, build) {
      if (!PLUGIN_TABLE_NAME_PATTERN.test(name))
        throw new Error(
          `table name ${JSON.stringify(name)} is not allowed (lowercase letters, digits and underscores)`
        );
      if (tables.has(name)) throw new Error(`table "${name}" already exists`);
      const columns = new Map<string, ColumnDescription>();
      build(columnsBuilder(name, columns));
      tables.set(name, { columns });
    },
    addColumns(name, build) {
      const table = tables.get(name);
      if (!table)
        throw new Error(`table "${name}" does not exist (create it first with createTable)`);
      const before = new Set(table.columns.keys());
      build(columnsBuilder(name, table.columns));
      for (const [column, description] of table.columns) {
        // rows already in the table would have no value for it
        if (!before.has(column) && description.notNull && description.default === undefined) {
          throw new Error(
            `table "${name}": the new column "${column}" is notNull, so it needs a default (existing rows must get a value)`
          );
        }
      }
    },
  };
  for (const migration of migrations) migration.up(schema);
  return tables;
}
