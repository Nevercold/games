import { z } from 'zod'

/** Tailwind palettes Nuxt UI can map to --ui-primary / --ui-neutral. */
export const PRIMARY_COLORS = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
] as const

export const NEUTRAL_COLORS = ['slate', 'gray', 'zinc', 'neutral', 'stone'] as const

export const brandingSchema = z.object({
  appName: z.string().trim().min(1).max(40).default('Panel'),
  primary: z.enum(PRIMARY_COLORS).default('emerald'),
  neutral: z.enum(NEUTRAL_COLORS).default('zinc'),
  /** Base radius in rem, mapped to --ui-radius. */
  radius: z.number().min(0).max(1).default(0.375),
  /** Optional logo URL (https or data:image). */
  logoUrl: z
    .string()
    .trim()
    .max(200_000)
    .refine((v) => v === '' || /^https:\/\//.test(v) || /^data:image\/(png|svg\+xml|webp|jpeg);base64,/.test(v), {
      message: 'logo must be an https URL or a data:image URI',
    })
    .default(''),
})

export type Branding = z.infer<typeof brandingSchema>

export const DEFAULT_BRANDING: Branding = brandingSchema.parse({})
