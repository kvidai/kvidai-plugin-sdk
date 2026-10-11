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
import type { PluginConfigDefinition, PluginCtx, PluginEventName, PluginMigration } from './index';

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
  /** What core does at a filter point: hands `value` through every plugin filter and returns the result. */
  applyFilter(name: string, value: unknown, info?: unknown): Promise<unknown>;
  /** Shuts the plugin down like Strapi's destroy does; never throws. */
  destroy(): Promise<void>;
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
  /** Applied before setup, like the host does for a plugin's `migrations`. */
  migrations?: PluginMigration[];
  /** The plugin's `config` (defaults and validator). */
  config?: PluginConfigDefinition;
  /** Runs before setup (bootstrap), like the host runs every plugin's register first. */
  register?: (ctx: PluginCtx) => void | Promise<void>;
  destroy?: (ctx: PluginCtx) => void | Promise<void>;
  /** How long a filter may take before it is skipped. The real default is a couple of seconds; the contract uses a short one. */
  filterTimeoutMs: number;
  /** How long destroy may take before the shutdown goes on without it. */
  destroyTimeoutMs: number;
  setup?: (ctx: PluginCtx) => void | Promise<void>;
  now: Date;
}) => Promise<ContractHarness>;

export type ContractScenario = {
  name: string;
  manifest: ContractManifest;
  migrations?: PluginMigration[];
  config?: PluginConfigDefinition;
  register?: (ctx: PluginCtx) => void | Promise<void>;
  destroy?: (ctx: PluginCtx) => void | Promise<void>;
  setup?: (ctx: PluginCtx) => void | Promise<void>;
  /** The plugin must fail to start (a migration or setup that throws) with an error matching this; `run` is not called. */
  expectStartFailure?: RegExp;
  run: (h: ContractHarness) => Promise<void>;
};

const MISSIONS_MIGRATION: PluginMigration = {
  id: '001-create-missions',
  up: (schema) =>
    schema.createTable('missions', (t) => {
      t.string('user_id').notNull().index();
      t.string('title').notNull();
      t.integer('reward').notNull().default(0);
      t.boolean('done').notNull().default(false);
      t.string('code').unique();
    }),
};

