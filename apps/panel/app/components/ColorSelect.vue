<script setup lang="ts">
import { ORG_COLORS } from '#shared/permissions'

const model = defineModel<string | null>()
withDefaults(defineProps<{ allowNone?: boolean }>(), { allowNone: false })
</script>

<template>
  <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Farbe">
    <button
      v-if="allowNone"
      type="button"
      role="radio"
      :aria-checked="model === null"
      aria-label="Keine Farbe"
      class="size-6 rounded-full border border-default flex items-center justify-center"
      :class="model === null ? 'outline-2 outline-offset-2 outline-primary' : ''"
      @click="model = null"
    >
      <UIcon name="i-lucide-x" class="size-3 text-muted" />
    </button>
    <button
      v-for="c in ORG_COLORS"
      :key="c"
      type="button"
      role="radio"
      :aria-checked="model === c"
      :aria-label="c"
      :title="c"
      class="size-6 rounded-full"
      :class="[COLOR_DOT[c], model === c ? 'outline-2 outline-offset-2 outline-primary' : '']"
      @click="model = c"
    />
  </div>
</template>
