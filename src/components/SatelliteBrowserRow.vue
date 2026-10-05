<template>
  <div v-if="row.kind === 'group'" class="browser-row browser-row--group">
    <button type="button" class="browser-chevron" :aria-label="row.expanded ? 'Collapse group' : 'Expand group'" @click="emit('toggle-expand', row.tag)">
      <UIcon :name="row.expanded ? 'lucide:chevron-down' : 'lucide:chevron-right'" />
    </button>
    <input
      ref="groupCheckbox"
      class="browser-checkbox"
      type="checkbox"
      :checked="row.state === 'all'"
      :aria-label="`Toggle group ${row.tag}`"
      @click.stop="emit('toggle-group', row.tag)"
    />
    <span class="browser-label browser-label--group" @click="emit('toggle-expand', row.tag)">{{ row.tag }}</span>
    <span class="browser-badge">{{ row.activeCount }}/{{ row.count }}</span>
  </div>

  <div v-else class="browser-row browser-row--sat">
    <input class="browser-checkbox" type="checkbox" :checked="row.checked" :aria-label="`Toggle ${row.name}`" @click.stop="emit('toggle-sat', row.name)" />
    <span class="browser-label browser-label--sat" @click="emit('toggle-sat', row.name)">{{ row.name }}</span>
    <span class="browser-orbit" :style="{ color: ORBIT_CLASS_COLOR[row.orbitClass] }" :title="`${row.orbitClass} — the colour this satellite's point is drawn in`">{{
      row.orbitClass
    }}</span>
    <span class="browser-satnum">{{ row.satnum }}</span>
    <span v-if="row.groupsLabel" class="browser-groups">{{ row.groupsLabel }}</span>
    <button type="button" class="browser-info" :aria-label="`Show info for ${row.name}`" :title="`Show info for ${row.name}`" @click="emit('show-info', row.name)">
      <UIcon name="lucide:info" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

import type { BrowserRow } from "../composables/useSatelliteBrowser";
import { ORBIT_CLASS_COLOR } from "../config/orbitClass";

const props = defineProps<{ row: BrowserRow }>();
const emit = defineEmits<{
  "toggle-group": [tag: string];
  "toggle-sat": [name: string];
  "show-info": [name: string];
  "toggle-expand": [tag: string];
}>();

// `indeterminate` is a DOM property only, never an attribute, so it is set imperatively.
// Not UCheckbox: it renders a light-theme surface in this panel.
const groupCheckbox = ref<HTMLInputElement | null>(null);
function syncIndeterminate() {
  if (props.row.kind === "group" && groupCheckbox.value) {
    groupCheckbox.value.indeterminate = props.row.state === "some";
  }
}
onMounted(syncIndeterminate);
watch(() => (props.row.kind === "group" ? props.row.state : undefined), syncIndeterminate);
</script>

<style scoped>
.browser-row {
  display: flex;
  align-items: center;
  height: 28px;
  gap: 6px;
  padding: 0 6px;
  box-sizing: border-box;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
}

.browser-row--group {
  font-weight: 600;
}

.browser-chevron {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: #b8c4c4;
  font-size: 11px;
}

.browser-chevron:hover {
  color: #edffff;
}

.browser-checkbox {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  margin: 0;
  cursor: pointer;
  accent-color: #2f9e44;
}

.browser-row--sat .browser-checkbox {
  margin-left: 16px;
}

.browser-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.browser-label--sat {
  font-weight: 400;
}

.browser-badge {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 400;
  color: #b8c4c4;
  font-variant-numeric: tabular-nums;
}

/* Fixed width keeps the satnums in one column; the colour is set inline. */
.browser-orbit {
  flex: 0 0 auto;
  width: 26px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.browser-satnum {
  flex: 0 0 auto;
  font-size: 11px;
  color: #8a9797;
  font-variant-numeric: tabular-nums;
}

.browser-info {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  color: #8a9797;
}

.browser-info:hover {
  color: #edffff;
}

.browser-groups {
  flex: 0 1 auto;
  font-size: 11px;
  color: #8a9797;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
