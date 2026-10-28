<script setup lang="ts">
import { SERVER_PERMISSION_GROUPS } from '#shared/permissions'
import type { TableColumn } from '@nuxt/ui'

const id = useRoute().params.id as string
const { data: server } = await useServerDetail(id)
const toast = useToast()

const can = (p: string) => server.value?.permissions.includes(p) ?? false
if (!can('user.read')) throw createError({ statusCode: 404, statusMessage: 'Seite nicht gefunden', fatal: true })

interface Subuser {
  id: string
  userId: string
  username: string
  email: string
  permissions: string[]
}
const { data: subusers, refresh } = await useFetch<Subuser[]>(`/api/servers/${id}/subusers`, { default: () => [] })

const columns: TableColumn<Subuser>[] = [
  { accessorKey: 'username', header: 'Benutzer' },
  { accessorKey: 'permissions', header: 'Rechte' },
  actionsColumn<Subuser>(),
]

const grantable = computed(() => server.value?.permissions ?? [])

const open = ref(false)
const editing = ref<Subuser | null>(null)
const form = reactive({ login: '', permissions: ['control.console'] as string[] })
const saving = ref(false)

function openAdd() {
  editing.value = null
  form.login = ''
  form.permissions = ['control.console']
  open.value = true
}

function openEdit(sub: Subuser) {
  editing.value = sub
  form.permissions = [...sub.permissions]
  open.value = true
}

async function save() {
  saving.value = true
  try {
    if (editing.value) {
      await $fetch(`/api/servers/${id}/subusers/${editing.value.id}`, { method: 'PUT', body: { permissions: form.permissions } })
    } else {
      await $fetch(`/api/servers/${id}/subusers`, { method: 'POST', body: { login: form.login, permissions: form.permissions } })
    }
    open.value = false
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function remove(sub: Subuser) {
  try {
    await $fetch(`/api/servers/${id}/subusers/${sub.id}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  }
}
</script>

<template>
  <div class="space-y-4 max-w-4xl">
    <div class="flex items-center justify-between gap-4">
      <p class="text-sm text-muted">Subuser bekommen Zugriff auf diesen Server mit genau den Rechten, die du hier vergibst.</p>
      <UButton v-if="can('user.write')" icon="i-lucide-user-plus" label="Subuser hinzufügen" @click="openAdd" />
    </div>

    <UTable :data="subusers" :columns="columns">
      <template #username-cell="{ row }">
        <p class="font-medium text-highlighted">{{ row.original.username }}</p>
        <p class="text-xs text-muted">{{ row.original.email }}</p>
      </template>
      <template #permissions-cell="{ row }">
        <span class="text-sm">{{ row.original.permissions.length }} Rechte</span>
      </template>
      <template #actions-cell="{ row }">
        <div v-if="can('user.write')" class="flex justify-end gap-1">
          <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" aria-label="Rechte bearbeiten" @click="openEdit(row.original)" />
          <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" aria-label="Subuser entfernen" @click="remove(row.original)" />
        </div>
      </template>
      <template #empty>
        <UEmpty icon="i-lucide-users" title="Keine Subuser" />
      </template>
    </UTable>

    <UModal v-model:open="open" :title="editing ? `Rechte von ${editing.username}` : 'Subuser hinzufügen'" :ui="{ content: 'sm:max-w-2xl' }">
      <template #body>
        <form id="subuser-form" class="space-y-4" @submit.prevent="save">
          <UFormField v-if="!editing" label="E-Mail oder Benutzername" required help="Der Benutzer muss bereits ein Konto haben.">
            <UInput v-model="form.login" class="w-full" autofocus />
          </UFormField>
          <PermissionChecklist v-model="form.permissions" :groups="SERVER_PERMISSION_GROUPS" :grantable="grantable" />
        </form>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" label="Abbrechen" @click="open = false" />
          <UButton type="submit" form="subuser-form" label="Speichern" :loading="saving" :disabled="!editing && !form.login.trim()" />
        </div>
      </template>
    </UModal>
  </div>
</template>
