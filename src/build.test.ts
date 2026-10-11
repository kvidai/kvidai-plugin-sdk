import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION } from './compat';
import { buildProject, verifyProject } from './build';

const SDK_SRC = path.resolve(__dirname, 'index.ts');
let dir: string;
let out: string;

const SOURCE = `import { definePlugin } from '@kvidai/plugin-sdk';
export default definePlugin({ id: 'foo', version: '1.0.0', bootstrap(ctx) { ctx.log.info('hi'); } });
`;

function project(
  opts: {
    kvidai?: unknown;
    pkg?: Record<string, unknown>;
    source?: string | null;
    exports?: unknown;
  } = {}
) {
  mkdirSync(path.join(dir, 'server/src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: '@kvidai-plugin/foo',
      version: '1.2.3',
      exports: 'exports' in opts ? opts.exports : { './server': './server/src/index.ts' },
      kvidai:
        'kvidai' in opts
          ? opts.kvidai
          : { id: 'foo', sdkVersion: `^${PLUGIN_API_VERSION}`, permissions: ['routes'] },
      ...opts.pkg,
    })
  );
  if (opts.source !== null)
    writeFileSync(path.join(dir, 'server/src/index.ts'), opts.source ?? SOURCE);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kvidai-sdk-build-'));
  out = path.join(dir, 'out');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verifyProject', () => {
  it('accepts a good project', () => {
    project();
    expect(verifyProject(dir)).toEqual([]);
  });

  it.each([
    [{ kvidai: undefined }, /no "kvidai" field/],
    [{ kvidai: { id: 'Bad_Id', sdkVersion: '^0.2.0', permissions: [] } }, /kvidai\.id/],
    [{ kvidai: { id: 'foo', sdkVersion: '^0.1.0', permissions: [] } }, /needs plugin API/],
    [
      { kvidai: { id: 'foo', sdkVersion: '^0.2.0', permissions: ['root'] } },
      /unknown permission "root"/,
    ],
    [{ exports: {} }, /must export "\.\/server"/],
    [{ source: null }, /server entry .* not found/],
  ])('reports %j', (opts, message) => {
    project(opts as Parameters<typeof project>[0]);
    expect(verifyProject(dir).join('\n')).toMatch(message);
  });

  it('reports a missing package.json', () => {
    expect(verifyProject(dir).join('\n')).toMatch(/package\.json not found/);
  });
});

describe('buildProject', () => {
  it('writes <out>/<id>/index.js (a loadable CommonJS bundle) and package.json with the manifest', async () => {
    project();
    const result = await buildProject({ dir, out, sdkAlias: SDK_SRC });
    expect(result).toMatchObject({ ok: true, files: ['foo/index.js', 'foo/package.json'] });
    const pkg = JSON.parse(readFileSync(path.join(out, 'foo/package.json'), 'utf8'));
    expect(pkg).toEqual({
      name: '@kvidai-plugin/foo',
      version: '1.2.3',
      kvidai: { id: 'foo', sdkVersion: `^${PLUGIN_API_VERSION}`, permissions: ['routes'] },
    });
    const mod: { exports: { default?: { id: string } } } = { exports: {} };
    new Function(
      'module',
      'exports',
      'require',
      readFileSync(path.join(out, 'foo/index.js'), 'utf8')
    )(mod, mod.exports, require);
    expect(mod.exports.default?.id).toBe('foo');
  });

  it('keeps the budget in the manifest', async () => {
    project({
      kvidai: {
        id: 'foo',
        sdkVersion: `^${PLUGIN_API_VERSION}`,
        permissions: ['credits.grant'],
        budget: { dailyCredits: 5 },
      },
    });
    await buildProject({ dir, out, sdkAlias: SDK_SRC });
    expect(
      JSON.parse(readFileSync(path.join(out, 'foo/package.json'), 'utf8')).kvidai.budget
    ).toEqual({ dailyCredits: 5 });
  });

  it('writes nothing and reports the problems when verification fails', async () => {
    project({ kvidai: { id: 'foo', sdkVersion: '^0.1.0', permissions: [] } });
    const result = await buildProject({ dir, out, sdkAlias: SDK_SRC });
    expect(result.ok).toBe(false);
    expect(() => readFileSync(path.join(out, 'foo/index.js'))).toThrow();
  });

  it('reports an import that cannot be resolved', async () => {
    project({ source: `import x from 'not-installed-anywhere';\nexport default x;\n` });
    const result = await buildProject({ dir, out, sdkAlias: SDK_SRC });
    expect(result).toMatchObject({ ok: false });
    expect((result as { errors: string[] }).errors.join('\n')).toMatch(/not-installed-anywhere/);
  });

  it('refuses SDK test helpers inside server code (they are not part of the runtime)', async () => {
    const helper = path.join(dir, 'fake-sdk/dist/testing.js');
    mkdirSync(path.dirname(helper), { recursive: true });
    writeFileSync(helper, 'exports.createMockCtx = () => ({});\n');
    project({
      source: `import { createMockCtx } from '${helper.replace(/\\/g, '/')}';\nexport default createMockCtx;\n`,
    });
    const result = await buildProject({ dir, out, sdkAlias: SDK_SRC });
    expect((result as { errors: string[] }).errors.join('\n')).toMatch(/test helper/);
  });

  it('replaces an earlier build of the same plugin and leaves other plugins alone', async () => {
    project();
    mkdirSync(path.join(out, 'other'), { recursive: true });
    writeFileSync(path.join(out, 'other/index.js'), 'x');
    writeFileSync(path.join(out, 'foo-stale.txt'), 'x');
    await buildProject({ dir, out, sdkAlias: SDK_SRC });
    await buildProject({ dir, out, sdkAlias: SDK_SRC });
    expect(readFileSync(path.join(out, 'other/index.js'), 'utf8')).toBe('x');
  });
});
