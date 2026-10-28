/** Blocks requests until startup tasks (migrations, plugin loading) are done. */
export default defineEventHandler(async () => {
  try {
    await whenReady()
  } catch (err) {
    console.error('[startup] failed:', err)
    throw createError({ statusCode: 503, statusMessage: 'panel failed to start, see server logs' })
  }
})
