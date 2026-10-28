export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.plugins.read')
  return listPlugins().map(({ manifest, status, error }) => ({ ...manifest, status, error }))
})
