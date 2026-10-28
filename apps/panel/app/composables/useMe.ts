import type { AdminPermission } from '#shared/permissions'

interface Me {
  id: string
  username: string
  isAdmin: boolean
  adminPermissions: AdminPermission[]
}

/** Current user with effective admin permissions (refreshed after login). */
export function useMe() {
  const me = useState<Me | null>('me', () => null)

  async function refresh() {
    try {
      me.value = await useRequestFetch()<Me>('/api/me')
    } catch {
      me.value = null
    }
  }

  const can = (perm: AdminPermission) => !!me.value?.adminPermissions.includes(perm)
  const hasAnyAdmin = computed(() => (me.value?.adminPermissions.length ?? 0) > 0)

  return { me, refresh, can, hasAnyAdmin }
}
