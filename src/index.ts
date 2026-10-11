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

export type RouteRequest = {
  /** Present when the route is `auth: 'user'`. */
  user: { id: string } | null;
  body: unknown;
  query: Record<string, string>;
};

export type RouteHandler = (req: RouteRequest) => Promise<unknown> | unknown;

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
  /** Runs after the core write has finished; a throwing handler never affects core. */
  on<E extends PluginEventName>(
    event: E,
    handler: (payload: PluginEventMap[E]) => Promise<void> | void
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

export type PluginDefinition = {
  /** Stable forever (it namespaces every grant). See PLUGIN_ID_PATTERN. */
  id: string;
  /** Semver. */
  version: string;
  setup(ctx: PluginCtx): Promise<void> | void;
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
  if (typeof plugin.setup !== 'function') {
    throw new Error(`Plugin ${plugin.id} must define a setup(ctx) function`);
  }
  return plugin;
}
