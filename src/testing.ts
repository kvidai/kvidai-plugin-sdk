/**
 * In-memory stand-in for the platform, so a plugin can be developed and tested without core, a database or a server:
 *
 *   const mock = createMockCtx({ manifest: pkg.kvidai });
 *   await myPlugin.setup(mock.ctx);
 *   const res = await mock.call('POST', '/check-in', { userId: '7' });
 *
 * It mirrors the real host's rules (permissions, grant validation, idempotent keys, daily budget, event isolation, route auth). The shared
 * scenarios in ./contract.ts run against this mock and against the real host, so the two cannot drift apart unnoticed. The mock holds only
 * fakes -- none of core's real implementation.
 */
import {
  PLUGIN_EVENTS,
  PLUGIN_FILTERS,
  type GrantResult,
  type PluginCtx,
  type PluginDefinition,
  type PluginEventName,
  type PluginMigration,
  type RouteHandler,
} from './index';
import type { ContractManifest, HarnessFactory } from './contract';
import { createMockDb } from './mock-db';
import { describeMigrations } from './schema';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 191;
const SEGMENT = /^:?[A-Za-z0-9._~-]+$/;

export type MockOptions = {
  /** The plugin's package.json "kvidai" field. Required: a mock that grants every permission would hide a missing declaration. */
  manifest: ContractManifest;
  pluginId?: string;
  now?: Date;
  config?: Record<string, unknown>;
  /** Known user ids. When given, granting to another id throws and a request as another id is a 401; when omitted every id is accepted. */
  users?: string[];
  /** The plugin's `migrations`: applied once, in order, before the plugin's setup. Needs the `db` permission. */
  migrations?: PluginMigration[];
  /**
   * What `ctx.strapi` and `ctx.knex` return. The mock has no Strapi, so without these they throw: give your plugin the fake it needs
   * (a plain object with the few services it calls), or run it against the real core image.
   */
  strapi?: unknown;
  knex?: unknown;
  /** How long a filter may take before it is skipped (fail-open). Default 2000. */
  filterTimeoutMs?: number;
};

type Route = {
  method: 'GET' | 'POST';
  path: string;
  auth: 'user' | 'public';
  handler: RouteHandler;
};

