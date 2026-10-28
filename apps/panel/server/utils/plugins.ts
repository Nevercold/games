import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Hookable } from 'hookable'
import type { PanelHooks } from './hooks'

/**
 * Plugin loader skeleton (PLAN.md "Plugin-System").
 * Phase 1: server-side plugins only. A plugin is a folder in the plugins dir
 * with a plugin.json manifest and an ESM entry exporting `setup(ctx)`.
 */

export const pluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  version: z.string(),
  panelVersion: z.string().default('*'),
  type: z.enum(['plugin', 'theme']).default('plugin'),
  server: z.string().optional(),
})

export type PluginManifest = z.infer<typeof pluginManifestSchema>

export interface PluginContext {
  manifest: PluginManifest
  hooks: Hookable<PanelHooks>
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export interface LoadedPlugin {
  manifest: PluginManifest
  dir: string
  status: 'active' | 'failed'
  error?: string
}

const loaded = new Map<string, LoadedPlugin>()

export function listPlugins(): LoadedPlugin[] {
  return [...loaded.values()]
}

export async function loadPlugins(dir: string, hooks: Hookable<PanelHooks>) {
  const root = resolve(process.cwd(), dir)
  if (!existsSync(root)) return

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pluginDir = join(root, entry.name)
    const manifestPath = join(pluginDir, 'plugin.json')
    if (!existsSync(manifestPath)) continue

    let manifest: PluginManifest
    try {
      manifest = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    } catch (err) {
      console.error(`[plugins] invalid manifest in ${pluginDir}:`, err)
      continue
    }

    if (loaded.has(manifest.id)) {
      console.warn(`[plugins] duplicate plugin id "${manifest.id}" in ${pluginDir}, skipped`)
      continue
    }

    const prefix = `[plugin:${manifest.id}]`
    const record: LoadedPlugin = { manifest, dir: pluginDir, status: 'active' }

    if (manifest.server) {
      const entryPath = resolve(pluginDir, manifest.server)
      if (!entryPath.startsWith(pluginDir + sep)) {
        record.status = 'failed'
        record.error = 'server entry must be inside the plugin directory'
      } else {
        try {
          const mod = await import(pathToFileURL(entryPath).href)
          const ctx: PluginContext = {
            manifest,
            hooks,
            log: {
              info: (...a) => console.info(prefix, ...a),
              warn: (...a) => console.warn(prefix, ...a),
              error: (...a) => console.error(prefix, ...a),
            },
          }
          await mod.setup?.(ctx)
        } catch (err) {
          record.status = 'failed'
          record.error = err instanceof Error ? err.message : String(err)
        }
      }
    }

    loaded.set(manifest.id, record)
    if (record.status === 'active') console.info(`${prefix} loaded v${manifest.version}`)
    else console.error(`${prefix} failed: ${record.error}`)
  }
}
