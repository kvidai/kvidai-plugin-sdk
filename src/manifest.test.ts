import { describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION } from './compat';
import { PLUGIN_PERMISSIONS, validateManifest } from './manifest';

const ok = { id: 'foo', sdkVersion: `^${PLUGIN_API_VERSION}`, permissions: ['routes'] };

describe('validateManifest', () => {
  it('accepts a good manifest, with and without a budget', () => {
    expect(validateManifest(ok, 'foo')).toEqual([]);
    expect(
      validateManifest({ ...ok, budget: { dailyCredits: 100, perGrantMax: 10 } }, 'foo')
    ).toEqual([]);
  });

  it('lists every documented permission', () => {
    expect(PLUGIN_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'credits.grant',
        'store',
        'routes',
        'db',
        'events:user.created',
        'events:credit.used',
      ])
    );
    expect(validateManifest({ ...ok, permissions: [...PLUGIN_PERMISSIONS] }, 'foo')).toEqual([]);
  });

  it.each([
    [undefined, /no "kvidai" field/],
    ['text', /no "kvidai" field/],
    [{ ...ok, id: 'other' }, /manifest id "other" does not match "foo"/],
    [{ ...ok, permissions: 'routes' }, /permissions must be an array/],
    [{ ...ok, permissions: ['root.access'] }, /unknown permission "root\.access"/],
    [{ ...ok, sdkVersion: undefined }, /sdkVersion is required/],
    [{ ...ok, sdkVersion: 2 }, /sdkVersion must be a string/],
    [{ ...ok, sdkVersion: 'latest' }, /unsupported sdkVersion range "latest"/],
    [{ ...ok, sdkVersion: '^0.1.0' }, /needs plugin API \^0\.1\.0, this SDK provides/],
    [{ ...ok, budget: 5 }, /budget must be an object/],
    [{ ...ok, budget: { dailyCredits: 0 } }, /budget\.dailyCredits must be a positive number/],
    [{ ...ok, budget: { perGrantMax: -1 } }, /budget\.perGrantMax/],
  ])('reports %j', (kvidai, message) => {
    expect(validateManifest(kvidai, 'foo').join('\n')).toMatch(message);
  });

  it('reports every problem, not just the first', () => {
    const problems = validateManifest({ id: 'x', permissions: ['nope'] }, 'foo');
    expect(problems.length).toBe(3);
  });
});
