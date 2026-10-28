<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import type { AdminPermission } from '#shared/permissions'

const { clear } = useUserSession()
const { me, can } = useMe()
const branding = useBranding()

const main = computed<NavigationMenuItem[]>(() => [
  { label: 'Meine Server', icon: 'i-lucide-layout-grid', to: '/' },
])

const ADMIN_ITEMS: (NavigationMenuItem & { perm: AdminPermission })[] = [
  { label: 'Server', icon: 'i-lucide-server', to: '/admin/servers', perm: 'admin.servers.read' },
  { label: 'Nodes', icon: 'i-lucide-network', to: '/admin/nodes', perm: 'admin.nodes.read' },
  { label: 'Templates', icon: 'i-lucide-package', to: '/admin/templates', perm: 'admin.templates.read' },
  { label: 'Benutzer', icon: 'i-lucide-users', to: '/admin/users', perm: 'admin.users.read' },
  { label: 'Rollen', icon: 'i-lucide-shield', to: '/admin/roles', perm: 'admin.users.read' },
  { label: 'Backup-Ziele', icon: 'i-lucide-hard-drive-upload', to: '/admin/backups', perm: 'admin.backups.write' },
  { label: 'Plugins', icon: 'i-lucide-puzzle', to: '/admin/plugins', perm: 'admin.plugins.read' },
  { label: 'Branding', icon: 'i-lucide-palette', to: '/admin/branding', perm: 'admin.settings.write' },
]

const admin = computed<NavigationMenuItem[]>(() =>
  ADMIN_ITEMS.filter((i) => can(i.perm)).map(({ perm: _perm, ...item }) => item),
)

const colorMode = useColorMode()
const userMenu = computed(() => [
  [{ label: me.value?.username ?? '', type: 'label' as const }],
  [
    {
      label: colorMode.value === 'dark' ? 'Helles Design' : 'Dunkles Design',
      icon: colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon',
      onSelect: () => { colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark' },
    },
  ],
  [
    {
      label: 'Abmelden',
      icon: 'i-lucide-log-out',
      onSelect: async () => {
        await clear()
        me.value = null
        await navigateTo('/login')
      },
    },
  ],
])
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar collapsible resizable>
      <template #header="{ collapsed }">
        <NuxtLink to="/" class="flex items-center gap-2 min-w-0">
          <img v-if="branding.logoUrl" :src="branding.logoUrl" alt="" class="h-6 w-auto shrink-0">
          <UIcon v-else name="i-lucide-server" class="size-6 shrink-0 text-primary" />
          <span v-if="!collapsed" class="font-semibold truncate text-highlighted">{{ branding.appName }}</span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu :items="main" orientation="vertical" :collapsed="collapsed" />
        <template v-if="admin.length">
          <p v-if="!collapsed" class="px-2.5 pt-4 pb-1 text-xs font-medium text-dimmed uppercase">Administration</p>
          <UNavigationMenu :items="admin" orientation="vertical" :collapsed="collapsed" />
        </template>
      </template>

      <template #footer="{ collapsed }">
        <UDropdownMenu :items="userMenu" :content="{ align: 'start' }">
          <UButton
            :label="collapsed ? undefined : me?.username"
            icon="i-lucide-circle-user"
            color="neutral"
            variant="ghost"
            block
            :square="collapsed"
          />
        </UDropdownMenu>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
