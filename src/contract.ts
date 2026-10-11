/**
 * The ctx contract: the behaviour every plugin may rely on, written once as scenarios and run against BOTH implementations -- the in-memory
 * mock in ./testing.ts (what external developers test against) and the real host. If the mock drifts from the host, one of the two
 * runs fails, so a plugin that passes against the mock also works in core.
 *
 * A scenario declares the manifest the plugin would ship and an optional setup (what the plugin does in setup(ctx), e.g. register routes
 * and event handlers); `run` then drives it through the harness. Routes can only be registered in setup, because the real host mounts them
 * once after every plugin has loaded.
 */
import assert from 'node:assert/strict';
import type { PluginCtx, PluginEventName } from './index';

export type ContractManifest = {
  permissions: string[];
  budget?: { dailyCredits?: number; perGrantMax?: number };
};

export interface ContractHarness {
  /** The ctx the plugin received in setup. */
  ctx: PluginCtx;
  /** Calls a plugin route like an HTTP request. `userId` stands for a valid login of that user; omit it for an anonymous request. */
  call(
    method: 'GET' | 'POST',
    path: string,
    opts?: { userId?: string; body?: unknown; query?: Record<string, string> }
  ): Promise<{ status: number; body: any }>;
  /** Emits a core event and resolves once every handler has settled. */
  emit(event: PluginEventName, payload: unknown): Promise<void>;
  setNow(date: Date): void;
  setEnabled(enabled: boolean): Promise<void>;
  /** Total credits granted to the user so far (what the balance would gain). */
  creditsOf(userId: string): Promise<number>;
  close?(): Promise<void>;
}

/** Users '7' and '8' exist and may log in; any other id is unknown. */
export type HarnessFactory = (opts: {
  manifest: ContractManifest;
  setup?: (ctx: PluginCtx) => void | Promise<void>;
  now: Date;
}) => Promise<ContractHarness>;

export type ContractScenario = {
  name: string;
  manifest: ContractManifest;
  setup?: (ctx: PluginCtx) => void | Promise<void>;
  run: (h: ContractHarness) => Promise<void>;
};

const DAY1 = new Date(Date.UTC(2026, 9, 10, 12, 0, 0));
const DAY2 = new Date(Date.UTC(2026, 9, 11, 12, 0, 0));

