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
  type GrantResult,
  type PluginCtx,
  type PluginEventName,
  type RouteHandler,
} from './index';
import type { ContractManifest, HarnessFactory } from './contract';

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

  const ctx: PluginCtx = {
    now,
    credits,
    store,
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

/** Adapts the mock to the shared contract scenarios (see ./contract.ts). */
export const createMockHarness: HarnessFactory = async ({ manifest, setup, now }) => {
  const mock = createMockCtx({ manifest, now, users: ['7', '8'] });
  await setup?.(mock.ctx);
  return {
    ctx: mock.ctx,
    call: (method, path, opts) => mock.call(method, path, opts),
    emit: (event, payload) => mock.emit(event, payload),
    setNow: (date) => mock.setNow(date),
    setEnabled: async (value) => mock.setEnabled(value),
    creditsOf: async (userId) =>
      mock.grants.filter((g) => g.userId === userId).reduce((sum, g) => sum + g.credits, 0),
  };
};
