<script setup lang="ts">
import type { PermissionGroup } from '#shared/permissions'

const model = defineModel<string[]>({ required: true })
const props = defineProps<{
  groups: readonly PermissionGroup[]
  /** Permissions the editor may grant; others are shown but disabled. */
  grantable?: string[]
}>()

const selected = computed(() => new Set(model.value))
const canGrant = (id: string) => !props.grantable || props.grantable.includes(id)

function toggle(id: string, on: boolean) {
  const next = new Set(model.value)
  if (on) next.add(id)
  else next.delete(id)
  model.value = [...next]
}

function toggleGroup(group: PermissionGroup, on: boolean) {
  const next = new Set(model.value)
  for (const p of group.permissions) {
    if (!canGrant(p.id)) continue
    if (on) next.add(p.id)
    else next.delete(p.id)
  }
  model.value = [...next]
}

function groupState(group: PermissionGroup): boolean | 'indeterminate' {
  const n = group.permissions.filter((p) => selected.value.has(p.id)).length
  return n === 0 ? false : n === group.permissions.length ? true : 'indeterminate'
}
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <div v-for="group in groups" :key="group.id" class="rounded-md border border-default p-3 space-y-2">
      <UCheckbox
        :model-value="groupState(group)"
        :label="group.label"
        :ui="{ label: 'font-medium text-highlighted' }"
        @update:model-value="(v: boolean | 'indeterminate') => toggleGroup(group, v === true)"
      />
      <div class="space-y-1.5 pl-6">
        <UCheckbox
          v-for="p in group.permissions"
          :key="p.id"
          :model-value="selected.has(p.id)"
          :label="p.label"
          :description="p.description"
          :disabled="!canGrant(p.id)"
          @update:model-value="(v: boolean | 'indeterminate') => toggle(p.id, v === true)"
        />
      </div>
    </div>
  </div>
</template>
