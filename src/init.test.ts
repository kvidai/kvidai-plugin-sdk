import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initPlugin } from './init';
import { runCli } from './cli';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'kvidai-plugin-init-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');

describe('initPlugin', () => {
  it('creates a standalone plugin project with the id filled in everywhere', () => {
    const files = initPlugin({ id: 'daily-bonus', dir: path.join(root, 'daily-bonus') });

    expect(files.sort()).toEqual(
      [
        '.gitignore',
        'README.md',
        'package.json',
        'server/src/index.test.ts',
        'server/src/index.ts',
        'types.ts',
        'tsconfig.json',
        'vitest.config.ts',
      ].sort()
    );
    const pkg = JSON.parse(read('daily-bonus', 'package.json'));
    expect(pkg.name).toBe('@kvidai-plugin/daily-bonus');
    expect(pkg.kvidai.id).toBe('daily-bonus');
    expect(pkg.kvidai.permissions).toEqual(['credits.grant', 'routes']);
    expect(pkg.exports['./server']).toBe('./server/src/index.ts');
    expect(pkg.exports['./types']).toBe('./types.ts');
    expect(pkg.devDependencies['@kvidai/plugin-sdk']).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(read('daily-bonus', 'server/src/index.ts')).toContain("id: 'daily-bonus'");
  });

  it('leaves no unreplaced {{placeholders}} in any file', () => {
    initPlugin({ id: 'daily-bonus', dir: path.join(root, 'p') });
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
      );
    for (const file of walk(path.join(root, 'p'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it("pins its own vitest config, so a parent directory's config (the monorepo root has one) is never picked up", () => {
    initPlugin({ id: 'x', dir: path.join(root, 'x') });
    expect(read('x', 'vitest.config.ts')).toContain("include: ['server/**/*.test.ts'");
  });

  it('declares every type package its tsconfig lists, so `npm run typecheck` works outside the monorepo (which hoists @types/node from its root)', () => {
    initPlugin({ id: 'daily-bonus', dir: path.join(root, 'daily-bonus') });
    const tsconfig = JSON.parse(read('daily-bonus', 'tsconfig.json'));
    const pkg = JSON.parse(read('daily-bonus', 'package.json'));
    for (const name of tsconfig.compilerOptions.types as string[]) {
      expect(pkg.devDependencies).toHaveProperty(`@types/${name}`);
    }
  });

  it('writes a dotfile .gitignore (npm would drop a file with that name from the package)', () => {
    initPlugin({ id: 'x', dir: path.join(root, 'x') });
    expect(existsSync(path.join(root, 'x', '.gitignore'))).toBe(true);
    expect(existsSync(path.join(root, 'x', 'gitignore.tmpl'))).toBe(false);
  });

  it('uses workspace:* for the SDK inside the monorepo', () => {
    initPlugin({ id: 'x', dir: path.join(root, 'x'), workspace: true });
    expect(JSON.parse(read('x', 'package.json')).devDependencies['@kvidai/plugin-sdk']).toBe(
      'workspace:*'
    );
  });

  it.each(['Daily', 'a_b', '1abc', '', 'a-'])('rejects the invalid id %j', (id) => {
    expect(() => initPlugin({ id, dir: path.join(root, 'bad') })).toThrow(/plugin id/);
    expect(existsSync(path.join(root, 'bad'))).toBe(false);
  });

  it('refuses a directory that already has files, and does not touch them', () => {
    const dir = path.join(root, 'taken');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'keep.txt'), 'mine');
    expect(() => initPlugin({ id: 'x', dir })).toThrow(/not empty/);
    expect(readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });

  it('accepts an existing empty directory', () => {
    const dir = path.join(root, 'empty');
    mkdirSync(dir);
    expect(initPlugin({ id: 'x', dir }).length).toBeGreaterThan(0);
  });
});

describe('runCli', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { cwd: root, log: (m: string) => out.push(m), error: (m: string) => err.push(m) },
    };
  };

  it('init <id> creates ./<id> under the working directory', () => {
    const { io: i, out } = io();
    expect(runCli(['init', 'daily-bonus'], i)).toBe(0);
    expect(existsSync(path.join(root, 'daily-bonus', 'package.json'))).toBe(true);
    expect(out.join('\n')).toMatch(/daily-bonus/);
  });

  it('init <id> --dir <path> --workspace', () => {
    const { io: i } = io();
    expect(runCli(['init', 'x', '--dir', 'plugins/x', '--workspace'], i)).toBe(0);
    expect(
      JSON.parse(read('plugins', 'x', 'package.json')).devDependencies['@kvidai/plugin-sdk']
    ).toBe('workspace:*');
  });

  it('prints usage and exits 1 without a command, with an unknown command, or without an id', () => {
    for (const argv of [[], ['wat'], ['init']]) {
      const { io: i, err } = io();
      expect(runCli(argv, i)).toBe(1);
      expect(err.join('\n')).toMatch(/Usage/);
    }
  });

  it('reports a failure (bad id) on stderr and exits 1 instead of throwing', () => {
    const { io: i, err } = io();
    expect(runCli(['init', 'Bad_Id'], i)).toBe(1);
    expect(err.join('\n')).toMatch(/plugin id/);
  });
});
