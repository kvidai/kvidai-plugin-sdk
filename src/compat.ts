/**
 * Which plugins a core can run. A plugin's package.json "kvidai.sdkVersion" says which plugin API it was built for (a range, like Discourse's
 * `required_version`); the core provides one version of that API. A plugin whose range the core does not satisfy is not loaded, only that
 * plugin: `plugins:sync` refuses to install it, and a core that meets it at boot skips it and goes on.
 *
 * Only four range forms are understood, on purpose, so that the SDK, plugins:sync and the Strapi host (which has its own copy of this file)
 * cannot disagree about a range they would each parse differently: "1.2.3", "^1.2.3", "~1.2.3" and ">=1.2.3".
 */

/**
 * The plugin API this SDK describes and the core implements. Bump it when the API changes in a way an existing plugin could break on:
 * the minor for 0.x, the major from 1.0. Its major.minor equals this package's version (a test checks).
 */
export const PLUGIN_API_VERSION = '0.2.0';

type Triple = [number, number, number];

function parse(version: string): Triple | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const compare = (a: Triple, b: Triple) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** True when `version` (default: this SDK's plugin API) satisfies `range`. Throws for a range it does not understand. */
export function satisfiesPluginApi(range: string, version: string = PLUGIN_API_VERSION): boolean {
  const have = parse(version);
  if (!have) throw new Error(`cannot read the plugin API version ${JSON.stringify(version)}`);
  const match = /^(\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(range);
  const base = match ? parse(match[2]) : null;
  if (!match || !base) {
    throw new Error(
      `unsupported sdkVersion range ${JSON.stringify(range)} (use "1.2.3", "^1.2.3", "~1.2.3" or ">=1.2.3")`
    );
  }
  const operator = match[1] ?? '';
  if (operator === '') return compare(have, base) === 0;
  if (compare(have, base) < 0) return false;
  if (operator === '>=') return true;
  if (operator === '~') return have[0] === base[0] && have[1] === base[1];
  // caret: the leftmost non-zero part must not change
  if (base[0] > 0) return have[0] === base[0];
  if (base[1] > 0) return have[0] === 0 && have[1] === base[1];
  return have[0] === 0 && have[1] === 0 && have[2] === base[2];
}
