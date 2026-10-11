import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION } from './compat';
import { runCli } from './cli';

let root: string;
let proj: string;

const SOURCE = (version: string) =>
  `export default { id: 'foo', version: '${version}', bootstrap() {} };\n`;

function makeProject(
  kvidai: unknown = { id: 'foo', sdkVersion: `^${PLUGIN_API_VERSION}`, permissions: ['routes'] }
) {
  proj = path.join(root, 'foo');
  mkdirSync(path.join(proj, 'server/src'), { recursive: true });
  writeFileSync(
    path.join(proj, 'package.json'),
    JSON.stringify({
      name: '@kvidai-plugin/foo',
      version: '1.0.0',
      exports: { './server': './server/src/index.ts' },
      kvidai,
    })
  );
  writeFileSync(path.join(proj, 'server/src/index.ts'), SOURCE('1.0.0'));
}

const harness = (extra: object = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { cwd: root, log: (m: string) => out.push(m), error: (m: string) => err.push(m), ...extra },
  };
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'kvidai-sdk-cli-'));
  makeProject();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('kvidai-plugin verify', () => {
  it('prints OK and exits 0 for a good project (default directory is the working directory)', async () => {
    const { io, out } = harness({ cwd: proj });
    expect(await runCli(['verify'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/OK/);
  });

  it('lists every problem on stderr and exits 1', async () => {
    makeProject({ id: 'foo', sdkVersion: '^0.1.0', permissions: ['root'] });
    const { io, err } = harness();
    expect(await runCli(['verify', '--dir', 'foo'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/unknown permission "root"/);
    expect(err.join('\n')).toMatch(/needs plugin API/);
  });
});

describe('kvidai-plugin build', () => {
  it('writes <dir>/dist-plugin/<id> by default and says how to use it', async () => {
    const { io, out } = harness();
    expect(await runCli(['build', '--dir', 'foo'], io)).toBe(0);
    expect(existsSync(path.join(proj, 'dist-plugin/foo/index.js'))).toBe(true);
    expect(out.join('\n')).toMatch(/KVIDAI_PLUGIN_DIR/);
  });

  it('--out writes somewhere else', async () => {
    const { io } = harness();
    expect(await runCli(['build', '--dir', 'foo', '--out', 'elsewhere'], io)).toBe(0);
    expect(existsSync(path.join(root, 'elsewhere/foo/index.js'))).toBe(true);
  });

  it('exits 1 with the problems and writes nothing for an invalid project', async () => {
    makeProject({ id: 'foo', permissions: [] });
    const { io, err } = harness();
    expect(await runCli(['build', '--dir', 'foo'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/sdkVersion is required/);
    expect(existsSync(path.join(proj, 'dist-plugin'))).toBe(false);
  });
});

describe('kvidai-plugin link', () => {
  it('builds into the plugin directory the core mounts and reminds that the core must be restarted', async () => {
    const { io, out } = harness();
    expect(await runCli(['link', '--dir', 'foo', '--to', 'core-plugins'], io)).toBe(0);
    expect(existsSync(path.join(root, 'core-plugins/foo/index.js'))).toBe(true);
    expect(out.join('\n')).toMatch(/restart/i);
  });

  it('needs --to', async () => {
    const { io, err } = harness();
    expect(await runCli(['link', '--dir', 'foo'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/--to/);
  });
});

describe('kvidai-plugin dev', () => {
  it('builds once, rebuilds when a source file changes, and stops on abort', async () => {
    const controller = new AbortController();
    const { io, out } = harness({ signal: controller.signal });
    const running = runCli(['dev', '--dir', 'foo', '--out', 'live'], io);

    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(predicate()).toBe(true);
    };
    const builtVersion = () => {
      try {
        return /version: ["']([\d.]+)["']/.exec(
          readFileSync(path.join(root, 'live/foo/index.js'), 'utf8')
        )?.[1];
      } catch {
        return undefined;
      }
    };
    await waitFor(() => builtVersion() === '1.0.0');
    writeFileSync(path.join(proj, 'server/src/index.ts'), SOURCE('2.0.0'));
    await waitFor(() => builtVersion() === '2.0.0');
    expect(out.filter((m) => /built/i.test(m)).length).toBeGreaterThanOrEqual(2);

    controller.abort();
    expect(await running).toBe(0);
  });

  it('keeps watching after a broken edit and recovers when it is fixed', async () => {
    const controller = new AbortController();
    const { io, err } = harness({ signal: controller.signal });
    const running = runCli(['dev', '--dir', 'foo', '--out', 'live'], io);
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(predicate()).toBe(true);
    };
    await waitFor(() => existsSync(path.join(root, 'live/foo/index.js')));
    writeFileSync(
      path.join(proj, 'server/src/index.ts'),
      `import x from 'nowhere-at-all';\nexport default x;\n`
    );
    await waitFor(() => err.some((m) => /nowhere-at-all/.test(m)));
    writeFileSync(path.join(proj, 'server/src/index.ts'), SOURCE('3.0.0'));
    await waitFor(() =>
      /version: ["']3\.0\.0["']/.test(readFileSync(path.join(root, 'live/foo/index.js'), 'utf8'))
    );
    controller.abort();
    expect(await running).toBe(0);
  });
});

describe('kvidai-plugin usage', () => {
  it.each([[[]], [['wat']]])('prints usage for %j and exits 1', async (argv) => {
    const { io, err } = harness();
    expect(await runCli(argv as string[], io)).toBe(1);
    expect(err.join('\n')).toMatch(/Usage[\s\S]*verify[\s\S]*build[\s\S]*dev[\s\S]*link/);
  });
});
