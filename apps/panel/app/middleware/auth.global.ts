import type { AdminPermission } from '#shared/permissions'

const PUBLIC_ROUTES = new Set(['/login', '/setup'])

/** Admin area sections and the permission needed to open them. */
const ADMIN_ROUTES: [prefix: string, perm: AdminPermission][] = [
  ['/admin/nodes', 'admin.nodes.read'],
  ['/admin/servers', 'admin.servers.read'],
  ['/admin/templates', 'admin.templates.read'],
  ['/admin/users', 'admin.users.read'],
  ['/admin/roles', 'admin.users.read'],
  ['/admin/plugins', 'admin.plugins.read'],
  ['/admin/branding', 'admin.settings.write'],
]

export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn } = useUserSession()

  // First run: no users yet → setup wizard. Checked once per app load.
  const needsSetup = useState<boolean | null>('needs-setup', () => null)
  if (needsSetup.value === null || (needsSetup.value && to.path !== '/setup')) {
    const res = await useRequestFetch()('/api/setup').catch(() => ({ needsSetup: false }))
    needsSetup.value = res.needsSetup
  }
  if (needsSetup.value) {
    return to.path === '/setup' ? undefined : navigateTo('/setup')
  }
  if (to.path === '/setup') return navigateTo(loggedIn.value ? '/' : '/login')

  if (PUBLIC_ROUTES.has(to.path)) {
    return loggedIn.value ? navigateTo('/') : undefined
  }
  if (!loggedIn.value) {
    return navigateTo({ path: '/login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : undefined })
  }

  const { me, refresh, can } = useMe()
  if (!me.value) await refresh()

  if (to.path.startsWith('/admin')) {
    const rule = ADMIN_ROUTES.find(([prefix]) => to.path.startsWith(prefix))
    if (!rule || !can(rule[1])) return navigateTo('/')
  }
})
