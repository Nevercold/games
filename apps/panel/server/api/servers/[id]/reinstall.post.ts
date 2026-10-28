import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { server } = await requireServerPermission(event, id, 'settings.reinstall')
  if (!['offline', 'install_failed'].includes(server.status)) {
    throw createError({ statusCode: 409, statusMessage: 'stop the server before reinstalling' })
  }
  await startInstall(id)
  return { ok: true }
})
