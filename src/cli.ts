/**
 * `kvidai-plugin` command line: init, verify, build, dev and link (what each does is in USAGE).
 */
import { watch } from 'node:fs';
import path from 'node:path';
import { buildProject, verifyProject } from './build';
import { initPlugin } from './init';

export type CliIo = {
  cwd: string;
  log: (message: string) => void;
  error: (message: string) => void;
  /** `dev` runs until this aborts (the process entry aborts it on Ctrl-C). */
  signal?: AbortSignal;
};

const USAGE = `Usage:
  kvidai-plugin init <id> [--dir <path>] [--workspace]
  kvidai-plugin verify [--dir <path>]
  kvidai-plugin build [--dir <path>] [--out <path>]
  kvidai-plugin dev [--dir <path>] [--out <path>]
  kvidai-plugin link --to <path> [--dir <path>]

  init    create a plugin project (default directory ./<id>); --workspace uses the monorepo's SDK
  verify  check package.json (the "kvidai" manifest, sdkVersion, the ./server export) without building
  build   verify, then bundle into <out>/<id> (default ./dist-plugin), the format a core loads from KVIDAI_PLUGIN_DIR
  dev     build, then rebuild whenever a file changes (restart the core to load a new build)
  link    build into the plugin directory your core mounts (--to), e.g. the ./plugins of the core image's compose file`;

const VALUE_FLAGS = ['--dir', '--out', '--to'];

function parse(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) flags[args[i]] = args[++i] ?? '';
    else if (args[i] === '--workspace') flags['--workspace'] = true;
    else positional.push(args[i]);
  }
  return { flags, positional };
}

async function buildOnce(dir: string, out: string, io: CliIo): Promise<boolean> {
  const result = await buildProject({ dir, out });
  if (!result.ok) {
    io.error(result.errors.map((e) => `  ${e}`).join('\n'));
    return false;
  }
  io.log(`Built ${result.files.map((f) => path.join(out, f)).join(', ')}`);
  return true;
}

const hint = (out: string) =>
  `Run a core with KVIDAI_PLUGIN_DIR pointing at ${out} (the core image mounts ./plugins there); restart the core to load a new build.`;

/** Rebuilds when package.json or anything under the project (except build output and node_modules) changes. */
async function dev(dir: string, out: string, io: CliIo): Promise<number> {
  await buildOnce(dir, out, io);
  io.log(`Watching ${dir} (Ctrl-C to stop). ${hint(out)}`);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;
  const rebuild = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    do {
      again = false;
      await buildOnce(dir, out, io);
    } while (again);
    running = false;
  };
  const ignored = (file: string) =>
    /(^|[\\/])(node_modules|dist-plugin|\.git)([\\/]|$)/.test(file) ||
    path.resolve(dir, file).startsWith(out);
  const watcher = watch(dir, { recursive: true }, (_event, file) => {
    if (!file || ignored(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 100);
  });
  await new Promise<void>((resolve) => {
    if (!io.signal) return;
    if (io.signal.aborted) resolve();
    else io.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  clearTimeout(timer);
  watcher.close();
  return 0;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const { flags, positional } = parse(rest);
  const dir = path.resolve(
    io.cwd,
    typeof flags['--dir'] === 'string' && flags['--dir']
      ? flags['--dir']
      : command === 'init'
        ? (positional[0] ?? '')
        : '.'
  );

  if (command === 'init') {
    const [id] = positional;
    if (!id || (rest.includes('--dir') && !flags['--dir'])) {
      io.error(USAGE);
      return 1;
    }
    try {
      const target = path.resolve(
        io.cwd,
        typeof flags['--dir'] === 'string' && flags['--dir'] ? flags['--dir'] : id
      );
      const files = initPlugin({ id, dir: target, workspace: flags['--workspace'] === true });
      io.log(
        `Created plugin "${id}" in ${target}\n${files.map((f) => `  ${f}`).join('\n')}\n\nNext: cd ${path.relative(io.cwd, target) || '.'} && install dependencies && run the tests.`
      );
      return 0;
    } catch (error) {
      io.error((error as Error).message);
      return 1;
    }
  }

  if (command === 'verify') {
    const problems = verifyProject(dir);
    if (problems.length) {
      io.error(problems.map((p) => `  ${p}`).join('\n'));
      return 1;
    }
    io.log(`OK: ${dir} can be built`);
    return 0;
  }

  if (command === 'build' || command === 'dev' || command === 'link') {
    const outFlag = command === 'link' ? flags['--to'] : flags['--out'];
    if (command === 'link' && !outFlag) {
      io.error(`link needs --to <path>, the plugin directory your core mounts\n\n${USAGE}`);
      return 1;
    }
    const out = path.resolve(
      io.cwd,
      typeof outFlag === 'string' && outFlag ? outFlag : path.join(dir, 'dist-plugin')
    );
    if (command === 'dev') return dev(dir, out, io);
    if (!(await buildOnce(dir, out, io))) return 1;
    io.log(hint(out));
    return 0;
  }

  io.error(USAGE);
  return 1;
}

/* c8 ignore next 4 -- thin process entry, covered through runCli */
if (require.main === module) {
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  void runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    log: console.log,
    error: console.error,
    signal: controller.signal,
  }).then((code) => {
    process.exitCode = code;
  });
}
