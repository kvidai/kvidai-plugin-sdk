/**
 * `kvidai-plugin init <id>`: scaffolds a plugin project from templates/plugin. Files in the template end in `.tmpl` so the SDK's own tooling
 * (vitest, tsc, prettier) leaves them alone, and so `.gitignore` survives npm packing; the suffix is dropped on copy.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PLUGIN_ID_PATTERN } from './index';

const TEMPLATE_DIR = path.resolve(__dirname, '../templates/plugin');

export type InitOptions = {
  id: string;
  /** Where to create the project. */
  dir: string;
  /** Inside the monorepo the SDK is a workspace package; elsewhere it is installed from the registry. */
  workspace?: boolean;
};

function sdkVersion(): string {
  return JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version;
}

function listTemplate(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listTemplate(dir, path.join(rel, entry.name))
      : [path.join(rel, entry.name)]
  );
}

/** Returns the created files, relative to `dir`. Nothing is written when the id or the directory is not acceptable. */
export function initPlugin({ id, dir, workspace = false }: InitOptions): string[] {
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid plugin id ${JSON.stringify(id)}: use lowercase letters, digits and dashes, starting with a letter`
    );
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`Directory ${dir} is not empty; choose another --dir or remove its files`);
  }

  const version = sdkVersion();
  const values: Record<string, string> = {
    id,
    sdkRange: `^${version}`,
    sdkDependency: workspace ? 'workspace:*' : `^${version}`,
  };

  const created: string[] = [];
  for (const relTemplate of listTemplate(TEMPLATE_DIR)) {
    const rel = relTemplate.replace(/\.tmpl$/, '');
    const target = path.join(dir, rel === 'gitignore' ? '.gitignore' : rel);
    mkdirSync(path.dirname(target), { recursive: true });
    const text = readFileSync(path.join(TEMPLATE_DIR, relTemplate), 'utf8').replace(
      /\{\{(\w+)\}\}/g,
      (_, key) => {
        if (!(key in values)) throw new Error(`Template placeholder {{${key}}} has no value`);
        return values[key];
      }
    );
    writeFileSync(target, text);
    created.push(path.relative(dir, target));
  }
  return created;
}
