<script setup lang="ts">
const id = useRoute().params.id as string
const { data: server } = await useServerDetail(id)
const socket = inject(SERVER_SOCKET)!
const toast = useToast()

const can = (p: string) => server.value?.permissions.includes(p) ?? false
if (!can('startup.read') && !can('settings.reinstall')) {
  throw createError({ statusCode: 404, statusMessage: 'Seite nicht gefunden', fatal: true })
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
    <UCard v-if="can('startup.read')">
      <template #header>
        <p class="font-medium text-highlighted">Startparameter</p>
      </template>
      <div class="space-y-4">
        <UFormField v-if="server?.image" label="Docker-Image">
          <UInput :model-value="server.image" readonly class="w-full font-mono" />
        </UFormField>
        <UFormField v-if="server?.startup" label="Startbefehl">
          <UTextarea :model-value="server.startup" readonly autoresize class="w-full font-mono" />
        </UFormField>
        <div v-if="server?.variables.length" class="grid gap-4 sm:grid-cols-2">
          <UFormField v-for="v in server.variables" :key="v.env" :label="v.name" :help="v.description" :hint="v.env">
            <UInput :model-value="v.value" readonly class="w-full font-mono" />
          </UFormField>
        </div>
        <p class="text-xs text-muted">Variablen bearbeiten folgt in einer späteren Phase.</p>
      </div>
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
