/**
 * What a plugin's React components may use. The web app renders them inside a plugin slot and hands them everything through context, so a
 * plugin never imports the app's own components, never sees the user's token, and can be developed against the mock in ./ui-testing.
 *
 *   export default definePluginUi({
 *     slots: { 'credits.page': AttendanceCard },
 *     messages: { en: { title: 'Daily check-in' }, ko: { title: '출석 체크' } },
 *   });
 *
 *   function AttendanceCard() {
 *     const { Card, CardTitle, Button } = usePluginUi();
 *     const status = usePluginQuery<{ streak: number }>('attendance', '/status');
 *     ...
 *   }
 *
 * Needs React (an optional peer dependency): only plugins with a UI install it.
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { PLUGIN_SLOTS, type PluginSlotName } from './index';

// Plugin UI code and the host only import from '@kvidai/plugin-sdk/ui', so the slot names must be available here too.
export { PLUGIN_SLOTS, type PluginSlotName } from './index';

type Box = { children?: ReactNode; className?: string };

/** The parts the host app provides. Small on purpose: a part that is missing here is a request to add it to the kit, not a reason to import core. */
export type PluginUiKit = {
  Button: ComponentType<{
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: 'default' | 'outline' | 'ghost';
    size?: 'default' | 'sm';
    type?: 'button' | 'submit';
    className?: string;
    'data-testid'?: string;
  }>;
  Card: ComponentType<Box>;
  CardHeader: ComponentType<Box>;
  CardTitle: ComponentType<Box>;
  CardContent: ComponentType<Box>;
  Badge: ComponentType<Box & { variant?: 'default' | 'secondary' | 'outline' }>;
};

/** Provided by the host to every component it renders for a plugin. */
export type PluginRuntime = {
  kit: PluginUiKit;
  /** The UI language, such as 'en' or 'ko'. */
  locale: string;
  /** Calls /api/plugins/<pluginId><path> as the logged-in user. The host adds the credentials. */
  request(
    pluginId: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }>;
};

export type PluginSlotProps = { slot: PluginSlotName };
export type PluginMessages = Record<string, Record<string, string>>;

export type PluginUiDefinition = {
  slots: Partial<Record<PluginSlotName, ComponentType<PluginSlotProps>>>;
  /** Texts by locale. 'en' is the fallback. */
  messages?: PluginMessages;
};

export function definePluginUi<T extends PluginUiDefinition>(definition: T): T {
  for (const [slot, component] of Object.entries(definition.slots)) {
    if (!(PLUGIN_SLOTS as readonly string[]).includes(slot))
      throw new Error(`unknown slot "${slot}" (known: ${PLUGIN_SLOTS.join(', ')})`);
    if (typeof component !== 'function')
      throw new Error(`slot "${slot}" must be a component (a function)`);
  }
  return definition;
}

const RuntimeContext = createContext<PluginRuntime | null>(null);

/** Used by the web app, and by renderSlot in tests. Plugins do not render this themselves. */
export function PluginUiProvider({
  value,
  children,
}: {
  value: PluginRuntime;
  children?: ReactNode;
}) {
  return createElement(RuntimeContext.Provider, { value }, children);
}

function useRuntime(): PluginRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new Error(
      'Plugin UI hooks must be used inside a plugin slot (the web app renders your component in one). In tests, use renderSlot from @kvidai/plugin-sdk/ui-testing.'
    );
  }
  return runtime;
}

export const usePluginUi = (): PluginUiKit => useRuntime().kit;
export const usePluginLocale = (): string => useRuntime().locale;

/** Translates with the plugin's own messages: locale, then its base language ('ko-KR' -> 'ko'), then 'en', then the key. `{name}` is filled from vars. */
export function createT(messages: PluginMessages, locale: string) {
  const base = locale.split('-')[0];
  return (key: string, vars?: Record<string, string | number>): string => {
    const text = messages[locale]?.[key] ?? messages[base]?.[key] ?? messages.en?.[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (placeholder, name) =>
      vars && name in vars ? String(vars[name]) : placeholder
    );
  };
}

export const usePluginT = (messages: PluginMessages) => {
  const locale = usePluginLocale();
  return useMemo(() => createT(messages, locale), [messages, locale]);
};

export class PluginApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`plugin request failed with status ${status}`);
    this.name = 'PluginApiError';
    this.status = status;
    this.body = body;
  }
}

/** GET/POST to your plugin's routes (the ones you registered with ctx.routes). A non-2xx answer throws PluginApiError. */
export function usePluginApi(pluginId: string) {
  const { request } = useRuntime();
  return useMemo(() => {
    const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
      const { status, body: data } = await request(pluginId, method, path, body);
      if (status < 200 || status >= 300) throw new PluginApiError(status, data);
      return data as T;
    };
    return {
      get: <T = unknown>(path: string) => call<T>('GET', path, undefined),
      post: <T = unknown>(path: string, body?: unknown) => call<T>('POST', path, body),
    };
  }, [request, pluginId]);
}

export type QueryState<T> = { status: 'loading' | 'ready' | 'error'; data?: T; error?: Error };
type QueryAction<T> =
  | { type: 'start' }
  | { type: 'success'; data: T }
  | { type: 'failure'; error: Error };

/** Pure so it can be tested without a DOM. Stale data is kept while reloading or after a failure, so a card does not flash empty. */
export function queryReducer<T>(state: QueryState<T>, action: QueryAction<T>): QueryState<T> {
  const stale = state.data !== undefined ? { data: state.data } : {};
  switch (action.type) {
    case 'start':
      return { status: 'loading', ...stale };
    case 'success':
      return { status: 'ready', data: action.data };
    case 'failure':
      return { status: 'error', ...stale, error: action.error };
  }
}

/** Loads GET <path> of your plugin when the component mounts. `refetch()` loads it again, e.g. after a POST. */
export function usePluginQuery<T>(
  pluginId: string,
  path: string
): QueryState<T> & { refetch: () => void } {
  const api = usePluginApi(pluginId);
  const [state, dispatch] = useReducer(
    queryReducer as (s: QueryState<T>, a: QueryAction<T>) => QueryState<T>,
    { status: 'loading' } as QueryState<T>
  );
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'start' });
    api.get<T>(path).then(
      (data) => !cancelled && dispatch({ type: 'success', data }),
      (error) =>
        !cancelled &&
        dispatch({
          type: 'failure',
          error: error instanceof Error ? error : new Error(String(error)),
        })
    );
    return () => {
      cancelled = true;
    };
  }, [api, path, reloads]);

  return { ...state, refetch: () => setReloads((n) => n + 1) };
}
