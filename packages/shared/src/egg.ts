import { templateSchema, type Template, type TemplateInput } from './template'

/**
 * Converts Pelican (PLCN_v1..v3) and Pterodactyl (PTDL_v1/v2) eggs into the
 * template format. The runtime contract (env vars, {{VAR}} startup
 * placeholders, /home/container) is identical, so converted templates run
 * unchanged. Everything that cannot be mapped is reported as a warning.
 */

export interface EggConversion {
  template: Template
  warnings: string[]
}

type Json = Record<string, any>

export function convertEgg(input: unknown): EggConversion {
  if (!input || typeof input !== 'object') throw new Error('egg must be a JSON object')
  const egg = input as Json
  if (typeof egg.name !== 'string' || !egg.name.trim()) throw new Error('egg has no name')

  const warnings: string[] = []
  const version = String(egg.meta?.version ?? '')
  if (version && !/^(PTDL|PLCN)_v\d+$/.test(version)) {
    warnings.push(`unknown egg format "${version}", converting best-effort`)
  }

  const config = parseMaybeJson(egg.config ?? {}, 'config', warnings) as Json
  const startupCfg = parseMaybeJson(config.startup ?? {}, 'config.startup', warnings) as Json
  const filesCfg = parseMaybeJson(config.files ?? {}, 'config.files', warnings) as Json

  const template: TemplateInput = {
    schema: 1,
    id: slugify(egg.name),
    name: egg.name.trim(),
    version: '1.0.0',
    author: typeof egg.author === 'string' ? egg.author : undefined,
    description: typeof egg.description === 'string' ? egg.description : undefined,
    tags: Array.isArray(egg.tags) ? egg.tags.map((t: unknown) => slugify(String(t))).filter(Boolean) : [],
    source: { kind: 'egg', ref: typeof egg.uuid === 'string' ? egg.uuid : version || undefined },
    images: convertImages(egg.docker_images ?? egg.images, warnings),
    startup: {
      command: pickStartup(egg, warnings),
      done: toStringArray(startupCfg.done),
      stop: convertStop(config.stop),
      user_interaction: toStringArray(startupCfg.userInteraction),
    },
    variables: (Array.isArray(egg.variables) ? egg.variables : []).flatMap((v: Json) => {
      try {
        return [convertVariable(v, warnings)]
      } catch (err) {
        warnings.push(`variable ${v?.env_variable ?? '?'} skipped: ${(err as Error).message}`)
        return []
      }
    }),
    config_files: convertConfigFiles(filesCfg, warnings),
    hooks: convertInstall(egg.scripts?.installation),
    features: Array.isArray(egg.features) ? egg.features.map(String) : [],
  }

  const parsed = templateSchema.safeParse(template)
  if (!parsed.success) {
    throw new Error(`converted template is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  return { template: parsed.data, warnings }
}

// ---------------------------------------------------------------------------

function parseMaybeJson(value: unknown, field: string, warnings: string[]): unknown {
  if (typeof value !== 'string') return value
  if (!value.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    warnings.push(`${field} is not valid JSON, ignored`)
    return {}
  }
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'template'
}

function toStringArray(v: unknown): string[] {
  if (v == null || v === '') return []
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean)
}

function convertImages(images: unknown, warnings: string[]): Record<string, string> {
  if (Array.isArray(images)) {
    return Object.fromEntries(images.map((img) => [String(img), String(img)]))
  }
  if (images && typeof images === 'object') {
    return Object.fromEntries(Object.entries(images).map(([label, img]) => [label, String(img)]))
  }
  warnings.push('egg has no docker images')
  return {}
}

function pickStartup(egg: Json, warnings: string[]): string {
  if (typeof egg.startup === 'string' && egg.startup.trim()) return egg.startup
  // PLCN_v3 allows several named startup commands; use the first one.
  if (egg.startup_commands && typeof egg.startup_commands === 'object') {
    const entries = Object.entries(egg.startup_commands)
    if (entries.length > 1) warnings.push(`egg has ${entries.length} startup commands, using "${entries[0]![0]}"`)
    if (entries[0]) return String(entries[0][1])
  }
  warnings.push('egg has no startup command')
  return 'echo "no startup command configured"'
}

/** "^C" means SIGINT in eggs; anything else is a console command. */
function convertStop(stop: unknown): string | { signal: string } {
  const s = typeof stop === 'string' ? stop.trim() : ''
  if (!s) return { signal: 'SIGTERM' }
  if (s === '^C' || s === '^^C') return { signal: 'SIGINT' }
  if (s === '^X') return { signal: 'SIGTERM' }
  return s
}

function convertInstall(inst: unknown) {
  if (!inst || typeof inst !== 'object') return {}
  const i = inst as Json
  if (typeof i.script !== 'string' || !i.script.trim()) return {}
  return {
    install: {
      image: typeof i.container === 'string' && i.container ? i.container : 'ghcr.io/pelican-eggs/installers:debian',
      entrypoint: typeof i.entrypoint === 'string' && i.entrypoint ? i.entrypoint : 'bash',
      script: i.script.replace(/\r\n/g, '\n'),
    },
  }
}

// ---------------------------------------------------------------------------
// Variables: Laravel validation rules → typed variables
// ---------------------------------------------------------------------------

interface ParsedRules {
  required: boolean
  type: 'string' | 'int' | 'bool' | 'enum'
  options?: string[]
  min?: number
  max?: number
  regex?: string
  unknown: string[]
}

/** Parses "required|string|max:20" or ["required", "string"] style rules. */
export function parseLaravelRules(rules: unknown): ParsedRules {
  let tokens: string[]
  if (Array.isArray(rules)) {
    tokens = rules.map(String)
  } else {
    const s = String(rules ?? '')
    // regex may contain "|", so everything after "regex:" belongs to it.
    const idx = s.indexOf('regex:')
    tokens = (idx >= 0 ? s.slice(0, idx) : s).split('|')
    if (idx >= 0) tokens.push(s.slice(idx))
  }
  tokens = tokens.map((t) => t.trim()).filter(Boolean)

  const out: ParsedRules = { required: false, type: 'string', unknown: [] }
  for (const t of tokens) {
    const [name, ...rest] = t.split(':')
    const arg = rest.join(':')
    switch (name) {
      case 'required':
        out.required = true
        break
      case 'nullable':
      case 'sometimes':
      case 'present':
        break
      case 'string':
      case 'alpha_dash':
      case 'alpha_num':
        break
      case 'integer':
      case 'numeric':
      case 'int':
        if (out.type === 'string') out.type = 'int'
        break
      case 'boolean':
      case 'bool':
        out.type = 'bool'
        break
      case 'in':
        out.type = 'enum'
        out.options = arg.split(',').map((o) => o.trim()).filter((o) => o.length > 0)
        break
      case 'min':
        out.min = Number(arg)
        break
      case 'max':
        out.max = Number(arg)
        break
      case 'between': {
        const [a, b] = arg.split(',')
        out.min = Number(a)
        out.max = Number(b)
        break
      }
      case 'size':
        out.min = out.max = Number(arg)
        break
      case 'regex':
        out.regex = phpRegexToPattern(arg)
        break
      default:
        out.unknown.push(t)
    }
  }
  if (out.min !== undefined && !Number.isFinite(out.min)) delete out.min
  if (out.max !== undefined && !Number.isFinite(out.max)) delete out.max
  return out
}

/** "/^[a-z]+$/i" → "^[a-z]+$" (flags other than none are dropped). */
function phpRegexToPattern(r: string): string {
  const m = /^(.)(.*)\1([a-zA-Z]*)$/s.exec(r.trim())
  return m ? m[2]! : r
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

function convertVariable(v: Json, warnings: string[]) {
  const env = String(v.env_variable ?? '').trim()
  if (!env) throw new Error('missing env_variable')
  const rules = parseLaravelRules(v.rules)
  if (rules.unknown.length) warnings.push(`variable ${env}: rules not converted: ${rules.unknown.join(', ')}`)

  const base = {
    env,
    name: String(v.name ?? env),
    description: typeof v.description === 'string' && v.description ? v.description : undefined,
    user_viewable: truthy(v.user_viewable),
    user_editable: truthy(v.user_editable),
  }
  const def = v.default_value == null ? '' : String(v.default_value)

  switch (rules.type) {
    case 'bool':
      return { ...base, type: 'bool' as const, default: truthy(def) }
    case 'enum': {
      const options = rules.options?.length ? rules.options : [def].filter(Boolean)
      if (!options.length) throw new Error('enum without options')
      return { ...base, type: 'enum' as const, options, default: options.includes(def) ? def : options[0] }
    }
    case 'int': {
      const n = Number(def)
      if (def !== '' && !Number.isInteger(n)) {
        warnings.push(`variable ${env}: default "${def}" is not an integer, treated as string`)
        return { ...base, type: 'string' as const, default: def, required: rules.required }
      }
      return {
        ...base,
        type: 'int' as const,
        default: def === '' ? undefined : n,
        min: rules.min,
        max: rules.max,
        required: rules.required,
      }
    }
    default:
      return {
        ...base,
        type: 'string' as const,
        default: def,
        min: rules.min !== undefined && rules.min >= 0 ? Math.floor(rules.min) : undefined,
        max: rules.max !== undefined && rules.max > 0 ? Math.floor(rules.max) : undefined,
        regex: rules.regex,
        required: rules.required,
      }
  }
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

const PARSER_MAP: Record<string, 'properties' | 'yaml' | 'json' | 'ini' | 'xml' | 'text'> = {
  properties: 'properties',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  ini: 'ini',
  xml: 'xml',
  file: 'text',
}

/** Egg placeholders → template placeholders ({{ENV_NAME}}). */
export function convertEggPlaceholders(value: string): string {
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr: string) => {
    const e = expr.trim()
    const env = /^(?:server\.build\.env|server\.environment|env)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(e)
    if (env) return `{{${env[1]}}}`
    switch (e) {
      case 'server.build.default.port':
      case 'server.allocations.default.port':
        return '{{SERVER_PORT}}'
      case 'server.build.default.ip':
      case 'server.allocations.default.ip':
        return '{{SERVER_IP}}'
      case 'server.build.memory':
      case 'server.limits.memory':
        return '{{SERVER_MEMORY}}'
      case 'server.uuid':
        return '{{P_SERVER_UUID}}'
      default:
        return match
    }
  })
}

function convertConfigFiles(files: Json, warnings: string[]) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return []
  const out: { path: string; parser: 'properties' | 'yaml' | 'json' | 'ini' | 'xml' | 'text'; set: Record<string, string> }[] = []
  for (const [path, def] of Object.entries(files)) {
    const parser = PARSER_MAP[String((def as Json)?.parser ?? '')]
    if (!parser) {
      warnings.push(`config file ${path}: unknown parser "${(def as Json)?.parser}", skipped`)
      continue
    }
    const set: Record<string, string> = {}
    for (const [key, value] of Object.entries((def as Json).find ?? {})) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        warnings.push(`config file ${path}: key "${key}" uses an advanced replacement, skipped`)
        continue
      }
      if (/[[*]/.test(key)) warnings.push(`config file ${path}: key "${key}" uses array/wildcard syntax, may not apply`)
      const converted = convertEggPlaceholders(String(value))
      if (/\{\{(?![A-Za-z_][A-Za-z0-9_]*\}\})/.test(converted)) {
        warnings.push(`config file ${path}: placeholder in "${key}" not supported: ${value}`)
      }
      set[key] = converted
    }
    if (parser === 'ini' || parser === 'xml') {
      warnings.push(`config file ${path}: parser "${parser}" is not supported by the daemon yet`)
    }
    out.push({ path, parser, set })
  }
  return out
}
