import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { createMockRuntime, createMockUiKit, renderSlot } from './ui-testing';
import { usePluginT, usePluginUi } from './ui';

const messages = { en: { title: 'Daily check-in' }, ko: { title: '출석 체크' } };
const Sample = (props: { streak?: number }) => {
  const { Card, CardHeader, CardTitle, CardContent, Badge, Button } = usePluginUi();
  const t = usePluginT(messages);
  return h(
    Card,
    { className: 'c' },
    h(CardHeader, null, h(CardTitle, null, t('title'))),
    h(
      CardContent,
      null,
      h(Badge, null, `streak ${props.streak ?? 0}`),
      h(Button, { disabled: true, variant: 'outline', 'data-testid': 'go' }, 'Go')
    )
  );
};

describe('renderSlot', () => {
  it('renders a component with the mock kit and its props', () => {
    const { html } = renderSlot(Sample, { props: { streak: 3 } });
    expect(html).toBe(
      '<section class="c"><header><h3>Daily check-in</h3></header><div><span>streak 3</span>' +
        '<button type="button" disabled="" data-variant="outline" data-testid="go">Go</button></div></section>'
    );
  });

  it('uses the locale for the plugin texts', () => {
    expect(renderSlot(Sample, { locale: 'ko' }).html).toContain('<h3>출석 체크</h3>');
  });

  it('renders without props', () => {
    expect(renderSlot(Sample).html).toContain('streak 0');
  });
});

describe('createMockRuntime', () => {
  it('answers configured requests, 404s the rest, and records every call', async () => {
    const { runtime, calls } = createMockRuntime({
      responses: {
        'GET /status': { body: { streak: 2 } },
        'POST /check-in': { status: 500, body: { error: 'x' } },
      },
    });
    expect(await runtime.request('attendance', 'GET', '/status')).toEqual({
      status: 200,
      body: { streak: 2 },
    });
    expect(await runtime.request('attendance', 'POST', '/check-in', { a: 1 })).toEqual({
      status: 500,
      body: { error: 'x' },
    });
    expect((await runtime.request('attendance', 'GET', '/nope')).status).toBe(404);
    expect(calls).toEqual([
      { pluginId: 'attendance', method: 'GET', path: '/status', body: undefined },
      { pluginId: 'attendance', method: 'POST', path: '/check-in', body: { a: 1 } },
      { pluginId: 'attendance', method: 'GET', path: '/nope', body: undefined },
    ]);
  });

  it('defaults to English and the mock kit, and accepts another kit', () => {
    expect(createMockRuntime().runtime.locale).toBe('en');
    const kit = createMockUiKit();
    expect(createMockRuntime({ kit }).runtime.kit).toBe(kit);
  });
});
