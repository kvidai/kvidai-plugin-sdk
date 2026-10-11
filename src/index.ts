/**
 * KVIDAI plugin SDK. A plugin is a package whose server entry default-exports `definePlugin({...})`.
 * It talks to the platform only through the `PluginCtx` it is handed in `setup` -- no database client,
 * no core import. Install = `pnpm plugins:add`, `pnpm plugins:sync`, then redeploy.
 *
 * Plugins run in the same process as core (not a sandbox), so only code-reviewed plugins are installed.
 */

/** Lowercase letters, digits and dashes, starting with a letter. Namespaces every grant, store key and route. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export type CreditGrantOptions = {
  /** Unique per user within this plugin: the same key can never be granted twice. */
  key: string;
  /** Positive integer, capped by the plugin's declared `perGrantMax`. */
  credits: number;
  expiresInDays?: number;
};

/** `duplicate`: this key was granted before. `budget`: the plugin's daily cap would be passed; nothing was granted and the key stays unused. */
export type GrantResult = { granted: true } | { granted: false; reason: 'duplicate' | 'budget' };

export type PluginStore = {
  get<T = unknown>(userId: string, key: string): Promise<T | null>;
  set(
    userId: string,
    key: string,
    value: unknown,
    opts?: { expiresInDays?: number }
  ): Promise<void>;
  /** Atomically adds `by` (default 1) and returns the new value. */
  incr(userId: string, key: string, by?: number): Promise<number>;
  list<T = unknown>(userId: string, prefix: string): Promise<Array<{ key: string; value: T }>>;
};

/** Places in the web app where a plugin can show a React component (see `@kvidai/plugin-sdk/ui`). Declared in package.json `kvidai.slots`. */
export const PLUGIN_SLOTS = [
  'dashboard.sidebar',
  'dashboard.banner',
  'credits.page',
  'global.overlay',
] as const;
export type PluginSlotName = (typeof PLUGIN_SLOTS)[number];

/** Core events a plugin may subscribe to (declare `events:<name>` in the manifest). Payloads are plain JSON. */
export const PLUGIN_EVENTS = ['user.created', 'credit.used'] as const;

export type PluginEventMap = {
  'user.created': { userId: string };
  'credit.used': { userId: string; credits: number };
};

export type PluginEventName = keyof PluginEventMap;

/**
 * Places where core hands a value to the plugins before using it (a "filter", Discourse calls it a modifier). A filter receives the value so
 * far and returns the new one; filters run in installation order, each seeing the previous result. They are fail-open: a filter that throws,
 * returns nothing or takes too long is logged and skipped, and the value goes on unchanged. Core calls `applyPluginFilter(name, value, info)`
 * at each place, so a new name means one new line in core.
 */
export const PLUGIN_FILTERS = ['popup.list'] as const;

export type PluginFilterMap = {
  /** The popups the web app is about to show, as the API returns them. Add, remove or change entries. */
  'popup.list': { value: Array<Record<string, unknown>>; info: { query: Record<string, unknown> } };
};

export type PluginFilterName = keyof PluginFilterMap;

/**
 * Plugin-owned tables. A plugin declares them in `migrations` (applied once, in order, before `setup`) and reads and writes them through
 * `ctx.db` (needs the `db` permission). It can only ever reach its own tables: there is no SQL and no way to name a core table.
 */
export type ColumnModifiers = {
  /** The column may not be empty (an insert without a value fails unless a default is set). */
  notNull(): ColumnModifiers;
  default(value: string | number | boolean | null): ColumnModifiers;
  index(): ColumnModifiers;
  /** No two rows may have the same value. */
  unique(): ColumnModifiers;
};

export interface TableBuilder {
  string(name: string, length?: number): ColumnModifiers;
  text(name: string): ColumnModifiers;
  integer(name: string): ColumnModifiers;
  bigInteger(name: string): ColumnModifiers;
  decimal(name: string, precision?: number, scale?: number): ColumnModifiers;
  boolean(name: string): ColumnModifiers;
  datetime(name: string): ColumnModifiers;
  json(name: string): ColumnModifiers;
}

export interface PluginSchema {
  /** Creates `<name>` with an automatic integer `id` primary key plus the columns you declare. */
  createTable(name: string, build: (table: TableBuilder) => void): void;
  /** Adds columns to a table this plugin created. Tables and columns are never dropped or changed: migrations only move forward. */
  addColumns(name: string, build: (table: TableBuilder) => void): void;
}

export type PluginMigration = {
  /** Unique within the plugin and never changed once released: it is how the host knows this migration already ran. */
  id: string;
  up(schema: PluginSchema): void;
};

