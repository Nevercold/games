<script setup lang="ts">
import { z } from 'zod'
import type { FormSubmitEvent, TableColumn } from '@nuxt/ui'

useHead({ title: 'Benutzer' })
const toast = useToast()
const { me, can } = useMe()

interface UserRow {
  id: string
  email: string
  username: string
  isAdmin: boolean
  roleId: string | null
  roleName: string | null
  createdAt: string
}
const { data: users, refresh, status } = await useFetch<UserRow[]>('/api/admin/users', { default: () => [] })
const { data: roles } = await useFetch<{ id: string; name: string }[]>('/api/admin/roles', { default: () => [] })

const roleItems = computed(() => [
  { label: 'Keine Rolle', value: 'none' },
  ...roles.value.map((r) => ({ label: r.name, value: r.id })),
])

const columns: TableColumn<UserRow>[] = [
  { accessorKey: 'username', header: 'Benutzername' },
  { accessorKey: 'email', header: 'E-Mail' },
  { accessorKey: 'roleId', header: 'Rolle' },
  { accessorKey: 'createdAt', header: 'Angelegt' },
]

async function patchUser(user: UserRow, body: { roleId?: string | null; isAdmin?: boolean }) {
  try {
    await $fetch(`/api/admin/users/${user.id}`, { method: 'PATCH', body })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
    await refresh()
  }
}

// --- create ---
const schema = z.object({
  email: z.email('Ungültige E-Mail'),
  username: z.string().min(3, 'Mindestens 3 Zeichen').max(32).regex(/^[a-zA-Z0-9_.-]+$/, 'Nur Buchstaben, Ziffern, _ . -'),
  password: z.string().min(10, 'Mindestens 10 Zeichen'),
  isAdmin: z.boolean(),
  roleId: z.string(),
})
type Schema = z.output<typeof schema>

const open = ref(false)
const saving = ref(false)
const error = ref('')
const state = reactive<Schema>({ email: '', username: '', password: '', isAdmin: false, roleId: 'none' })

function openCreate() {
  Object.assign(state, { email: '', username: '', password: '', isAdmin: false, roleId: 'none' })
  error.value = ''
  open.value = true
}

async function onSubmit(event: FormSubmitEvent<Schema>) {
  saving.value = true
  error.value = ''
  try {
    const { roleId, ...rest } = event.data
    await $fetch('/api/admin/users', { method: 'POST', body: { ...rest, roleId: roleId === 'none' ? null : roleId } })
    open.value = false
    toast.add({ title: 'Benutzer angelegt', color: 'success' })
    await refresh()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="users">
    <template #header>
      <UDashboardNavbar title="Benutzer">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton v-if="can('admin.users.write')" icon="i-lucide-user-plus" label="Benutzer anlegen" @click="openCreate" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UTable :data="users" :columns="columns" :loading="status === 'pending'">
        <template #username-cell="{ row }">
          <div class="flex items-center gap-2">
            <span class="font-medium text-highlighted">{{ row.original.username }}</span>
            <UBadge v-if="row.original.isAdmin" label="Superadmin" size="sm" variant="subtle" icon="i-lucide-crown" />
            <UBadge v-if="row.original.id === me?.id" label="Du" size="sm" color="neutral" variant="subtle" />
          </div>
        </template>
        <template #roleId-cell="{ row }">
          <div class="flex items-center gap-2">
            <USelect
              v-if="can('admin.users.write') && !row.original.isAdmin"
              :model-value="row.original.roleId ?? 'none'"
              :items="roleItems"
              size="sm"
              class="w-44"
              @update:model-value="(v: string) => patchUser(row.original, { roleId: v === 'none' ? null : v })"
            />
            <span v-else class="text-sm">{{ row.original.isAdmin ? 'alle Rechte' : row.original.roleName ?? '–' }}</span>
            <UTooltip v-if="me?.isAdmin && row.original.id !== me?.id" :text="row.original.isAdmin ? 'Superadmin entziehen' : 'Zum Superadmin machen'">
              <UButton
                :icon="row.original.isAdmin ? 'i-lucide-crown' : 'i-lucide-crown'"
                size="xs"
                :color="row.original.isAdmin ? 'primary' : 'neutral'"
                variant="ghost"
                :aria-label="row.original.isAdmin ? 'Superadmin entziehen' : 'Zum Superadmin machen'"
                @click="patchUser(row.original, { isAdmin: !row.original.isAdmin })"
              />
            </UTooltip>
          </div>
        </template>
        <template #createdAt-cell="{ row }">{{ formatRelative(row.original.createdAt) }}</template>
      </UTable>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="open" title="Benutzer anlegen">
    <template #body>
      <UForm id="user-form" :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
        <UFormField label="E-Mail" name="email">
          <UInput v-model="state.email" type="email" class="w-full" autofocus />
        </UFormField>
        <UFormField label="Benutzername" name="username">
          <UInput v-model="state.username" class="w-full" />
        </UFormField>
        <UFormField label="Passwort" name="password">
          <UInput v-model="state.password" type="password" autocomplete="new-password" class="w-full" />
        </UFormField>
        <UFormField label="Rolle" name="roleId" help="Rollen geben Rechte im Admin-Bereich. Ohne Rolle sieht der Benutzer nur seine Server.">
          <USelect v-model="state.roleId" :items="roleItems" class="w-full" :disabled="state.isAdmin" />
        </UFormField>
        <UFormField v-if="me?.isAdmin" name="isAdmin">
          <USwitch v-model="state.isAdmin" label="Superadmin (alle Rechte)" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      </UForm>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" label="Abbrechen" @click="open = false" />
        <UButton type="submit" form="user-form" label="Anlegen" :loading="saving" />
      </div>
    </template>
  </UModal>
</template>
