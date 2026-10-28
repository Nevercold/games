<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { bracketMatching, defaultHighlightStyle, foldGutter, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'

const props = defineProps<{ modelValue: string; filename: string; readonly?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: [] }>()

function languageFor(name: string): Extension {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'json': case 'json5': case 'mcmeta': return json()
    case 'yml': case 'yaml': return yaml()
    case 'js': case 'mjs': case 'cjs': return javascript()
    case 'ts': return javascript({ typescript: true })
    case 'xml': case 'html': return xml()
    case 'md': return markdown()
    case 'toml': return StreamLanguage.define(toml)
    case 'sh': case 'bash': return StreamLanguage.define(shell)
    case 'properties': case 'ini': case 'cfg': case 'conf': case 'env': return StreamLanguage.define(properties)
    default: return []
  }
}

const el = ref<HTMLElement | null>(null)
let view: EditorView | undefined
const theme = new Compartment()
const colorMode = useColorMode()
const themeFor = (mode: string) => (mode === 'dark' ? oneDark : syntaxHighlighting(defaultHighlightStyle))

onMounted(async () => {
  await nextTick()
  if (!el.value) return
  view = new EditorView({
    parent: el.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { emit('save'); return true } },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        languageFor(props.filename),
        theme.of(themeFor(colorMode.value)),
        EditorState.readOnly.of(!!props.readonly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
        }),
        EditorView.theme({ '&': { height: '100%', fontSize: '13px' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
      ],
    }),
  })
  view.focus()
})

watch(() => colorMode.value, (mode) => view?.dispatch({ effects: theme.reconfigure(themeFor(mode)) }))
// External value changes (e.g. reload) replace the document.
watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })
  }
})
onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div ref="el" class="h-full min-h-0 overflow-hidden rounded-md border border-default" />
</template>