type Where<Row> = Partial<Row>;

export interface PluginTable<Row extends Record<string, unknown> = Record<string, unknown>> {
  /** Returns the stored row, including its generated `id`. */
  insert(row: Partial<Row>): Promise<Row & { id: number }>;
  /** Rows whose columns equal every value in `where` (all rows when omitted). */
  find(
    where?: Where<Row>,
    opts?: { orderBy?: [keyof Row & string, 'asc' | 'desc']; limit?: number; offset?: number }
  ): Promise<Array<Row & { id: number }>>;
  findOne(where: Where<Row>): Promise<(Row & { id: number }) | null>;
  /** Returns how many rows changed. */
  update(where: Where<Row>, patch: Partial<Row>): Promise<number>;
  /** Returns how many rows were removed. */
  delete(where: Where<Row>): Promise<number>;
  count(where?: Where<Row>): Promise<number>;
}

export interface PluginDb {
  /** A table this plugin created in a migration. Throws when there is no such table. */
  table<Row extends Record<string, unknown> = Record<string, unknown>>(
    name: string
  ): PluginTable<Row>;
}

/** Table and column names: lowercase letters, digits and underscores, starting with a letter. `id` is reserved. */
export const PLUGIN_TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const PLUGIN_MIGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type RouteRequest = {
  /** Present when the route is `auth: 'user'`. */
  user: { id: string } | null;
  body: unknown;
  query: Record<string, string>;
};

export type RouteHandler = (req: RouteRequest) => Promise<unknown> | unknown;

