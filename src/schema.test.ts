import { describe, expect, it } from 'vitest';
import { definePlugin, type PluginMigration } from './index';
import { describeMigrations } from './schema';

const migration = (id: string, up: PluginMigration['up']): PluginMigration => ({ id, up });
const create = (
  name: string,
  build: Parameters<
    Parameters<typeof migration>[1] extends (s: infer S) => void
      ? S extends { createTable: infer C }
        ? C
        : never
      : never
  >[1]
) => migration('001', (schema) => schema.createTable(name, build));

describe('describeMigrations', () => {
  it('describes tables and their column types, modifiers and defaults', () => {
    const tables = describeMigrations([
      migration('001', (schema) =>
        schema.createTable('missions', (t) => {
          t.string('title', 80).notNull().index();
          t.integer('reward').notNull().default(5);
          t.decimal('ratio', 8, 2);
          t.string('code').unique();
        })
      ),
    ]);
    const columns = tables.get('missions')!.columns;
    expect([...columns.keys()]).toEqual(['title', 'reward', 'ratio', 'code']);
    expect(columns.get('title')).toMatchObject({
      type: 'string',
      length: 80,
      notNull: true,
      indexed: true,
    });
    expect(columns.get('reward')).toMatchObject({ type: 'integer', notNull: true, default: 5 });
    expect(columns.get('ratio')).toMatchObject({ type: 'decimal', precision: 8, scale: 2 });
    expect(columns.get('code')).toMatchObject({ unique: true, notNull: false, default: undefined });
  });

  it('addColumns extends a table made by an earlier migration', () => {
    const tables = describeMigrations([
      migration('001', (s) => s.createTable('a', (t) => void t.string('x'))),
      migration('002', (s) => s.addColumns('a', (t) => void t.string('y'))),
    ]);
    expect([...tables.get('a')!.columns.keys()]).toEqual(['x', 'y']);
  });

  it.each([
    ['a table name with a capital or a symbol', 'Missions;', /not allowed/],
    ['a table name that starts with a digit', '1a', /not allowed/],
    ['a table name longer than 40 characters', 'a'.repeat(41), /not allowed/],
  ])('rejects %s', (_label, name, message) => {
    expect(() => describeMigrations([create(name, () => {})])).toThrow(message);
  });

  it('rejects the reserved column "id", an invalid column name and a column declared twice', () => {
    expect(() => describeMigrations([create('a', (t) => void t.integer('id'))])).toThrow(
      /"id" is created for you/
    );
    expect(() => describeMigrations([create('a', (t) => void t.string('Bad-Name'))])).toThrow(
      /not allowed/
    );
    expect(() =>
      describeMigrations([
        create('a', (t) => {
          t.string('x');
          t.integer('x');
        }),
      ])
    ).toThrow(/declared twice/);
  });

  it('addColumns refuses a notNull column without a default (existing rows would have no value), and accepts one with a default or a nullable one', () => {
    const make = (build: (t: any) => void) => [
      migration('001', (s) => s.createTable('a', (t) => void t.string('x'))),
      migration('002', (s) => s.addColumns('a', build)),
    ];
    expect(() => describeMigrations(make((t) => void t.string('y').notNull()))).toThrow(
      /needs a default/
    );
    expect(() =>
      describeMigrations(make((t) => void t.string('y').notNull().default('')))
    ).not.toThrow();
    expect(() => describeMigrations(make((t) => void t.string('y')))).not.toThrow();
  });

  it('rejects creating a table twice and adding columns to a table that does not exist', () => {
    expect(() =>
      describeMigrations([
        create('a', () => {}),
        migration('002', (s) => s.createTable('a', () => {})),
      ])
    ).toThrow(/already exists/);
    expect(() =>
      describeMigrations([migration('001', (s) => s.addColumns('ghost', () => {}))])
    ).toThrow(/"ghost" does not exist/);
  });
});

describe('definePlugin: migrations', () => {
  const base = { id: 'p', version: '1.0.0', setup() {} };
  const ok = migration('001-create', () => {});

  it('accepts a list of uniquely named migrations', () => {
    expect(() =>
      definePlugin({ ...base, migrations: [ok, migration('002-more', () => {})] })
    ).not.toThrow();
  });

  it.each([
    ['migrations that are not a list', { migrations: 'x' }, /must be a list/],
    ['a migration without up()', { migrations: [{ id: '001' }] }, /must define up/],
    [
      'a migration id with a capital letter',
      { migrations: [migration('Bad', () => {})] },
      /invalid migration id/,
    ],
    ['a missing migration id', { migrations: [{ up() {} }] }, /invalid migration id/],
    ['the same migration id twice', { migrations: [ok, ok] }, /duplicate migration id 001-create/],
  ])('rejects %s', (_label, extra, message) => {
    expect(() => definePlugin({ ...base, ...(extra as object) } as never)).toThrow(message);
  });
});
