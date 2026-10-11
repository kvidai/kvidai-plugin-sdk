/**
 * What `kvidai-plugin verify|build|dev|link` do, for a plugin project outside the monorepo: check the project, then bundle its server entry
 * into the directory format the prebuilt core image loads (KVIDAI_PLUGIN_DIR): `<out>/<id>/index.js` and `<out>/<id>/package.json`.
 * The monorepo's `pnpm plugins:build` does the same for plugins that live there; both use validateManifest.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, type BuildOptions } from 'esbuild';
import { validateManifest } from './manifest';
import { PLUGIN_ID_PATTERN } from './index';

type Project = { pkg: any; id: string; entry: string };

/** Reads and checks the project; either the project or every problem found. */
function readProject(dir: string): { project: Project } | { errors: string[] } {
  const pkgFile = path.join(dir, 'package.json');
  if (!existsSync(pkgFile)) return { errors: [`package.json not found in ${dir}`] };
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    return { errors: [`package.json is not valid JSON (${(error as Error).message})`] };
  }
  const id = pkg?.kvidai?.id;
  if (pkg?.kvidai === undefined || pkg?.kvidai === null || typeof pkg.kvidai !== 'object')
    return { errors: ['package.json has no "kvidai" field'] };
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id))
    return {
      errors: [
        'package.json "kvidai.id" must be lowercase letters, digits and dashes, starting with a letter',
      ],
    };

  const errors = validateManifest(pkg.kvidai, id);
  const serverExport = pkg.exports?.['./server'];
  const entry = typeof serverExport === 'string' ? path.join(dir, serverExport) : '';
  if (!entry)
    errors.push(
      'package.json must export "./server" (the server entry, e.g. ./server/src/index.ts)'
    );
  else if (!existsSync(entry)) errors.push(`server entry ${serverExport} not found`);
  return errors.length ? { errors } : { project: { pkg, id, entry } };
}

/** The problems of a plugin project, one line each; empty when it can be built. */
export function verifyProject(dir: string): string[] {
  const read = readProject(dir);
  return 'errors' in read ? read.errors : [];
}

export type BuildResult = { ok: true; files: string[] } | { ok: false; errors: string[] };

/** `sdkAlias` points the SDK import at a source file instead of node_modules (only the SDK's own tests need it). */
export type BuildProjectOptions = { dir: string; out: string; sdkAlias?: string };

function esbuildOptions({ dir, sdkAlias }: BuildProjectOptions, project: Project): BuildOptions {
  return {
    entryPoints: [project.entry],
    absWorkingDir: dir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    outfile: `${project.id}.js`,
    metafile: true,
    logLevel: 'silent',
    legalComments: 'none',
    ...(sdkAlias ? { alias: { '@kvidai/plugin-sdk': sdkAlias } } : {}),
    banner: {
      js: `/* Built by kvidai-plugin from ${project.pkg.name ?? project.id} -- do not edit by hand. */`,
    },
  };
}

// The test helpers are not part of the runtime the core provides; a plugin that bundles them would fail at boot, so say so here.
const TEST_HELPER =
  /plugin-sdk\/(dist\/)?(testing|contract|ui-testing)(\.|\/|$)|\/(testing|contract|ui-testing)\.(js|mjs|ts)$/;

export async function buildProject(options: BuildProjectOptions): Promise<BuildResult> {
  const read = readProject(options.dir);
  if ('errors' in read) return { ok: false, errors: read.errors };
  const { project } = read;

  let result;
  try {
    result = await build(esbuildOptions(options, project));
  } catch (error) {
    const messages = ((error as { errors?: Array<{ text: string }> }).errors ?? []).map(
      (e) => e.text
    );
    return {
      ok: false,
      errors: [
        `cannot bundle: ${(messages.length ? messages : [(error as Error).message]).join('; ')}`,
      ],
    };
  }
  const { metafile, outputFiles } = result;
  if (!metafile || !outputFiles?.length)
    return { ok: false, errors: ['the bundler returned no output'] };
  const helpers = Object.keys(metafile.inputs).filter((file) => TEST_HELPER.test(file));
  if (helpers.length)
    return {
      ok: false,
      errors: [
        `server code imports a test helper (${helpers.join(', ')}); the SDK testing helpers belong in *.test.ts files only`,
      ],
    };

  const target = path.join(options.out, project.id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'index.js'), outputFiles[0].text);
  writeFileSync(
    path.join(target, 'package.json'),
    `${JSON.stringify({ name: project.pkg.name, version: project.pkg.version, kvidai: project.pkg.kvidai }, null, 2)}\n`
  );
  return { ok: true, files: [`${project.id}/index.js`, `${project.id}/package.json`] };
}