export const contractScenarios: ContractScenario[] = [
  {
    name: 'credits: a grant pays once, the same key again is a duplicate',
    manifest: { permissions: ['credits.grant'] },
    run: async ({ ctx, creditsOf }) => {
      assert.deepEqual(await ctx.credits.grant('7', { key: 'k', credits: 5 }), { granted: true });
      assert.deepEqual(await ctx.credits.grant('7', { key: 'k', credits: 5 }), {
        granted: false,
        reason: 'duplicate',
      });
      assert.equal(await creditsOf('7'), 5);
    },
  },
  {
    name: 'credits: the same key can be granted to another user',
    manifest: { permissions: ['credits.grant'] },
    run: async ({ ctx, creditsOf }) => {
      await ctx.credits.grant('7', { key: 'k', credits: 1 });
      assert.deepEqual(await ctx.credits.grant('8', { key: 'k', credits: 1 }), { granted: true });
      assert.equal(await creditsOf('8'), 1);
    },
  },
  {
    name: 'credits: grantedKeys returns only the keys granted to that user',
    manifest: { permissions: ['credits.grant'] },
    run: async ({ ctx }) => {
      await ctx.credits.grant('7', { key: 'a', credits: 1 });
      await ctx.credits.grant('8', { key: 'c', credits: 1 });
      assert.deepEqual([...(await ctx.credits.grantedKeys('7', ['a', 'c', 'zzz']))], ['a']);
      assert.equal((await ctx.credits.grantedKeys('7', [])).size, 0);
    },
  },
  {
    name: 'credits: granting without the credits.grant permission throws',
    manifest: { permissions: [] },
    run: async ({ ctx }) => {
      await assert.rejects(ctx.credits.grant('7', { key: 'k', credits: 1 }), /permission/);
    },
  },
  {
    name: 'credits: a grant above perGrantMax throws and pays nothing',
    manifest: { permissions: ['credits.grant'], budget: { perGrantMax: 10 } },
    run: async ({ ctx, creditsOf }) => {
      await assert.rejects(ctx.credits.grant('7', { key: 'k', credits: 11 }), /perGrantMax/);
      assert.equal(await creditsOf('7'), 0);
    },
  },
  {
    name: 'credits: invalid credits, key and user are rejected',
    manifest: { permissions: ['credits.grant'] },
    run: async ({ ctx }) => {
      await assert.rejects(ctx.credits.grant('7', { key: 'k', credits: 0 }), /credits/);
      await assert.rejects(ctx.credits.grant('7', { key: 'k', credits: -1 }), /credits/);
      await assert.rejects(ctx.credits.grant('7', { key: 'k', credits: Number.NaN }), /credits/);
      await assert.rejects(ctx.credits.grant('7', { key: '  ', credits: 1 }), /key/);
      await assert.rejects(ctx.credits.grant('missing', { key: 'k', credits: 1 }), /user/);
    },
  },
  {
    name: 'credits: the daily budget refuses a grant that would pass it and does not burn the key',
    manifest: { permissions: ['credits.grant'], budget: { dailyCredits: 10 } },
    run: async ({ ctx, creditsOf }) => {
      assert.deepEqual(await ctx.credits.grant('7', { key: 'a', credits: 6 }), { granted: true });
      assert.deepEqual(await ctx.credits.grant('8', { key: 'b', credits: 6 }), {
        granted: false,
        reason: 'budget',
      });
      assert.deepEqual(await ctx.credits.grant('8', { key: 'b', credits: 4 }), { granted: true });
      assert.equal(await creditsOf('8'), 4);
    },
  },
  {
    name: 'credits: the daily budget resets on the next UTC day',
    manifest: { permissions: ['credits.grant'], budget: { dailyCredits: 10 } },
    run: async ({ ctx, setNow }) => {
      await ctx.credits.grant('7', { key: 'a', credits: 10 });
      assert.deepEqual(await ctx.credits.grant('8', { key: 'b', credits: 1 }), {
        granted: false,
        reason: 'budget',
      });
      setNow(DAY2);
      assert.deepEqual(await ctx.credits.grant('8', { key: 'b', credits: 1 }), { granted: true });
    },
  },
  {
    name: 'store: values round-trip, are isolated per user, and incr accumulates',
    manifest: { permissions: ['store'] },
    run: async ({ ctx }) => {
      assert.equal(await ctx.store.get('7', 'missing'), null);
      await ctx.store.set('7', 'obj', { n: 1, tags: ['x'] });
      assert.deepEqual(await ctx.store.get('7', 'obj'), { n: 1, tags: ['x'] });
      assert.equal(await ctx.store.get('8', 'obj'), null);
      assert.equal(await ctx.store.incr('7', 'streak'), 1);
      assert.equal(await ctx.store.incr('7', 'streak', 5), 6);
      await ctx.store.set('7', 'text', 'v');
      await assert.rejects(ctx.store.incr('7', 'text'), /number/);
    },
  },
  {
    name: 'store: list returns the keys under an exact-case prefix, sorted',
    manifest: { permissions: ['store'] },
    run: async ({ ctx }) => {
      await ctx.store.set('7', 'day:2026-10-02', 'b');
      await ctx.store.set('7', 'day:2026-10-01', 'a');
      await ctx.store.set('7', 'Day:other', 'x');
      await ctx.store.set('8', 'day:2026-10-01', 'other-user');
      assert.deepEqual(await ctx.store.list('7', 'day:'), [
        { key: 'day:2026-10-01', value: 'a' },
        { key: 'day:2026-10-02', value: 'b' },
      ]);
    },
  },
  {
    name: 'store: an entry expires after expiresInDays',
    manifest: { permissions: ['store'] },
    run: async ({ ctx, setNow }) => {
      await ctx.store.set('7', 'k', 'v', { expiresInDays: 1 });
      assert.equal(await ctx.store.get('7', 'k'), 'v');
      setNow(DAY2);
      assert.equal(await ctx.store.get('7', 'k'), null);
    },
  },
  {
    name: 'store: using it without the store permission throws synchronously',
    manifest: { permissions: [] },
    run: async ({ ctx }) => {
      assert.throws(() => ctx.store.get('7', 'k'), /permission/);
    },
  },
  {
    name: 'events: handlers get the payload; a throwing handler does not stop the others or the emit',
    manifest: { permissions: ['store', 'events:user.created'] },
    setup: (ctx) => {
      ctx.on('user.created', () => {
        throw new Error('boom');
      });
      ctx.on('user.created', async ({ userId }) => {
        await ctx.store.set(userId, 'welcomed', true);
      });
    },
    run: async ({ ctx, emit }) => {
      await emit('user.created', { userId: '7' });
      assert.equal(await ctx.store.get('7', 'welcomed'), true);
    },
  },
  {
    name: 'events: an unknown event or an undeclared one is refused at registration',
    manifest: { permissions: ['events:user.created'] },
    run: async ({ ctx }) => {
      assert.throws(() => ctx.on('user.craeted' as any, () => {}), /unknown event/);
      assert.throws(() => ctx.on('credit.used', () => {}), /permission/);
    },
  },
  {
    name: 'routes: user routes need a login, public routes do not, a throwing route is a generic 500, an unknown path is 404',
    manifest: { permissions: ['routes'] },
    setup: (ctx) => {
      ctx.routes.post('/echo', ({ user, body, query }) => ({ uid: user?.id, body, query }));
      ctx.routes.get('/open', ({ user }) => ({ anonymous: user === null }), { auth: 'public' });
      ctx.routes.get('/boom', () => {
        throw new Error('secret internals');
      });
    },
    run: async ({ call }) => {
      assert.deepEqual(await call('GET', '/open'), { status: 200, body: { anonymous: true } });
      assert.equal((await call('POST', '/echo')).status, 401);
      const echo = await call('POST', '/echo', { userId: '7', body: { a: 1 }, query: { q: 'x' } });
      assert.equal(echo.status, 200);
      assert.deepEqual(echo.body, { uid: '7', body: { a: 1 }, query: { q: 'x' } });
      const boom = await call('GET', '/boom', { userId: '7' });
      assert.equal(boom.status, 500);
      assert.ok(!JSON.stringify(boom.body).includes('secret internals'));
      assert.equal((await call('GET', '/nope', { userId: '7' })).status, 404);
    },
  },
  {
    name: 'routes: an invalid path, a duplicate route, or no routes permission is refused',
    manifest: { permissions: ['routes'] },
    run: async ({ ctx }) => {
      assert.throws(() => ctx.routes.get('status', () => ({})), /path/);
      assert.throws(() => ctx.routes.get('/a/../b', () => ({})), /path/);
      ctx.routes.get('/dup', () => ({}));
      assert.throws(() => ctx.routes.get('/dup', () => ({})), /already/);
    },
  },
  {
    name: 'routes: registering without the routes permission throws',
    manifest: { permissions: [] },
    run: async ({ ctx }) => {
      assert.throws(() => ctx.routes.get('/x', () => ({})), /permission/);
    },
  },
  {
    name: 'switch: a disabled plugin answers 404 and receives no events until enabled again',
    manifest: { permissions: ['store', 'routes', 'events:user.created'] },
    setup: (ctx) => {
      ctx.routes.get('/open', () => ({ ok: true }), { auth: 'public' });
      ctx.on('user.created', async ({ userId }) => {
        await ctx.store.incr(userId, 'seen');
      });
    },
    run: async ({ ctx, call, emit, setEnabled }) => {
      await setEnabled(false);
      assert.equal((await call('GET', '/open')).status, 404);
      await emit('user.created', { userId: '7' });
      assert.equal(await ctx.store.get('7', 'seen'), null);
      await setEnabled(true);
      assert.equal((await call('GET', '/open')).status, 200);
      await emit('user.created', { userId: '7' });
      assert.equal(await ctx.store.get('7', 'seen'), 1);
    },
  },
];

/**
 * Registers every scenario with the caller's test runner (`describe`/`it` from vitest or jest), each against a fresh harness:
 *
 *   runContract(createMyHarness, { describe, it });
 */
export function runContract(
  factory: HarnessFactory,
  runner: {
    describe: (name: string, fn: () => void) => void;
    it: (name: string, fn: () => Promise<void>) => void;
  }
) {
  runner.describe('plugin ctx contract', () => {
    for (const scenario of contractScenarios) {
      runner.it(scenario.name, async () => {
        const harness = await factory({
          manifest: scenario.manifest,
          setup: scenario.setup,
          now: DAY1,
        });
        try {
          await scenario.run(harness);
        } finally {
          await harness.close?.();
        }
      });
    }
  });
}
