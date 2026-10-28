import { eq } from 'drizzle-orm'
import { brandingSchema, DEFAULT_BRANDING, type Branding } from '#shared/branding'

const BRANDING_KEY = 'branding'

// Branding is read on every SSR render, so keep it in memory.
let cache: Branding | undefined

export async function getBranding(): Promise<Branding> {
  if (cache) return cache
  const row = await useDb().query.settings.findFirst({ where: eq(schema.settings.key, BRANDING_KEY) })
  const parsed = brandingSchema.safeParse(row?.value ?? {})
  cache = parsed.success ? parsed.data : DEFAULT_BRANDING
  return cache
}

export async function setBranding(value: Branding) {
  await useDb()
    .insert(schema.settings)
    .values({ key: BRANDING_KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
  cache = value
}
