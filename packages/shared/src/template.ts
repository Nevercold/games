import { z } from 'zod'

/**
 * Server template format v1 (replaces Pelican eggs).
 * See PLAN.md "Server-Templates".
 */

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase, digits and dashes only')
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'valid env var name')

export const templateVariableSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'),
    env: envName,
    name: z.string(),
    description: z.string().optional(),
    default: z.string().default(''),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
    regex: z.string().optional(),
    required: z.boolean().default(true),
    user_viewable: z.boolean().default(true),
    user_editable: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('int'),
    env: envName,
    name: z.string(),
    description: z.string().optional(),
    default: z.number().int().optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    required: z.boolean().default(true),
    user_viewable: z.boolean().default(true),
    user_editable: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('bool'),
    env: envName,
    name: z.string(),
    description: z.string().optional(),
    default: z.boolean().default(false),
    user_viewable: z.boolean().default(true),
    user_editable: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('enum'),
    env: envName,
    name: z.string(),
    description: z.string().optional(),
    options: z.array(z.string()).min(1),
    default: z.string().optional(),
    user_viewable: z.boolean().default(true),
    user_editable: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('port'),
    env: envName,
    name: z.string(),
    description: z.string().optional(),
    user_viewable: z.boolean().default(true),
    user_editable: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('secret'),
    env: envName,
    name: z.string(),
    description: z.string().optional(),
    generate: z.boolean().default(true),
    user_viewable: z.boolean().default(false),
    user_editable: z.boolean().default(false),
  }),
])

export const configFileParser = z.enum(['properties', 'yaml', 'json', 'ini', 'xml', 'text'])

export const templateConfigFileSchema = z.object({
  path: z.string(),
  parser: configFileParser,
  /** key → value with {{VAR}} placeholders; for `text` parser key is a regex to replace */
  set: z.record(z.string(), z.string()),
})

export const templateHookSchema = z.object({
  image: z.string().optional(),
  entrypoint: z.string().default('bash'),
  script: z.string(),
})

export const templateSchema = z.object({
  schema: z.literal(1),
  id: identifier,
  name: z.string(),
  version: z.string().default('1.0.0'),
  author: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  tags: z.array(identifier).default([]),
  extends: identifier.optional(),
  source: z
    .object({
      kind: z.enum(['egg', 'manual', 'registry']),
      ref: z.string().optional(),
    })
    .optional(),

  images: z.record(z.string(), z.string()).default({}),

  startup: z
    .object({
      command: z.string(),
      done: z.array(z.string()).default([]),
      stop: z.union([z.string(), z.object({ signal: z.string() })]).default('stop'),
      user_interaction: z.array(z.string()).default([]),
    })
    .optional(),

  variables: z.array(templateVariableSchema).default([]),
  config_files: z.array(templateConfigFileSchema).default([]),

  hooks: z
    .object({
      install: templateHookSchema.optional(),
      pre_start: templateHookSchema.optional(),
      post_stop: templateHookSchema.optional(),
      update: templateHookSchema.optional(),
    })
    .default({}),

  resources: z
    .object({
      memory_mb: z.number().int().positive().optional(),
      disk_mb: z.number().int().positive().optional(),
      cpu_percent: z.number().int().positive().optional(),
    })
    .default({}),

  features: z.array(z.string()).default([]),
})

export type Template = z.infer<typeof templateSchema>
export type TemplateInput = z.input<typeof templateSchema>
export type TemplateVariable = z.infer<typeof templateVariableSchema>
