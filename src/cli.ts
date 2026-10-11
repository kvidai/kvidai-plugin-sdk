/**
 * `kvidai-plugin` command line. Today: `init`. dev / build / verify / link come with the plugin dev tools (plan Phase 4).
 */
import path from 'node:path';
import { initPlugin } from './init';

export type CliIo = {
  cwd: string;
  log: (message: string) => void;
  error: (message: string) => void;
};

const USAGE = `Usage:
  kvidai-plugin init <id> [--dir <path>] [--workspace]

  init   create a plugin project (default directory ./<id>); --workspace uses the monorepo's SDK`;

export function runCli(argv: string[], io: CliIo): number {
  const [command, ...rest] = argv;
  if (command !== 'init') {
    io.error(USAGE);
    return 1;
  }

  const flags = { dir: undefined as string | undefined, workspace: false };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir') flags.dir = rest[++i];
    else if (rest[i] === '--workspace') flags.workspace = true;
    else positional.push(rest[i]);
  }
  const [id] = positional;
  if (!id || (rest.includes('--dir') && !flags.dir)) {
    io.error(USAGE);
    return 1;
  }

  try {
    const dir = path.resolve(io.cwd, flags.dir ?? id);
    const files = initPlugin({ id, dir, workspace: flags.workspace });
    io.log(
      `Created plugin "${id}" in ${dir}\n${files.map((f) => `  ${f}`).join('\n')}\n\nNext: cd ${path.relative(io.cwd, dir) || '.'} && install dependencies && run the tests.`
    );
    return 0;
  } catch (error) {
    io.error((error as Error).message);
    return 1;
  }
}

/* c8 ignore next 4 -- thin process entry, covered through runCli */
if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    log: console.log,
    error: console.error,
  });
}
