/**
 * Test helpers for plugin React components, without the web app, a browser or a server:
 *
 *   const { html, runtime } = renderSlot(AttendanceCardView, { props: { status: { streak: 3 } }, locale: 'ko' });
 *   expect(html).toContain('3');
 *
 * Rendering is static (react-dom/server): effects do not run, so keep a component's looks in a pure view that takes its data as props and
 * test that; the thin container that loads data with usePluginQuery is exercised in the browser against the real app.
 * Separate from ./testing so server-only plugins can test without React installed.
 */
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PluginUiProvider, type PluginRuntime, type PluginUiKit } from './ui';

/** Plain HTML stand-ins for the host's parts: `<button>`, `<section>`, `<header>`, `<h3>`, `<div>`, `<span>`. */
export function createMockUiKit(): PluginUiKit {
  const box = (tag: string) => (props: { children?: React.ReactNode; className?: string }) =>
    createElement(tag, { className: props.className }, props.children);
  return {
    Button: (props) =>
      createElement(
        'button',
        {
          type: props.type ?? 'button',
          disabled: props.disabled,
          className: props.className,
          'data-variant': props.variant,
          'data-testid': props['data-testid'],
        },
        props.children
      ),
    Card: box('section'),
    CardHeader: box('header'),
    CardTitle: box('h3'),
    CardContent: box('div'),
    Badge: box('span'),
  };
}

export type MockResponse = { status?: number; body: unknown };

/** `responses` is keyed like 'GET /status'. A request nobody answers is a 404. Every request is recorded in `calls`. */
export function createMockRuntime(
  options: { locale?: string; responses?: Record<string, MockResponse>; kit?: PluginUiKit } = {}
) {
  const calls: Array<{ pluginId: string; method: string; path: string; body: unknown }> = [];
  const runtime: PluginRuntime = {
    kit: options.kit ?? createMockUiKit(),
    locale: options.locale ?? 'en',
    async request(pluginId, method, path, body) {
      calls.push({ pluginId, method, path, body });
      const answer = options.responses?.[`${method} ${path}`];
      return answer
        ? { status: answer.status ?? 200, body: answer.body }
        : { status: 404, body: { error: 'not_found' } };
    },
  };
  return { runtime, calls };
}

/** Renders a component the way the web app would, inside a plugin slot, and returns the static HTML. */
export function renderSlot<P extends object>(
  Component: ComponentType<P>,
  options: { props?: P; locale?: string; responses?: Record<string, MockResponse> } = {}
) {
  const { runtime, calls } = createMockRuntime({
    locale: options.locale,
    responses: options.responses,
  });
  const html = renderToStaticMarkup(
    createElement(
      PluginUiProvider,
      { value: runtime },
      createElement(Component as ComponentType<object>, (options.props ?? {}) as object)
    )
  );
  return { html, runtime, calls };
}
