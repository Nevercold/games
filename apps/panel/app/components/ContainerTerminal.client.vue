<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ nodeId: string; container: string; shell: string }>()
const emit = defineEmits<{ exit: [] }>()

const el = ref<HTMLElement | null>(null)
const state = ref<'connecting' | 'open' | 'closed'>('connecting')
const error = ref('')
let term: Terminal | undefined
let fit: FitAddon | undefined
let ws: WebSocket | undefined
let observer: ResizeObserver | undefined

function sendResize() {
  if (term && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }
}

onMounted(async () => {
  await nextTick()
  if (!el.value) return
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    theme: { background: '#0a0a0a' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.value)
  fit.fit()

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const q = new URLSearchParams({ container: props.container, shell: props.shell, cols: String(term.cols), rows: String(term.rows) })
  ws = new WebSocket(`${proto}://${location.host}/api/admin/nodes/${props.nodeId}/docker/exec?${q}`)
  ws.onopen = () => {
    state.value = 'open'
    term?.focus()
  }
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.type === 'output') term?.write(msg.data)
    else if (msg.type === 'error') error.value = msg.message
    else if (msg.type === 'exit') {
      state.value = 'closed'
      term?.write('\r\n\x1b[2m[Sitzung beendet]\x1b[0m\r\n')
    }
  }
  ws.onclose = () => {
    if (state.value === 'connecting') error.value ||= 'Verbindung abgelehnt'
    state.value = 'closed'
  }
  term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
  })
  term.onResize(sendResize)
  observer = new ResizeObserver(() => fit?.fit())
  observer.observe(el.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  ws?.close()
  term?.dispose()
})

defineExpose({ close: () => ws?.close() })
watch(state, (s) => s === 'closed' && emit('exit'))
</script>

<template>
  <div class="flex flex-col h-full min-h-0 gap-2">
    <UAlert v-if="error" color="error" variant="subtle" :title="error" class="shrink-0" />
    <div ref="el" class="flex-1 min-h-0 rounded-md bg-[#0a0a0a] p-2" />
  </div>
</template>