export function createMockCtx(options: MockOptions) {
  if (!options?.manifest || !Array.isArray(options.manifest.permissions)) {
    throw new Error(
      'createMockCtx needs the plugin manifest: pass the "kvidai" field of your package.json'
    );
  }
  const { manifest, pluginId = 'mock-plugin', users } = options;
  let nowMs = (options.now ?? new Date()).getTime();
  let enabled = true;
  const tag = (message: string) => `[plugin:${pluginId}] ${message}`;
  const fail = (message: string) => new Error(tag(message));
  const has = (permission: string) => manifest.permissions.includes(permission);

  const logs = { info: [] as string[], error: [] as string[] };
  const grants: Array<{ userId: string; key: string; credits: number }> = [];
  const granted = new Map<string, { credits: number; at: number }>();
  const kv = new Map<string, { value: unknown; expiresAt: number | null }>();
  const routes: Route[] = [];
  const handlers: Array<{ event: string; fn: (payload: any) => Promise<void> | void }> = [];

  const filters: Array<{ name: string; fn: (value: any, info: any) => unknown }> = [];
  const filterTimeoutMs = options.filterTimeoutMs ?? 2000;

  const now = () => new Date(nowMs);
  const kvKey = (userId: string, key: string) => `${userId}\u0000${key}`;
  const liveEntry = (userId: string, key: string) => {
    const entry = kv.get(kvKey(userId, key));
    return entry && (entry.expiresAt === null || entry.expiresAt > nowMs) ? entry : undefined;
  };
  const denyStore = () => {
    throw fail('missing permission store');
  };

  const credits: PluginCtx['credits'] = {
    async grant(userId, opts): Promise<GrantResult> {
      if (!has('credits.grant')) throw fail('missing permission credits.grant');
      const { key, credits: amount, expiresInDays } = opts;
      if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY_LENGTH)
        throw fail(`invalid grant key (1-${MAX_KEY_LENGTH} chars)`);
      if (!Number.isFinite(amount) || amount <= 0)
        throw fail('credits must be a positive finite number');
      const { perGrantMax, dailyCredits } = manifest.budget ?? {};
      if (perGrantMax !== undefined && amount > perGrantMax)
        throw fail(`credits ${amount} exceeds perGrantMax ${perGrantMax}`);
      if (expiresInDays !== undefined && !(expiresInDays > 0))
        throw fail('expiresInDays must be positive');
      if (users && !users.includes(userId)) throw fail(`user ${userId} not found`);

      if (dailyCredits !== undefined) {
        const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
        let today = 0;
        for (const g of granted.values()) if (g.at >= dayStart) today += g.credits;
        if (today + amount > dailyCredits) return { granted: false, reason: 'budget' };
      }
      const id = `${userId}\u0000${key}`;
      if (granted.has(id)) return { granted: false, reason: 'duplicate' };
      granted.set(id, { credits: amount, at: nowMs });
      grants.push({ userId, key, credits: amount });
      return { granted: true };
    },
    async grantedKeys(userId, keys) {
      return new Set(keys.filter((k) => granted.has(`${userId}\u0000${k}`)));
    },
  };

  const store: PluginCtx['store'] = has('store')
    ? {
        async get<T>(userId: string, key: string) {
          return (liveEntry(userId, key)?.value ?? null) as T | null;
        },
        async set(userId, key, value, opts) {
          kv.set(kvKey(userId, key), {
            value,
            expiresAt: opts?.expiresInDays ? nowMs + opts.expiresInDays * DAY_MS : null,
          });
        },
        async incr(userId, key, by = 1) {
          const entry = liveEntry(userId, key);
          const current = entry ? entry.value : 0;
          if (typeof current !== 'number')
            throw fail(`store incr: value of "${key}" is not a number`);
          kv.set(kvKey(userId, key), { value: current + by, expiresAt: entry?.expiresAt ?? null });
          return current + by;
        },
        async list<T>(userId: string, prefix: string) {
          return [...kv.entries()]
            .filter(([k]) => k.startsWith(`${userId}\u0000`))
            .map(([k, e]) => ({ key: k.slice(userId.length + 1), entry: e }))
            .filter(
              ({ key, entry }) =>
                key.startsWith(prefix) && (entry.expiresAt === null || entry.expiresAt > nowMs)
            )
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .map(({ key, entry }) => ({ key, value: entry.value as T }));
        },
      }
    : { get: denyStore, set: denyStore, incr: denyStore, list: denyStore };

  const addRoute =
    (method: 'GET' | 'POST') =>
    (path: string, handler: RouteHandler, opts?: { auth?: 'user' | 'public' }) => {
      if (!has('routes')) throw fail('missing permission routes');
      const segments =
        typeof path === 'string' && path.startsWith('/') ? path.slice(1).split('/') : null;
      if (!segments || !segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) {
        throw fail(`invalid route path ${JSON.stringify(path)}`);
      }
      if (routes.some((r) => r.method === method && r.path === path))
        throw fail(`route ${method} ${path} already registered`);
      routes.push({ method, path, auth: opts?.auth ?? 'user', handler });
    };

  // Plugin-owned tables: the migrations describe them, the mock keeps the rows in memory (see ./mock-db.ts).
  if (options.migrations?.length && !has('db'))
    throw fail('missing permission db (the plugin has migrations)');
  const tables = describeMigrations(options.migrations ?? []);
  const db = createMockDb({ tables, fail, allowed: () => has('db') });

  const ctx: PluginCtx = {
    now,
    credits,
    store,
    db,
    get strapi() {
      if (options.strapi === undefined)
        throw fail(
          'ctx.strapi is not available in the mock: pass a fake, createMockCtx({ manifest, strapi: { ... } }), or test against the real core image'
        );
      return options.strapi as never;
    },
    get knex() {
      if (options.knex === undefined)
        throw fail(
          'ctx.knex is not available in the mock: pass a fake, createMockCtx({ manifest, knex }), or test against the real core image'
        );
      return options.knex as never;
    },
    filter(name, fn) {
      if (!(PLUGIN_FILTERS as readonly string[]).includes(name))
        throw fail(`unknown filter ${JSON.stringify(name)}`);
      filters.push({ name, fn: fn as (value: any, info: any) => unknown });
    },
    on(event: PluginEventName, handler) {
      if (!(PLUGIN_EVENTS as readonly string[]).includes(event))
        throw fail(`unknown event ${JSON.stringify(event)}`);
      if (!has(`events:${event}`)) throw fail(`missing permission events:${event}`);
      handlers.push({ event, fn: handler as (payload: any) => Promise<void> | void });
    },
    routes: { get: addRoute('GET'), post: addRoute('POST') },
    config: options.config ?? {},
    log: {
      info: (message) => void logs.info.push(tag(message)),
      error: (message) => void logs.error.push(tag(message)),
    },
  };

  return {
    ctx,
    logs,
    /** Every successful grant, in order. */
    grants,
    /** Runs the handlers of an event like the host does: after the fact, each isolated, skipped while the plugin is off. */
    async emit(event: PluginEventName, payload: unknown): Promise<void> {
      if (!enabled) return;
      await Promise.all(
        handlers
          .filter((h) => h.event === event)
          .map(async (h) => {
            try {
              await h.fn(payload);
            } catch (error) {
              logs.error.push(tag(`${event} handler failed: ${(error as Error).message}`));
            }
          })
      );
    },
    /** What core does at a filter point: hands `value` through this plugin's filters. Fail-open, like the host. */
    async applyFilter(name: string, value: unknown, info?: unknown): Promise<unknown> {
      if (!enabled) return value;
      let current = value;
      for (const filter of filters.filter((f) => f.name === name)) {
        try {
          const next = await withTimeout(
            Promise.resolve(filter.fn(current, info)),
            filterTimeoutMs
          );
          if (next === TIMED_OUT) {
            logs.error.push(
              tag(`${name} filter timed out after ${filterTimeoutMs}ms and was skipped`)
            );
          } else if (next === undefined) {
            logs.error.push(tag(`${name} filter returned nothing and was skipped`));
          } else {
            current = next;
          }
        } catch (error) {
          logs.error.push(
            tag(`${name} filter failed and was skipped: ${(error as Error).message}`)
          );
        }
      }
      return current;
    },
    /** Calls a registered route like an HTTP request. `userId` stands for a valid login of that user; omit it for an anonymous request. */
    async call(
      method: 'GET' | 'POST',
      path: string,
      opts: { userId?: string; body?: unknown; query?: Record<string, string> } = {}
    ) {
      const route = routes.find((r) => r.method === method && r.path === path);
      if (!route || !enabled) return { status: 404, body: { error: 'not_found' } as any };
      let user: { id: string } | null = null;
      if (route.auth === 'user') {
        if (!opts.userId || (users && !users.includes(opts.userId)))
          return { status: 401, body: { error: 'unauthorized' } as any };
        user = { id: opts.userId };
      }
      try {
        const result = await route.handler({
          user,
          body: opts.body ?? null,
          query: opts.query ?? {},
        });
        return { status: 200, body: (result ?? {}) as any };
      } catch (error) {
        logs.error.push(tag(`${method} ${path} failed: ${(error as Error).message}`));
        return { status: 500, body: { error: 'plugin_error' } as any };
      }
    },
    setNow(date: Date) {
      nowMs = date.getTime();
    },
    advance(ms: number) {
      nowMs += ms;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
  };
}