/**
 * Types of the host the SDK cannot know. Empty here, so `ctx.strapi` and `ctx.knex` are `any`. A plugin that wants Strapi's own types in its
 * editor adds one file (for example `src/kvidai.d.ts`) and installs `@strapi/strapi` as a devDependency:
 *
 *   import type { Core } from '@strapi/strapi';
 *   declare module '@kvidai/plugin-sdk' {
 *     interface PluginHostTypes { strapi: Core.Strapi }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PluginHostTypes {}

type HostType<K extends string> = PluginHostTypes extends Record<K, infer T> ? T : any;

export interface PluginCtx {
  /** Current time. Use this instead of `new Date()` so tests can control it. */
  now(): Date;
  credits: {
    /**
     * Grants credits idempotently. A key granted before returns `{ granted: false }`, which is what makes
     * a double click or a second tab harmless. Checked against the declared permissions and budget.
     */
    grant(userId: string, opts: CreditGrantOptions): Promise<GrantResult>;
    grantedKeys(userId: string, keys: string[]): Promise<Set<string>>;
  };
  store: PluginStore;
  /** The plugin's own tables (needs the `db` permission and `migrations`). */
  db: PluginDb;
  /**
   * Full control, like a Strapi or Discourse plugin: the running Strapi instance (services, documents, db, server, lifecycles...) and its
   * database connection (knex). No permission is needed and nothing is checked, so what the plugin does with them is the plugin's
   * responsibility; the test suite and CI are what keep it honest. Typed loosely because Strapi's own types are not part of this SDK.
   * In the mock these throw until you pass your own fakes: `createMockCtx({ manifest, strapi, knex })`.
   */
  strapi: HostType<'strapi'>;
  knex: HostType<'knex'>;
  /** Runs after the core write has finished; a throwing handler never affects core. */
  on<E extends PluginEventName>(
    event: E,
    handler: (payload: PluginEventMap[E]) => Promise<void> | void
  ): void;
  /**
   * Changes a value core is about to use (see PLUGIN_FILTERS). Skipped while the plugin is switched off, so turning it off takes effect at once.
   * Return the new value; returning nothing is treated as a mistake and the value is kept.
   */
  filter<N extends PluginFilterName>(
    name: N,
    fn: (
      value: PluginFilterMap[N]['value'],
      info: PluginFilterMap[N]['info']
    ) => PluginFilterMap[N]['value'] | Promise<PluginFilterMap[N]['value']>
  ): void;
  /** Mounted at /api/plugins/<id>/<path>. */
  routes: {
    get(path: string, handler: RouteHandler, opts?: { auth?: 'user' | 'public' }): void;
    post(path: string, handler: RouteHandler, opts?: { auth?: 'user' | 'public' }): void;
  };
  /** Plugin settings: the admin's `plugin_settings` row merged with env `KVIDAI_PLUGIN_<ID>_*` (env wins). Read once at startup; restart to apply a change. */
  config: Record<string, unknown>;
  log: {
    info(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
}

/**
 * A plugin's settings, the same idea as a Strapi plugin's `config`: `default` is what `ctx.config` holds when nothing is set, and `validator`
 * runs on the merged result when the plugin loads (throw to refuse it: the plugin then fails to load and the rest of the app starts).
 */
export type PluginConfigDefinition = {
  default?: Record<string, unknown>;
  validator?(config: Record<string, unknown>): void;
};

/**
 * What a plugin package exports (default export of `definePlugin({...})`). The lifecycle uses Strapi's names: `register` runs for every
 * plugin first, then `bootstrap` runs for every plugin, and `destroy` runs at shutdown. Each receives the same `ctx`, which holds `strapi`,
 * so the Strapi habit `bootstrap({ strapi }) { ... }` works as written.
 *
 * Unlike Strapi, `register` does not run before the database exists: the host starts inside Strapi's own bootstrap, so the database,
 * routes and permissions are already there in both phases. `register` is still the place to declare things other plugins' `bootstrap`
 * may rely on, and `bootstrap` the place to start working.
 */
export type PluginDefinition = {
  /** Stable forever (it namespaces every grant). See PLUGIN_ID_PATTERN. */
  id: string;
  /** Semver. */
  version: string;
  /** Defaults and validation for `ctx.config`. */
  config?: PluginConfigDefinition;
  /** Applied once each, in order, before `register`. Needs the `db` permission. */
  migrations?: PluginMigration[];
  /** Runs for every plugin before any plugin's `bootstrap`. */
  register?(ctx: PluginCtx): Promise<void> | void;
  /** Runs on every start, so it must be safe to run again (create what is missing, never assume a clean slate). */
  bootstrap?(ctx: PluginCtx): Promise<void> | void;
  /** The earlier name of `bootstrap`, still accepted. Use `bootstrap` in new code; defining both is an error. */
  setup?(ctx: PluginCtx): Promise<void> | void;
  /**
   * Called when Strapi shuts down, with the same ctx. Stop what bootstrap started (timers, subscriptions). A throwing or slow destroy is
   * logged and does not hold up the shutdown.
   */
  destroy?(ctx: PluginCtx): Promise<void> | void;
};

export function definePlugin<T extends PluginDefinition>(plugin: T): T {
  if (!PLUGIN_ID_PATTERN.test(plugin.id)) {
    throw new Error(
      `Invalid plugin id ${JSON.stringify(plugin.id)}: use lowercase letters, digits and dashes, starting with a letter`
    );
  }
  if (!SEMVER_PATTERN.test(plugin.version)) {
    throw new Error(
      `Invalid plugin version ${JSON.stringify(plugin.version)}: expected semver like 1.0.0`
    );
  }
  for (const name of ['register', 'bootstrap', 'setup', 'destroy'] as const) {
    if (plugin[name] !== undefined && typeof plugin[name] !== 'function') {
      throw new Error(`Plugin ${plugin.id}: ${name} must be a function`);
    }
  }
  if (plugin.bootstrap && plugin.setup) {
    throw new Error(
      `Plugin ${plugin.id} defines both bootstrap and setup; setup is the old name of bootstrap, keep one`
    );
  }
  if (!plugin.register && !plugin.bootstrap && !plugin.setup) {
    throw new Error(`Plugin ${plugin.id} must define bootstrap(ctx) (or register(ctx))`);
  }
  if (plugin.config !== undefined) {
    const { default: defaults, validator } = plugin.config;
    if (
      defaults !== undefined &&
      (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults))
    ) {
      throw new Error(`Plugin ${plugin.id}: config.default must be an object`);
    }
    if (validator !== undefined && typeof validator !== 'function') {
      throw new Error(`Plugin ${plugin.id}: config.validator must be a function`);
    }
  }
  if (plugin.migrations !== undefined) {
    if (!Array.isArray(plugin.migrations)) {
      throw new Error(`Plugin ${plugin.id}: migrations must be a list`);
    }
    const seen = new Set<string>();
    for (const migration of plugin.migrations) {
      if (
        !migration ||
        typeof migration.id !== 'string' ||
        !PLUGIN_MIGRATION_ID_PATTERN.test(migration.id)
      ) {
        throw new Error(
          `Plugin ${plugin.id}: invalid migration id ${JSON.stringify(migration?.id)} (lowercase letters, digits, dots, dashes and underscores)`
        );
      }
      if (typeof migration.up !== 'function') {
        throw new Error(`Plugin ${plugin.id}: migration ${migration.id} must define up(schema)`);
      }
      if (seen.has(migration.id)) {
        throw new Error(`Plugin ${plugin.id}: duplicate migration id ${migration.id}`);
      }
      seen.add(migration.id);
    }
  }
  return plugin;
}
