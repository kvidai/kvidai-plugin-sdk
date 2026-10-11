import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import { PLUGIN_API_VERSION, satisfiesPluginApi } from './compat';

describe('satisfiesPluginApi', () => {
  it.each([
    // exact
    ['0.2.0', '0.2.0', true],
    ['0.2.0', '0.2.1', false],
    // caret: 0.y.z is breaking per minor, >= 1.0.0 per major, 0.0.z is exact
    ['^0.2.0', '0.2.0', true],
    ['^0.2.0', '0.2.9', true],
    ['^0.2.3', '0.2.2', false],
    ['^0.2.0', '0.3.0', false],
    ['^0.1.0', '0.2.0', false],
    ['^1.2.3', '1.9.0', true],
    ['^1.2.3', '2.0.0', false],
    ['^1.2.3', '1.2.2', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
    // tilde: same minor
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    ['~1.2.3', '1.2.2', false],
    // at least
    ['>=0.2.0', '0.2.0', true],
    ['>=0.2.0', '3.0.0', true],
    ['>=0.2.1', '0.2.0', false],
  ])('range %s against %s is %s', (range, version, expected) => {
    expect(satisfiesPluginApi(range, version)).toBe(expected);
  });

  it('compares numbers, not strings (0.10.0 is newer than 0.9.0)', () => {
    expect(satisfiesPluginApi('>=0.9.0', '0.10.0')).toBe(true);
    expect(satisfiesPluginApi('^0.9.0', '0.10.0')).toBe(false);
  });

  it.each([
    '',
    '*',
    'latest',
    '^1',
    '1.2',
    '>1.2.3',
    '^1.2.3-beta.1',
    '1.2.3 || 2.0.0',
    'v1.2.3',
    '^1.2.3 ',
  ])('refuses the range %j instead of guessing', (range) => {
    expect(() => satisfiesPluginApi(range, '1.2.3')).toThrow(/unsupported sdkVersion/);
  });

  it('refuses a version it cannot read', () => {
    expect(() => satisfiesPluginApi('^1.2.3', 'nope')).toThrow(/plugin API version/);
  });

  it('defaults to the plugin API version of this SDK', () => {
    expect(satisfiesPluginApi(`^${PLUGIN_API_VERSION}`)).toBe(true);
  });

  it('PLUGIN_API_VERSION follows the package version (same major.minor for 0.x), so a release cannot forget it', () => {
    const [major, minor] = pkg.version.split('.');
    expect(PLUGIN_API_VERSION.startsWith(`${major}.${minor}.`)).toBe(true);
  });
});
