/** Current user with effective admin permissions (for navigation). */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  return {
    id: actor.id,
    username: actor.username,
    isAdmin: actor.isAdmin,
    adminPermissions: [...actor.adminPermissions],
  }
})
