<script setup lang="ts">
const id = useRoute().params.id as string
const { data: server } = await useServerDetail(id)
const socket = inject(SERVER_SOCKET)!
const toast = useToast()

const can = (p: string) => server.value?.permissions.includes(p) ?? false
if (!can('startup.read') && !can('settings.reinstall') && !server.value?.sftp) {
  throw createError({ statusCode: 404, statusMessage: 'Seite nicht gefunden', fatal: true })
}

const sftpRows = computed(() => {
  const s = server.value?.sftp
  if (!s) return []
  return [
    { label: 'Adresse', value: `sftp://${s.host}:${s.port}` },
    { label: 'Benutzername', value: s.username },
  ]
})
async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  toast.add({ title: 'Kopiert', icon: 'i-lucide-check', color: 'success' })
}

// --- startup variables ---------------------------------------------------------
const initial = () => ({
  image: server.value?.image ?? '',
  variables: Object.fromEntries((server.value?.variables ?? []).map((v) => [v.env, v.value])),
})
const form = reactive(initial())
const snapshot = ref(JSON.stringify(initial()))
const startupDirty = computed(() => JSON.stringify(form) !== snapshot.value)
const fieldErrors = ref<Record<string, string>>({})
const savingStartup = ref(false)

async function saveStartup() {
  savingStartup.value = true
  fieldErrors.value = {}
  try {
    const res = await $fetch<{ restartRequired: boolean }>(`/api/servers/${id}/startup`, { method: 'PUT', body: form })
    snapshot.value = JSON.stringify(form)
    toast.add({
      title: 'Startparameter gespeichert',
      description: res.restartRequired ? 'Die Änderungen gelten nach dem nächsten Neustart.' : undefined,
      color: 'success',
    })
  } catch (err: any) {
    fieldErrors.value = err?.data?.data?.errors ?? {}
    toast.add({ title: 'Nicht gespeichert', description: errorMessage(err), color: 'error' })
  } finally {
    savingStartup.value = false
  }
}

const confirmReinstall = ref(false)
const reinstalling = ref(false)
async function reinstall() {
  reinstalling.value = true
  try {
    await $fetch(`/api/servers/${id}/reinstall`, { method: 'POST' })
    toast.add({ title: 'Installation gestartet', description: 'Den Fortschritt siehst du in der Konsole.', color: 'success' })
    confirmReinstall.value = false
    await navigateTo(`/servers/${id}`)
  } catch (err) {
    toast.add({ title: 'Fehler', description: errorMessage(err), color: 'error' })
  } finally {
    reinstalling.value = false
  }
}
</script>

<template>
  <div class="space-y-6 max-w-3xl">
    <UCard v-if="server?.sftp">
      <template #header>
        <p class="font-medium text-highlighted">SFTP-Zugang</p>
      </template>
      <dl class="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 text-sm">
        <template v-for="row in sftpRows" :key="row.label">
          <dt class="text-muted">{{ row.label }}</dt>
          <dd class="font-mono truncate">{{ row.value }}</dd>
          <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" :aria-label="`${row.label} kopieren`" @click="copy(row.value)" />
        </template>
      </dl>
      <p class="text-xs text-muted mt-3">
        Passwort ist dein Panel-Passwort. Du siehst und änderst per SFTP nur, was deine Datei-Rechte erlauben.
      </p>
    </UCard>

    <UCard v-if="can('startup.read')">
      <template #header>
        <p class="font-medium text-highlighted">Startparameter</p>
      </template>
      <form class="space-y-4" @submit.prevent="saveStartup">
        <UFormField label="Docker-Image">
          <USelect
            v-if="server?.images.length && can('startup.update')"
            v-model="form.image"
            :items="server.images"
            class="w-full"
          />
          <UInput v-else :model-value="server?.image ?? ''" readonly class="w-full font-mono" />
        </UFormField>
        <UFormField v-if="server?.startup" label="Startbefehl">
          <UTextarea :model-value="server.startup" readonly autoresize class="w-full font-mono" />
        </UFormField>
        <div v-if="server?.variables.length" class="grid gap-4 sm:grid-cols-2">
          <UFormField
            v-for="v in server.variables"
            :key="v.env"
            :label="v.name"
            :help="v.description"
            :hint="v.env"
            :error="fieldErrors[v.env]"
          >
            <USelect v-if="v.type === 'enum'" v-model="form.variables[v.env]" :items="v.options ?? []" :disabled="!v.editable" class="w-full" />
            <USwitch
              v-else-if="v.type === 'bool'"
              :model-value="form.variables[v.env] === '1' || form.variables[v.env] === 'true'"
              :disabled="!v.editable"
              @update:model-value="(b: boolean) => (form.variables[v.env] = b ? '1' : '0')"
            />
            <UInput
              v-else
              v-model="form.variables[v.env]"
              :type="v.type === 'secret' ? 'password' : 'text'"
              :readonly="!v.editable"
              class="w-full font-mono"
            />
          </UFormField>
        </div>
        <div v-if="can('startup.update')" class="flex items-center justify-end gap-3">
          <span v-if="startupDirty" class="text-xs text-muted">Ungespeicherte Änderungen</span>
          <UButton type="submit" label="Speichern" :loading="savingStartup" :disabled="!startupDirty" />
        </div>
      </form>
    </UCard>

    <UCard v-if="can('settings.reinstall')">
      <template #header>
        <p class="font-medium text-highlighted">Neu installieren</p>
      </template>
      <p class="text-sm text-muted mb-4">
        Führt das Installationsskript des Templates erneut aus. Je nach Template werden dabei Dateien überschrieben.
      </p>
      <UButton
        color="warning"
        icon="i-lucide-refresh-ccw"
        label="Neu installieren"
        :disabled="!['offline', 'install_failed'].includes(socket.status.value)"
        @click="confirmReinstall = true"
      />
      <p v-if="!['offline', 'install_failed'].includes(socket.status.value)" class="text-xs text-muted mt-2">
        Stoppe den Server, um ihn neu zu installieren.
      </p>
    </UCard>

    <UModal v-model:open="confirmReinstall" title="Server neu installieren?" description="Das Installationsskript läuft erneut und kann Dateien überschreiben.">
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" label="Abbrechen" @click="confirmReinstall = false" />
          <UButton color="warning" label="Neu installieren" :loading="reinstalling" @click="reinstall" />
        </div>
      </template>
    </UModal>
  </div>
</template>
