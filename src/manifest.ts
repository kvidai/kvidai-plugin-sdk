/**
 * Checks of a plugin's package.json "kvidai" field, shared by `plugins:sync` (monorepo) and `kvidai-plugin verify|build` (external developers),
 * so the two cannot disagree about what a valid plugin is. Each problem is one readable line.
 */
import { PLUGIN_API_VERSION, satisfiesPluginApi } from './compat';
import { PLUGIN_EVENTS } from './index';

/** Every permission a manifest may declare. */
export const PLUGIN_PERMISSIONS: readonly string[] = [
  'credits.grant',
  'store',
  'routes',
  'db',
  ...PLUGIN_EVENTS.map((event) => `events:${event}`),
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** `expectedId` is the id the plugin is installed under (plugins.json id or the directory name). */
export function validateManifest(kvidai: unknown, expectedId: string): string[] {
  if (!isObject(kvidai)) return ['package.json has no "kvidai" field'];
  const problems: string[] = [];
  if (kvidai.id !== expectedId)
    problems.push(`manifest id "${String(kvidai.id)}" does not match "${expectedId}"`);
  if (!Array.isArray(kvidai.permissions)) {
    problems.push('manifest permissions must be an array');
  } else {
    for (const permission of kvidai.permissions)
      if (!PLUGIN_PERMISSIONS.includes(permission))
        problems.push(
          `unknown permission "${String(permission)}" (known: ${PLUGIN_PERMISSIONS.join(', ')})`
        );
  }
  if (kvidai.sdkVersion === undefined) {
    problems.push(
      `manifest sdkVersion is required (the plugin API range it was built for, e.g. "^${PLUGIN_API_VERSION}")`
    );
  } else if (typeof kvidai.sdkVersion !== 'string') {
    problems.push('manifest sdkVersion must be a string');
  } else {
    try {
      if (!satisfiesPluginApi(kvidai.sdkVersion))
        problems.push(
          `needs plugin API ${kvidai.sdkVersion}, this SDK provides ${PLUGIN_API_VERSION} (update the plugin and its sdkVersion, or install a core that provides it)`
        );
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (kvidai.budget !== undefined) {
    if (!isObject(kvidai.budget)) problems.push('manifest budget must be an object');
    else
      for (const key of ['dailyCredits', 'perGrantMax'])
        if (kvidai.budget[key] !== undefined && !positive(kvidai.budget[key]))
          problems.push(`manifest budget.${key} must be a positive number`);
  }
  return problems;
}