const TIMED_OUT = Symbol('timed out');

/** Resolves with the promise's value, or with TIMED_OUT once `ms` have passed (the promise itself is left running). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Loads a plugin into the mock the way the host does: merge `config.default` with the settings you pass and run the validator, apply
 * `migrations`, then `register`, then `bootstrap`. Returns the mock plus `destroy()` for the plugin's shutdown.
 *
 *   const mock = await loadMockPlugin(plugin, { manifest: pkg.kvidai });
 *   const res = await mock.call('POST', '/check-in', { userId: '7' });
 */
export async function loadMockPlugin(
  plugin: PluginDefinition,
  options: Omit<MockOptions, 'migrations' | 'pluginId'>
) {
  const config = { ...(plugin.config?.default ?? {}), ...(options.config ?? {}) };
  plugin.config?.validator?.(config);
  const mock = createMockCtx({
    ...options,
    pluginId: plugin.id,
    migrations: plugin.migrations,
    config,
  });
  await plugin.register?.(mock.ctx);
  await (plugin.bootstrap ?? plugin.setup)?.(mock.ctx);
  return { ...mock, destroy: async () => void (await plugin.destroy?.(mock.ctx)) };
}

/** Adapts the mock to the shared contract scenarios (see ./contract.ts). */
export const createMockHarness: HarnessFactory = async ({
  manifest,
  migrations,
  config,
  register,
  destroy,
  setup,
  now,
  filterTimeoutMs,
  destroyTimeoutMs,
}) => {
  const mock = await loadMockPlugin(
    { id: 'mock-plugin', version: '1.0.0', config, migrations, register, setup },
    {
      manifest,
      now,
      users: ['7', '8'],
      // the contract only checks that full control is there; the shape of Strapi is not part of it
      strapi: {},
      knex: () => ({}),
      filterTimeoutMs,
    }
  );
  return {
    ctx: mock.ctx,
    applyFilter: (name, value, info) => mock.applyFilter(name, value, info),
    destroy: async () => {
      try {
        await withTimeout(Promise.resolve(destroy?.(mock.ctx)), destroyTimeoutMs);
      } catch (error) {
        mock.logs.error.push(`[plugin:mock-plugin] destroy failed: ${(error as Error).message}`);
      }
    },
    call: (method, path, opts) => mock.call(method, path, opts),
    emit: (event, payload) => mock.emit(event, payload),
    setNow: (date) => mock.setNow(date),
    setEnabled: async (value) => mock.setEnabled(value),
    creditsOf: async (userId) =>
      mock.grants.filter((g) => g.userId === userId).reduce((sum, g) => sum + g.credits, 0),
  };
};
