import { describe, expect, expectTypeOf, it } from 'vitest';
import { definePlugin, PLUGIN_ID_PATTERN, type PluginCtx } from './index';

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

  describe('lifecycle (Strapi names: register, bootstrap, destroy)', () => {
    const define = (extra: object) =>
      definePlugin({ id: 'x', version: '1.0.0', ...extra } as unknown as Parameters<
        typeof definePlugin
      >[0]);

    it('rejects a plugin with no lifecycle function at all', () => {
      expect(() => define({})).toThrow(/must define bootstrap/);
    });

    it('accepts bootstrap, the old name setup, or register alone', () => {
      expect(() => define({ bootstrap() {} })).not.toThrow();
      expect(() => define({ setup() {} })).not.toThrow();
      expect(() => define({ register() {} })).not.toThrow();
    });

    it('rejects defining both bootstrap and its old name setup', () => {
      expect(() => define({ bootstrap() {}, setup() {} })).toThrow(/both bootstrap and setup/);
    });

    it.each(['register', 'bootstrap', 'setup', 'destroy'])(
      'rejects a %s that is not a function',
      (name) => {
        expect(() => define({ bootstrap() {}, [name]: 'nope' })).toThrow(
          new RegExp(`${name} must be a function`)
        );
      }
    );

    it('checks config: default must be an object and validator a function', () => {
      expect(() => define({ bootstrap() {}, config: { default: [] } })).toThrow(
        /config\.default must be an object/
      );
      expect(() => define({ bootstrap() {}, config: { validator: 'x' } })).toThrow(
        /config\.validator must be a function/
      );
      expect(() =>
        define({ bootstrap() {}, config: { default: { a: 1 }, validator() {} } })
      ).not.toThrow();
    });
  });

  it('exposes the id pattern used for namespacing grants and routes', () => {
    expect(PLUGIN_ID_PATTERN.test('attendance')).toBe(true);
    expect(PLUGIN_ID_PATTERN.test('daily-bonus2')).toBe(true);
  });
});

describe('ctx.strapi and ctx.knex types', () => {
  it('are any until a plugin merges its own host types (PluginHostTypes), so nothing needs @strapi/strapi installed', () => {
    expectTypeOf<PluginCtx['strapi']>().toBeAny();
    expectTypeOf<PluginCtx['knex']>().toBeAny();
  });
});
