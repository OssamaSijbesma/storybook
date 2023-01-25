import { stringifyStream } from '@discoveryjs/json-ext';
import { logger } from '@storybook/node-logger';
import type { Stats } from '@storybook/types';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';

interface WebpackModule {
  id: string;
  name: string;
  modules?: WebpackModule[];
  reasons?: { moduleId: string; moduleName: string }[];
}

interface WebpackStats {
  modules: WebpackModule[];
}

interface Module {
  type: 'stories' | 'source';
  reasons: Set<string>;
}

const URL_PARAM_REGEX = /(\?[a-z].*)/gi;
const ENTRY_MODULE_REGEXP = /\/storybook-stories\.js$/; // Only StoryStore v7+ is supported

const normalize = (id: string) => {
  // Ignore Webpack internals and external modules
  if (!id || id.startsWith('webpack/') || id.startsWith('external ')) return null;
  // Strip URL parameters (e.g. `?ngResource`) which may be appended to Webpack paths.
  return URL_PARAM_REGEX.test(id) ? id.replace(URL_PARAM_REGEX, '') : id;
};

export const webpackStatsToModulesJson = (stats: Stats): Map<string, Module> => {
  const { modules } = stats.toJson() as WebpackStats;

  const modulesById = new Map<string, WebpackModule>();
  const add = (module: WebpackModule) => {
    const id = normalize(module.id || module.name);
    if (id) modulesById.set(id, module);
    if (module.modules?.length) module.modules.forEach(add); // Traverse to unpack bundles
  };
  modules.forEach(add);

  const traced: Record<string, Omit<Module, 'type'> & { type?: 'entry' | 'glob' }> = {};
  const trace = (module: WebpackModule) => {
    const identifier = normalize(module.id || module.name);
    if (!identifier) return;

    const item = traced[identifier] || {
      type: ENTRY_MODULE_REGEXP.test(identifier) ? 'entry' : undefined,
      reasons: new Set(),
    };

    module.reasons?.forEach(({ moduleId, moduleName }) => {
      const reasonId = normalize(moduleId || moduleName);
      const reason = modulesById.get(reasonId);
      if (!reason) return;

      if (ENTRY_MODULE_REGEXP.test(reasonId)) {
        // CSF globs have the entry point as their "parent" reason
        item.type = 'glob';
      }

      if (reason.modules?.length) {
        // If reason is a bundle, unpack it
        reason.modules.forEach((mod) => {
          const id = normalize(mod.id || mod.name);
          // Ignore self-references where a module imports its own bundle
          if (id && id !== identifier) item.reasons.add(id);
        });
      } else {
        item.reasons.add(reasonId);
      }
    });

    traced[identifier] = item;
  };

  modules.forEach(trace);

  return new Map(
    // Omit entry file, CSF globs and unlinked files, and mark the rest as stories or source
    Object.entries(traced).reduce((acc, [id, { type, reasons }]) => {
      if (['entry', 'glob'].includes(type) || !reasons.size) return acc;
      const isStoriesFile = Array.from(reasons).some((r) => traced[r]?.type === 'glob');
      acc.push([id, { type: isStoriesFile ? 'stories' : 'source', reasons }]);
      return acc;
    }, [])
  );
};

const replacer = (key: any, value: any) => {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (value instanceof Set) return Array.from(value.values());
  return value;
};

export const writeModulesJson = async (directory: string, stats: Stats) => {
  const filePath = path.join(directory, 'modules.json');
  const modules = webpackStatsToModulesJson(stats);
  await new Promise((resolve, reject) => {
    stringifyStream({ v: 1, modules }, replacer, 2)
      .on('error', reject)
      .pipe(fs.createWriteStream(filePath))
      .on('error', reject)
      .on('finish', resolve);
  });
  logger.info(`=> module dependencies written to ${chalk.cyan(filePath)}`);
  return filePath;
};
