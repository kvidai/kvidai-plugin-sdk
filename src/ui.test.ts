import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PluginApiError,
  PluginUiProvider,
  createT,
  definePluginUi,
  queryReducer,
  usePluginApi,
  usePluginLocale,
  usePluginQuery,
  usePluginUi,
  type PluginRuntime,
  type PluginUiKit,
} from './ui';

const plain = (tag: string) => (props: { children?: ReactNode; className?: string }) =>
  h(tag, { className: props.className }, props.children);
const kit: PluginUiKit = {
  Button: (props) =>
    h('button', { disabled: props.disabled, 'data-testid': props['data-testid'] }, props.children),
  Card: plain('section'),
  CardHeader: plain('header'),
  CardTitle: plain('h3'),
  CardContent: plain('div'),
  Badge: plain('span'),
};
const runtime = (over: Partial<PluginRuntime> = {}): PluginRuntime => ({
  kit,
  locale: 'ko',
  request: vi.fn(async () => ({ status: 200, body: { ok: true } })),
  ...over,
});
const render = (rt: PluginRuntime, child: ReactNode) =>
  renderToStaticMarkup(h(PluginUiProvider, { value: rt }, child));

describe('createT', () => {
  const messages = {
    en: { hello: 'Hello {name}', only: 'English only' },
    ko: { hello: '안녕 {name}' },
  };

  it('uses the message of the locale and fills {placeholders}', () => {
    expect(createT(messages, 'ko')('hello', { name: '민수' })).toBe('안녕 민수');
  });

  it('falls back to English, then to the key', () => {
    expect(createT(messages, 'ko')('only')).toBe('English only');
    expect(createT(messages, 'ko')('missing.key')).toBe('missing.key');
  });

  it('uses the base language of a regional locale', () => {
    expect(createT(messages, 'ko-KR')('hello', { name: 'a' })).toBe('안녕 a');
  });

  it('keeps a placeholder that has no value', () => {
    expect(createT(messages, 'en')('hello')).toBe('Hello {name}');
  });

  it('shows the key for an unknown locale with no English', () => {
    expect(createT({ ko: { a: '가' } }, 'es')('a')).toBe('a');
  });
});

describe('definePluginUi', () => {
  const Card = () => null;

  it('returns the definition', () => {
    const def = { slots: { 'credits.page': Card }, messages: { en: { a: 'A' } } };
    expect(definePluginUi(def)).toBe(def);
  });

  it('rejects a slot name that does not exist, so a typo fails at load instead of showing nothing', () => {
    expect(() => definePluginUi({ slots: { 'credits.pgae': Card } as any })).toThrow(
      /unknown slot "credits\.pgae"/
    );
  });

  it('rejects a slot that is not a component', () => {
    expect(() => definePluginUi({ slots: { 'credits.page': 'AttendanceCard' as any } })).toThrow(
      /credits\.page.*component/
    );
  });
});

describe('hooks', () => {
  it('usePluginUi gives the host kit', () => {
    const View = () => {
      const ui = usePluginUi();
      return h(ui.Card, null, h(ui.Button, { 'data-testid': 'go' }, 'Go'));
    };
    expect(render(runtime(), h(View))).toBe(
      '<section><button data-testid="go">Go</button></section>'
    );
  });

  it('usePluginLocale gives the locale', () => {
    const View = () => h('i', null, usePluginLocale());
    expect(render(runtime({ locale: 'es' }), h(View))).toBe('<i>es</i>');
  });

  it.each([
    ['usePluginUi', () => usePluginUi()],
    ['usePluginLocale', () => usePluginLocale()],
    ['usePluginApi', () => usePluginApi('x')],
  ])('%s outside a plugin slot says what is wrong', (_name, hook) => {
    const View = () => (hook(), null);
    expect(() => renderToStaticMarkup(h(View))).toThrow(/inside a plugin slot/);
  });
});

describe('usePluginApi', () => {
  const capture = (rt: PluginRuntime) => {
    let api!: ReturnType<typeof usePluginApi>;
    const View = () => ((api = usePluginApi('attendance')), null);
    render(rt, h(View));
    return api;
  };

  it('GET and POST go through the host with the plugin id, and return the body', async () => {
    const request = vi.fn(async () => ({ status: 200, body: { streak: 3 } }));
    const api = capture(runtime({ request }));
    expect(await api.get('/status')).toEqual({ streak: 3 });
    expect(await api.post('/check-in', { a: 1 })).toEqual({ streak: 3 });
    expect(request).toHaveBeenNthCalledWith(1, 'attendance', 'GET', '/status', undefined);
    expect(request).toHaveBeenNthCalledWith(2, 'attendance', 'POST', '/check-in', { a: 1 });
  });

  it('throws a PluginApiError with the status for a failed response', async () => {
    const api = capture(
      runtime({ request: async () => ({ status: 401, body: { error: 'unauthorized' } }) })
    );
    await expect(api.get('/status')).rejects.toMatchObject({ name: 'PluginApiError', status: 401 });
    await expect(api.get('/status')).rejects.toBeInstanceOf(PluginApiError);
  });

  it('lets a network failure through as it is', async () => {
    const api = capture(
      runtime({
        request: async () => {
          throw new Error('offline');
        },
      })
    );
    await expect(api.get('/status')).rejects.toThrow('offline');
  });
});

describe('queryReducer', () => {
  it('goes loading -> ready with the data', () => {
    const loading = queryReducer({ status: 'loading' }, { type: 'start' });
    expect(loading).toEqual({ status: 'loading' });
    expect(queryReducer(loading, { type: 'success', data: { a: 1 } })).toEqual({
      status: 'ready',
      data: { a: 1 },
    });
  });

  it('keeps the previous data while it reloads, so the card does not flash empty', () => {
    expect(queryReducer({ status: 'ready', data: 1 }, { type: 'start' })).toEqual({
      status: 'loading',
      data: 1,
    });
  });

  it('goes to error, keeping stale data if there is some', () => {
    const err = new Error('x');
    expect(queryReducer({ status: 'loading' }, { type: 'failure', error: err })).toEqual({
      status: 'error',
      error: err,
    });
    expect(queryReducer({ status: 'loading', data: 1 }, { type: 'failure', error: err })).toEqual({
      status: 'error',
      data: 1,
      error: err,
    });
  });
});

describe('usePluginQuery', () => {
  it('starts in the loading state on the first render', () => {
    const View = () => {
      const q = usePluginQuery<{ n: number }>('attendance', '/status');
      return h('b', { 'data-status': q.status }, q.status);
    };
    expect(render(runtime(), h(View))).toBe('<b data-status="loading">loading</b>');
  });
});
