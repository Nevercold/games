<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ canCommand: boolean }>()
const socket = inject(SERVER_SOCKET)!

const el = ref<HTMLElement | null>(null)
let term: Terminal | undefined
let fit: FitAddon | undefined
let off: (() => void) | undefined
let resizeObserver: ResizeObserver | undefined

const colorMode = useColorMode()
const THEMES = {
  dark: { background: '#0a0a0a', foreground: '#e5e5e5', cursor: '#e5e5e5', selectionBackground: '#404040' },
  light: { background: '#fafafa', foreground: '#171717', cursor: '#171717', selectionBackground: '#d4d4d4' },
}

onMounted(async () => {
  // .client components render their template after mount (Nuxt docs).
  await nextTick()
  if (!el.value) return
  term = new Terminal({
    convertEol: false,
    disableStdin: true,
    cursorBlink: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: colorMode.value === 'dark' ? THEMES.dark : THEMES.light,
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.value)
  fit.fit()
  const backlog = socket.backlog()
  if (backlog) term.write(backlog)
  off = socket.onOutput((chunk) => term?.write(chunk))
  resizeObserver = new ResizeObserver(() => fit?.fit())
  resizeObserver.observe(el.value)
})

watch(() => colorMode.value, (mode) => {
  if (term) term.options.theme = mode === 'dark' ? THEMES.dark : THEMES.light
})

onBeforeUnmount(() => {
  off?.()
  resizeObserver?.disconnect()
  term?.dispose()
})

// --- command input with history ----------------------------------------------
const command = ref('')
const history: string[] = []
let historyIndex = -1

function submit() {
  const line = command.value
  if (!line.trim()) return
  socket.sendCommand(line)
  history.unshift(line)
  if (history.length > 100) history.pop()
  historyIndex = -1
  command.value = ''
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowUp' && history.length) {
    historyIndex = Math.min(historyIndex + 1, history.length - 1)
    command.value = history[historyIndex]!
    e.preventDefault()
  } else if (e.key === 'ArrowDown') {
    historyIndex = Math.max(historyIndex - 1, -1)
    command.value = historyIndex >= 0 ? history[historyIndex]! : ''
    e.preventDefault()
  }
}

const inputDisabled = computed(() => !props.canCommand || !socket.connected.value || !['running', 'starting'].includes(socket.status.value))
</script>

<template>
  <div class="rounded-lg border border-default overflow-hidden">
    <div ref="el" class="h-[28rem] p-2" :class="colorMode.value === 'dark' ? 'bg-[#0a0a0a]' : 'bg-[#fafafa]'" />
    <form v-if="canCommand" class="flex items-center gap-2 border-t border-default p-2 bg-elevated/50" @submit.prevent="submit">
      <UIcon name="i-lucide-chevron-right" class="size-4 text-muted" />
      <input
        v-model="command"
        :disabled="inputDisabled"
        class="flex-1 bg-transparent outline-none font-mono text-sm placeholder:text-dimmed disabled:opacity-50"
        :placeholder="inputDisabled ? 'Server läuft nicht' : 'Befehl eingeben…'"
        aria-label="Konsolenbefehl"
        autocomplete="off"
        spellcheck="false"
        @keydown="onKey"
      >
      <UButton type="submit" size="xs" icon="i-lucide-send" :disabled="inputDisabled || !command.trim()" aria-label="Senden" />
    </form>
  </div>
</template>
