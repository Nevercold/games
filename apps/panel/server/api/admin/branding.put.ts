import { brandingSchema } from '#shared/branding'

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.settings.write')
  const branding = await readValidatedBody(event, brandingSchema.parse)
  await setBranding(branding)
  return branding
})
