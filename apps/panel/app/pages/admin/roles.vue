<script setup lang="ts">
import { ADMIN_PERMISSION_GROUPS } from '#shared/permissions'
import type { TableColumn } from '@nuxt/ui'

useHead({ title: 'Rollen' })
const toast = useToast()
const { me, can } = useMe()

interface Role {
  id: string
  name: string
  description: string | null
  permissions: string[]
  userCount: number
}
const { data: roles, refresh, status } = await useFetch<Role[]>('/api/admin/roles', { default: () => [] })

const columns: TableColumn<Role>[] = [
  { accessorKey: 'name', header: 'Rolle' },
  { accessorKey: 'permissions', header: 'Rechte' },
  { accessorKey: 'userCount', header: 'Benutzer' },
  { id: 'actions', header: '' },
]

const open = ref(false)
const editing = ref<Role | null>(null)
const form = reactive({ name: '', description: '', permissions: [] as string[] })
const saving = ref(false)
const grantable = computed(() => me.value?.adminPermissions ?? [])

function openEdit(role: Role | null) {
  editing.value = role
  form.name = role?.name ?? ''
  form.description = role?.description ?? ''
  form.permissions = [...(role?.permissions ?? [])]
  open.value = true
}

async function save() {
  saving.value = true
  try {
    const body = { name: form.name, description: form.description || null, permissions: form.permissions }
    if (editing.value) await $fetch(`/api/admin/roles/${editing.value.id}`, { method: 'PUT', body })
    else await $fetch('/api/admin/roles', { method: 'POST', body })
    open.value = false
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function remove(role: Role) {
  try {
    await $fetch(`/api/admin/roles/${role.id}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel id="roles">
    <template #header>
      <UDashboardNavbar title="Rollen">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton v-if="can('admin.roles.write')" icon="i-lucide-plus" label="Rolle anlegen" @click="openEdit(null)" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert
        class="shrink-0"
        icon="i-lucide-info"
        variant="subtle"
        color="neutral"
        title="Rollen geben Zugriff auf den Admin-Bereich."
        description="Superadmins haben immer alle Rechte. Zugriff auf einzelne Server vergibst du über Subuser auf der Server-Seite."
      />
      <UTable :data="roles" :columns="columns" :loading="status === 'pending'">
        <template #name-cell="{ row }">
          <p class="font-medium text-highlighted">{{ row.original.name }}</p>
          <p v-if="row.original.description" class="text-xs text-muted">{{ row.original.description }}</p>
        </template>
        <template #permissions-cell="{ row }">
          <div class="flex flex-wrap gap-1 max-w-xl">
            <UBadge v-for="p in row.original.permissions" :key="p" :label="p.replace('admin.', '')" size="sm" color="neutral" variant="subtle" />
          </div>
        </template>
        <template #actions-cell="{ row }">
          <div v-if="can('admin.roles.write')" class="flex justify-end gap-1">
            <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" aria-label="Rolle bearbeiten" @click="openEdit(row.original)" />
            <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" aria-label="Rolle löschen" @click="remove(row.original)" />
          </div>
        </template>
        <template #empty>
          <UEmpty icon="i-lucide-shield" title="Noch keine Rollen" description="Lege zum Beispiel eine Rolle „Support“ mit Leserechten an." />
        </template>
      </UTable>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="open" :title="editing ? 'Rolle bearbeiten' : 'Rolle anlegen'" :ui="{ content: 'sm:max-w-3xl' }">
    <template #body>
      <form id="role-form" class="space-y-4" @submit.prevent="save">
        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField label="Name" required>
            <UInput v-model="form.name" class="w-full" maxlength="48" autofocus />
          </UFormField>
          <UFormField label="Beschreibung">
            <UInput v-model="form.description" class="w-full" maxlength="500" />
          </UFormField>
        </div>
        <PermissionChecklist v-model="form.permissions" :groups="ADMIN_PERMISSION_GROUPS" :grantable="grantable" />
      </form>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="open = false" />
        <UButton type="submit" form="role-form" label="Speichern" :loading="saving" :disabled="!form.name.trim()" />
      </div>
    </template>
  </UModal>
</template>
