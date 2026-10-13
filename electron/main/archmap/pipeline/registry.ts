import { PluginRegistry, TreeSitterPlugin, builtinLanguageConfigs, registerAllParsers } from '../core';
import { setArchmapGrammarsDir } from '../core/plugins/tree-sitter-plugin';

let cached: Promise<ArchmapRegistry> | null = null;

export interface ArchmapRegistry {
  registry: PluginRegistry;
  structuralLanguages: ReadonlySet<string>;
}

export function configureArchmapGrammarsDir(dir: string | null): void {
  setArchmapGrammarsDir(dir);
}

export function getArchmapRegistry(): Promise<ArchmapRegistry> {
  if (!cached) {
    cached = (async () => {
      const configs = builtinLanguageConfigs.filter((c) => c.treeSitter);
      const plugin = new TreeSitterPlugin(configs);
      await plugin.init();
      const registry = new PluginRegistry();
      registry.register(plugin);
      registerAllParsers(registry);
      return {
        registry,
        structuralLanguages: new Set(configs.map((c) => c.id)),
      };
    })();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}