const TYPES_MIGRATION: PluginMigration = {
  id: '001-create-typed',
  up: (schema) =>
    schema.createTable('typed', (t) => {
      t.string('label').notNull();
      t.string('note');
      t.boolean('flag');
      t.decimal('amount', 10, 2);
      t.bigInteger('big');
      t.datetime('seen_at');
      t.json('meta');
    }),
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
  // ---- filters (a value core hands to the plugins before it uses it) ----
  {
    name: 'filters: a value goes through the filters in the order they were registered, each seeing the previous result',
    manifest: { permissions: [] },
    setup: (ctx) => {
      ctx.filter('popup.list', (list) => [...list, { id: 'a' }]);
      ctx.filter('popup.list', async (list) => [...list, { id: 'b' }]);
    },
    run: async ({ applyFilter }) => {
      const result = (await applyFilter('popup.list', [{ id: 'core' }], { query: {} })) as Array<{
        id: string;
      }>;
      assert.deepEqual(
        result.map((p) => p.id),
        ['core', 'a', 'b']
      );
    },
  },
  {
    name: 'filters: the filter is given the info core passes',
    manifest: { permissions: [] },
    setup: (ctx) => {
      ctx.filter('popup.list', (list, info) => [...list, { id: `q:${String(info.query.locale)}` }]);
    },
    run: async ({ applyFilter }) => {
      const result = (await applyFilter('popup.list', [], { query: { locale: 'ko' } })) as Array<{
        id: string;
      }>;
      assert.deepEqual(result, [{ id: 'q:ko' }]);
    },
  },
  {
    name: 'filters: fail-open. A filter that throws, returns nothing or never finishes is skipped and the value goes on unchanged',
    manifest: { permissions: [] },
    setup: (ctx) => {
      ctx.filter('popup.list', () => {
        throw new Error('boom');
      });
      ctx.filter('popup.list', (() => undefined) as never);
      ctx.filter('popup.list', () => new Promise(() => {}));
      ctx.filter('popup.list', (list) => [...list, { id: 'survivor' }]);
    },
    run: async ({ applyFilter }) => {
      const started = Date.now();
      const result = (await applyFilter('popup.list', [{ id: 'core' }], { query: {} })) as Array<{
        id: string;
      }>;
      assert.deepEqual(
        result.map((p) => p.id),
        ['core', 'survivor']
      );
      assert.ok(
        Date.now() - started < 1500,
        'a filter that never finishes must not hold the request'
      );
    },
  },
  {
    name: 'filters: a plugin that is switched off is skipped at once, and applies again when switched on',
    manifest: { permissions: [] },
    setup: (ctx) => {
      ctx.filter('popup.list', (list) => [...list, { id: 'plugin' }]);
    },
    run: async ({ applyFilter, setEnabled }) => {
      await setEnabled(false);
      assert.deepEqual(await applyFilter('popup.list', [], { query: {} }), []);
      await setEnabled(true);
      assert.deepEqual(await applyFilter('popup.list', [], { query: {} }), [{ id: 'plugin' }]);
    },
  },
  {
    name: 'filters: with no filter registered the value comes back as it was',
    manifest: { permissions: [] },
    run: async ({ applyFilter }) => {
      const list = [{ id: 'core' }];
      assert.equal(await applyFilter('popup.list', list, { query: {} }), list);
    },
  },
  {
    name: 'filters: registering a filter that core does not have is an error',
    manifest: { permissions: [] },
    run: async ({ ctx }) => {
      assert.throws(
        () => ctx.filter('nope' as never, ((v: unknown) => v) as never),
        /unknown filter "nope"/
      );
    },
  },
  // ---- lifecycle (Strapi's names: register, bootstrap, destroy, config) ----
  {
    name: 'lifecycle: register runs before bootstrap, and both get the same ctx',
    manifest: { permissions: ['store'] },
    register: async (ctx) => {
      await ctx.store.set('7', 'phase', 'registered');
    },
    setup: async (ctx) => {
      await ctx.store.set('7', 'seenInBootstrap', await ctx.store.get('7', 'phase'));
    },
    run: async ({ ctx }) => {
      assert.equal(await ctx.store.get('7', 'seenInBootstrap'), 'registered');
    },
  },
  {
    name: 'config: the defaults are what ctx.config holds when nothing is set',
    manifest: { permissions: [] },
    config: { default: { greeting: 'hi', limit: 3 } },
    run: async ({ ctx }) => {
      assert.deepEqual(ctx.config, { greeting: 'hi', limit: 3 });
    },
  },
  {
    name: 'config: a validator that throws refuses the plugin (it does not start)',
    manifest: { permissions: [] },
    config: {
      default: { limit: -1 },
      validator: (config) => {
        if (Number(config.limit) < 0) throw new Error('limit must not be negative');
      },
    },
    run: async () => {
      assert.fail('the harness should have refused to start the plugin');
    },
    expectStartFailure: /limit must not be negative/,
  },
  // ---- lifecycle ----
  {
    name: 'lifecycle: destroy runs once at shutdown with the same ctx',
    manifest: { permissions: ['store'] },
    destroy: async (ctx) => {
      await ctx.store.set(
        '7',
        'destroyed',
        (Number(await ctx.store.get('7', 'destroyed')) || 0) + 1
      );
    },
    run: async ({ ctx, destroy }) => {
      await destroy();
      assert.equal(await ctx.store.get('7', 'destroyed'), 1);
    },
  },
  {
    name: 'lifecycle: a destroy that throws or never finishes does not stop the shutdown',
    manifest: { permissions: [] },
    destroy: () => new Promise(() => {}),
    run: async ({ destroy }) => {
      const started = Date.now();
      await destroy();
      assert.ok(Date.now() - started < 4000);
    },
  },
  // ---- full control: the running Strapi and its database connection, like a Strapi plugin has ----
  {
    name: 'full control: ctx.strapi and ctx.knex are there without declaring any permission',
    manifest: { permissions: [] },
    run: async ({ ctx }) => {
      assert.equal(typeof ctx.strapi, 'object');
      assert.notEqual(ctx.strapi, null);
      assert.notEqual(ctx.knex, null);
      assert.notEqual(ctx.knex, undefined);
    },
  },
  // ---- plugin-owned tables (ctx.db + migrations) ----
  {
    name: 'db: a migration creates a table; insert returns the row with its id; find, findOne and count read it back',
    manifest: { permissions: ['db'] },
    migrations: [MISSIONS_MIGRATION],
    run: async ({ ctx }) => {
      const missions = ctx.db.table('missions');
      const first = await missions.insert({ user_id: '7', title: 'Invite a friend', reward: 10 });
      assert.equal(typeof first.id, 'number');
      assert.equal(first.title, 'Invite a friend');
      assert.equal(first.done, false, 'a column with a default gets it');
      await missions.insert({ user_id: '7', title: 'Make a video', reward: 20 });
      await missions.insert({ user_id: '8', title: 'Make a video', reward: 20 });

      assert.equal(await missions.count(), 3);
      assert.equal(await missions.count({ user_id: '7' }), 2);
      assert.equal((await missions.find({ user_id: '8' })).length, 1);
      assert.equal((await missions.findOne({ user_id: '7', title: 'Make a video' }))?.reward, 20);
      assert.equal(await missions.findOne({ user_id: '9' }), null);
    },
  },
  {
    name: 'db: find can order, limit and skip rows',
    manifest: { permissions: ['db'] },
    migrations: [MISSIONS_MIGRATION],
    run: async ({ ctx }) => {
      const missions = ctx.db.table('missions');
      for (const reward of [30, 10, 20])
        await missions.insert({ user_id: '7', title: `m${reward}`, reward });
      const byReward = await missions.find({}, { orderBy: ['reward', 'asc'] });
      assert.deepEqual(
        byReward.map((m) => m.reward),
        [10, 20, 30]
      );
      const top = await missions.find({}, { orderBy: ['reward', 'desc'], limit: 2 });
      assert.deepEqual(
        top.map((m) => m.reward),
        [30, 20]
      );
      const rest = await missions.find({}, { orderBy: ['reward', 'desc'], limit: 2, offset: 2 });
      assert.deepEqual(
        rest.map((m) => m.reward),
        [10]
      );
    },
  },
  {
    name: 'db: update and delete return how many rows they touched, and only touch the matching rows',
    manifest: { permissions: ['db'] },
    migrations: [MISSIONS_MIGRATION],
    run: async ({ ctx }) => {
      const missions = ctx.db.table('missions');
      await missions.insert({ user_id: '7', title: 'a', reward: 1 });
      await missions.insert({ user_id: '7', title: 'b', reward: 2 });
      await missions.insert({ user_id: '8', title: 'c', reward: 3 });

      assert.equal(await missions.update({ user_id: '7' }, { done: true }), 2);
      assert.equal(await missions.update({ user_id: '9' }, { done: true }), 0);
      assert.equal(await missions.count({ done: true }), 2);
      assert.equal((await missions.findOne({ user_id: '8' }))?.done, false);

      assert.equal(await missions.delete({ user_id: '7', title: 'a' }), 1);
      assert.equal(await missions.delete({ user_id: '9' }), 0);
      assert.equal(await missions.count(), 2);
    },
  },
  {
    name: 'db: a column set to null stays null, and the column types come back as declared (boolean, number, date, json)',
    manifest: { permissions: ['db'] },
    migrations: [TYPES_MIGRATION],
    run: async ({ ctx }) => {
      const t = ctx.db.table('typed');
      const row = await t.insert({
        label: 'x',
        flag: true,
        amount: 12.5,
        big: 9007199254740991,
        seen_at: new Date(Date.UTC(2026, 9, 10, 12, 0, 0)),
        meta: { tags: ['a', 'b'], n: 1 },
      });
      const back = await t.findOne({ id: row.id });
      assert.ok(back);
      assert.equal(back.note, null);
      assert.equal(back.flag, true);
      assert.equal(back.amount, 12.5);
      assert.equal(back.big, 9007199254740991);
      assert.ok(back.seen_at instanceof Date);
      assert.equal((back.seen_at as Date).toISOString(), '2026-10-10T12:00:00.000Z');
      assert.deepEqual(back.meta, { tags: ['a', 'b'], n: 1 });
    },
  },
  {
    name: 'db: notNull columns must be given, unique columns reject a second equal value',
    manifest: { permissions: ['db'] },
    migrations: [MISSIONS_MIGRATION],
    run: async ({ ctx }) => {
      const missions = ctx.db.table('missions');
      await assert.rejects(() => missions.insert({ reward: 1 }), /user_id|title/);
      await missions.insert({ user_id: '7', title: 'once', reward: 1, code: 'ABC' });
      await assert.rejects(() =>
        missions.insert({ user_id: '8', title: 'twice', reward: 1, code: 'ABC' })
      );
      assert.equal(await missions.count(), 1, 'the rejected insert left nothing behind');
    },
  },
  {
    name: 'db: a table or a column the plugin did not create is rejected, and so is a name that is not allowed',
    manifest: { permissions: ['db'] },
    migrations: [MISSIONS_MIGRATION],
    run: async ({ ctx }) => {
      assert.throws(() => ctx.db.table('users'), /does not exist/);
      assert.throws(() => ctx.db.table('plugin_other_missions'), /not allowed|does not exist/);
      assert.throws(() => ctx.db.table('missions; drop table x'), /not allowed/);
      const missions = ctx.db.table('missions');
      await assert.rejects(() => missions.find({ nope: 1 }), /no column "nope"/);
      await assert.rejects(
        () => missions.insert({ user_id: '7', title: 't', nope: 1 }),
        /no column "nope"/
      );
      await assert.rejects(
        () => missions.update({ user_id: '7' }, { nope: 1 }),
        /no column "nope"/
      );
      await assert.rejects(
        () => missions.find({}, { orderBy: ['nope', 'asc'] }),
        /no column "nope"/
      );
    },
  },
  {
    name: 'db: without the db permission the tables cannot be used',
    manifest: { permissions: [] },
    run: async ({ ctx }) => {
      assert.throws(() => ctx.db.table('missions'), /missing permission db/);
    },
  },
  {
    name: 'db: addColumns in a later migration adds a column that existing rows read as null',
    manifest: { permissions: ['db'] },
    migrations: [
      MISSIONS_MIGRATION,
      {
        id: '002-add-note',
        up: (schema) => schema.addColumns('missions', (t) => void t.string('note')),
      },
    ],
    run: async ({ ctx }) => {
      const missions = ctx.db.table('missions');
      const row = await missions.insert({ user_id: '7', title: 'a', reward: 1, note: 'hi' });
      assert.equal((await missions.findOne({ id: row.id }))?.note, 'hi');
    },
  },
  {
    name: 'db: a migration that fails stops the plugin from loading',
    manifest: { permissions: ['db'] },
    migrations: [
      {
        id: '001-bad',
        up: (schema) => schema.addColumns('missing_table', (t) => void t.string('x')),
      },
    ],
    run: async () => {
      assert.fail('the harness should have refused to start the plugin');
    },
    expectStartFailure: /missing_table|does not exist/,
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
        const start = () =>
          factory({
            manifest: scenario.manifest,
            migrations: scenario.migrations,
            config: scenario.config,
            register: scenario.register,
            destroy: scenario.destroy,
            setup: scenario.setup,
            now: DAY1,
            filterTimeoutMs: 60,
            destroyTimeoutMs: 60,
          });
        if (scenario.expectStartFailure) {
          await assert.rejects(start, scenario.expectStartFailure);
          return;
        }
        const harness = await start();
        try {
          await scenario.run(harness);
        } finally {
          await harness.close?.();
        }
      });
    }
  });
}
