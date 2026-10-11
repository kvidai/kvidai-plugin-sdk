import { describe, expect, it } from 'vitest';
import { definePlugin, PLUGIN_ID_PATTERN } from './index';

const base = {
  id: 'attendance',
  version: '1.0.0',
  setup: () => {},
};

describe('definePlugin', () => {
  it('returns the definition unchanged when valid', () => {
    const def = definePlugin(base);
    expect(def).toBe(base);
  });

  it.each(['Attendance', 'a_b', '-a', 'a-', '', 'a b', '1abc'])('rejects invalid id %j', (id) => {
    expect(() => definePlugin({ ...base, id })).toThrow(/plugin id/);
  });

  it.each(['1', '1.0', 'v1.0.0', ''])('rejects non-semver version %j', (version) => {
    expect(() => definePlugin({ ...base, version })).toThrow(/version/);
  });

  it('rejects a missing setup function', () => {
    expect(() =>
      definePlugin({ id: 'x', version: '1.0.0' } as unknown as Parameters<typeof definePlugin>[0])
    ).toThrow(/setup/);
  });

  it('exposes the id pattern used for namespacing grants and routes', () => {
    expect(PLUGIN_ID_PATTERN.test('attendance')).toBe(true);
    expect(PLUGIN_ID_PATTERN.test('daily-bonus2')).toBe(true);
  });
});
