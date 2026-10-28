<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'

useHead({ title: 'Plugins' })

const { data: plugins, status } = await useFetch('/api/admin/plugins', { default: () => [] })
type Plugin = (typeof plugins.value)[number]

const columns: TableColumn<Plugin>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'version', header: 'Version' },
  { accessorKey: 'type', header: 'Typ' },
  { accessorKey: 'status', header: 'Status' },
]
</script>

<template>
  <UDashboardPanel id="plugins">
    <template #header>
      <UDashboardNavbar title="Plugins">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        class="shrink-0"
        icon="i-lucide-info"
        variant="subtle"
        color="neutral"
        title="Plugins werden beim Start aus dem Plugin-Verzeichnis geladen."
        description="Installation über die Oberfläche folgt in einer späteren Phase."
      />
      <UTable :data="plugins" :columns="columns" :loading="status === 'pending'">
        <template #id-cell="{ row }"><code class="text-xs">{{ row.original.id }}</code></template>
        <template #status-cell="{ row }">
          <UTooltip :text="row.original.error" :disabled="!row.original.error">
            <UBadge :color="row.original.status === 'active' ? 'success' : 'error'" variant="subtle">
              {{ row.original.status === 'active' ? 'aktiv' : 'fehlerhaft' }}
            </UBadge>
          </UTooltip>
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-puzzle" title="Keine Plugins installiert" />
        </template>
      </UTable>
    </template>
  </UDashboardPanel>
</template>
