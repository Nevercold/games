<script setup lang="ts">
import type { PowerAction } from '#shared/permissions'

const route = useRoute()
const id = route.params.id as string
const toast = useToast()

const { data: server, error: loadError, refresh } = await useServerDetail(id)
if (loadError.value || !server.value) {
  throw createError({ statusCode: 404, statusMessage: 'Server nicht gefunden', fatal: true })
}
useHead({ title: () => server.value?.name ?? 'Server' })

const socket = useServerSocket(id, server.value.status)
provide(SERVER_SOCKET, socket)

// Keep the detail record in sync with live status (e.g. after install).
watch(socket.status, (s) => {
  if (server.value && s !== 'unknown') server.value.status = s
  if (s === 'offline' || s === 'install_failed') refresh()
})

const can = (p: string) => server.value?.permissions.includes(p) ?? false
const liveStatus = computed(() => serverStatus(server.value?.node?.online === false ? 'unknown' : socket.status.value))

const busy = ref<PowerAction | null>(null)
async function power(action: PowerAction) {
  busy.value = action
  try {
    await $fetch(`/api/servers/${id}/power`, { method: 'POST', body: { action } })
  } catch (err) {
    toast.add({ title: 'Aktion fehlgeschlagen', description: errorMessage(err), color: 'error' })
  } finally {
    busy.value = null
  }
}

const st = computed(() => socket.status.value)
const canStart = computed(() => can('control.start') && st.value === 'offline')
const canStop = computed(() => can('control.stop') && ['running', 'starting'].includes(st.value))
const canRestart = computed(() => can('control.restart') && ['running', 'offline'].includes(st.value))
const canKill = computed(() => can('control.kill') && ['running', 'starting', 'stopping'].includes(st.value))

const tabs = computed(() => [
  { label: 'Konsole', icon: 'i-lucide-terminal', to: `/servers/${id}`, exact: true },
  ...(can('file.read') ? [{ label: 'Dateien', icon: 'i-lucide-folder', to: `/servers/${id}/files` }] : []),
  ...(can('startup.read') || can('settings.reinstall') || server.value?.sftp ? [{ label: 'Einstellungen', icon: 'i-lucide-settings', to: `/servers/${id}/settings` }] : []),
  ...(can('user.read') ? [{ label: 'Benutzer', icon: 'i-lucide-users', to: `/servers/${id}/users` }] : []),
])

const toastCopy = async () => {
  if (!server.value?.address) return
  await navigator.clipboard.writeText(server.value.address)
  toast.add({ title: 'Adresse kopiert', icon: 'i-lucide-check', color: 'success' })
}
</script>

<template>
  <UDashboardPanel :id="`server-${id}`">
    <template #header>
      <UDashboardNavbar :title="server?.name">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton icon="i-lucide-arrow-left" color="neutral" variant="ghost" to="/" aria-label="Zurück" />
        </template>
        <template #trailing>
          <UBadge :color="liveStatus.color" variant="subtle" :icon="liveStatus.icon">{{ liveStatus.label }}</UBadge>
        </template>
        <template #right>
          <UButton
            v-if="can('control.start')"
            icon="i-lucide-play"
            label="Start"
            color="success"
            :disabled="!canStart"
            :loading="busy === 'start'"
            @click="power('start')"
          />
          <UButton
            v-if="can('control.restart')"
            icon="i-lucide-rotate-cw"
            label="Neustart"
            color="neutral"
            variant="outline"
            :disabled="!canRestart"
            :loading="busy === 'restart'"
            @click="power('restart')"
          />
          <UButton
            v-if="can('control.stop')"
            icon="i-lucide-square"
            label="Stop"
            color="warning"
            variant="outline"
            :disabled="!canStop"
            :loading="busy === 'stop'"
            @click="power('stop')"
          />
          <UTooltip v-if="can('control.kill')" text="Hart beenden">
            <UButton
              icon="i-lucide-skull"
              color="error"
              variant="ghost"
              aria-label="Hart beenden"
              :disabled="!canKill"
              :loading="busy === 'kill'"
              @click="power('kill')"
            />
          </UTooltip>
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <template #left>
          <UNavigationMenu :items="tabs" highlight class="-mx-1 flex-1" />
        </template>
        <template #right>
          <button v-if="server?.address" type="button" class="font-mono text-sm text-muted hover:text-highlighted" @click="toastCopy">
            {{ server.address }}
          </button>
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <UAlert
        v-if="server?.node && !server.node.online"
        class="shrink-0"
        color="warning"
        variant="subtle"
        icon="i-lucide-unplug"
        title="Node ist offline"
        description="Konsole und Steuerung sind verfügbar, sobald der Daemon wieder verbunden ist."
      />
      <UAlert
        v-if="st === 'install_failed' && server?.statusMessage"
        class="shrink-0"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        title="Installation fehlgeschlagen"
        :description="server.statusMessage.split('\n')[0]"
      />
      <NuxtPage />
    </template>
  </UDashboardPanel>
</template>
