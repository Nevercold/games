import type { Template, TemplateVariable } from './template'

/**
 * Validates user input for template variables. All values are strings
 * because they end up as container environment variables.
 */
export interface VariableValidation {
  values: Record<string, string>
  errors: Record<string, string>
}

export function validateVariables(
  variables: TemplateVariable[],
  input: Record<string, string | undefined>,
  opts: { previous?: Record<string, string>; onlyUserEditable?: boolean } = {},
): VariableValidation {
  const values: Record<string, string> = {}
  const errors: Record<string, string> = {}

  for (const v of variables) {
    const prev = opts.previous?.[v.env]
    // Non-editable variables keep their previous value for regular users.
    if (opts.onlyUserEditable && !v.user_editable) {
      values[v.env] = prev ?? defaultValue(v)
      continue
    }
    const raw = (input[v.env] ?? prev ?? defaultValue(v)).trim()
    const err = checkValue(v, raw)
    if (err) errors[v.env] = err
    values[v.env] = v.type === 'secret' && !raw && v.generate ? randomSecret() : raw
  }
  return { values, errors }
}

export function defaultValue(v: TemplateVariable): string {
  switch (v.type) {
    case 'bool':
      return v.default ? '1' : '0'
    case 'int':
      return v.default === undefined ? '' : String(v.default)
    case 'enum':
      return v.default ?? v.options[0] ?? ''
    case 'string':
      return v.default
    default:
      return ''
  }
}

function checkValue(v: TemplateVariable, raw: string): string | undefined {
  switch (v.type) {
    case 'string':
      if (!raw) return v.required ? 'required' : undefined
      if (v.min !== undefined && raw.length < v.min) return `at least ${v.min} characters`
      if (v.max !== undefined && raw.length > v.max) return `at most ${v.max} characters`
      if (v.regex) {
        try {
          if (!new RegExp(v.regex).test(raw)) return 'invalid format'
        } catch {
          return undefined // template regex not valid in JS; do not block the user
        }
      }
      return undefined
    case 'int': {
      if (!raw) return v.required ? 'required' : undefined
      if (!/^-?\d+$/.test(raw)) return 'must be a whole number'
      const n = Number(raw)
      if (v.min !== undefined && n < v.min) return `minimum ${v.min}`
      if (v.max !== undefined && n > v.max) return `maximum ${v.max}`
      return undefined
    }
    case 'bool':
      return ['0', '1', 'true', 'false'].includes(raw) ? undefined : 'must be true or false'
    case 'enum':
      return v.options.includes(raw) ? undefined : `must be one of ${v.options.join(', ')}`
    case 'port': {
      if (!raw) return undefined
      const n = Number(raw)
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : 'must be a port (1-65535)'
    }
    case 'secret':
      return undefined
  }
}

function randomSecret(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Replaces {{VAR}} with env values; unknown placeholders become empty. */
export function renderPlaceholders(input: string, env: Record<string, string>): string {
  return input.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => env[name] ?? '')
}

/** Images of a template as select items, first one is the default. */
export function templateImages(t: Template): { label: string; value: string }[] {
  return Object.entries(t.images).map(([label, value]) => ({ label, value }))
}
