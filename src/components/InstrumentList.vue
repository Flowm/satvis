<template>
  <div class="instrumentList">
    <section v-for="instrument in instruments" :key="instrument.name" class="instrument" :class="{ 'instrument--open': open.has(instrument.name) }" :aria-label="instrument.name">
      <div class="instrument__line">
        <button type="button" class="instrument__toggle" :aria-expanded="open.has(instrument.name)" @click="toggle(instrument.name)">
          <UIcon name="lucide:chevron-right" class="instrument__chevron" />
          <span class="instrument__name">{{ instrument.name }}</span>
          <span class="instrument__kind">{{ rowOf(instrument, "Kind") }}</span>
          <span v-if="instrument.retired" class="instrument__retired">Retired</span>
          <span class="instrument__resolution">{{ rowOf(instrument, "Resolution") }}</span>
        </button>
        <button
          v-if="instrument.imagery.length > 0"
          type="button"
          class="instrument__imagery"
          :aria-label="`Imagery of ${instrument.name}`"
          title="Imagery"
          @click="emit('showImagery', instrument.name)"
        >
          <UIcon name="lucide:image" />
        </button>
        <span v-else-if="anyImagery" class="instrument__imagery" />
      </div>
      <div v-if="open.has(instrument.name)" class="instrument__more">
        <div v-if="instrument.fullName" class="instrument__full">{{ instrument.fullName }}</div>
        <dl v-if="instrument.rows.length > 0">
          <template v-for="[label, value] in instrument.rows" :key="label">
            <dt>{{ label }}</dt>
            <dd>{{ value }}</dd>
          </template>
        </dl>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";

import type { InstrumentInfo } from "@/modules/util/entityInfo";

/**
 * The Instruments tab: a line each, name, kind and finest resolution, the rest behind a
 * press. An instrument with imagery has a button that opens the Imagery tab at it.
 */
const props = defineProps<{ instruments: InstrumentInfo[] }>();
const emit = defineEmits<{ showImagery: [instrument: string] }>();

const open = reactive(new Set<string>());
/** Keeps the resolutions in one column, where some rows have the imagery button. */
const anyImagery = computed(() => props.instruments.some((instrument) => instrument.imagery.length > 0));

function toggle(name: string): void {
  if (!open.delete(name)) {
    open.add(name);
  }
}

function rowOf(instrument: InstrumentInfo, label: string): string | undefined {
  return instrument.rows.find(([key]) => key === label)?.[1];
}
</script>

<style scoped>
.instrument {
  border-bottom: 1px solid #ffffff10;
}

.instrument__line {
  display: flex;
  align-items: center;
}

.instrument__toggle {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 8px;
  padding: 7px 2px;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

/* The whole line, so a row whose image button is only a space still lights to the edge. */
.instrument__line:hover {
  background: #ffffff08;
}

button.instrument__imagery:hover {
  background: #ffffff14;
}

.instrument__chevron {
  flex: none;
  color: var(--panel-faint);
  transition: transform 0.15s;
}

.instrument--open .instrument__chevron {
  transform: rotate(90deg);
}

.instrument__name {
  flex: none;
  font-weight: 600;
}

.instrument__kind {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--panel-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Amber: the app colour for "away from rest", as on the status chip. */
.instrument__retired {
  flex: none;
  color: var(--panel-amber);
  font-size: 11px;
}

.instrument__resolution {
  flex: none;
  color: var(--panel-muted);
  font-variant-numeric: tabular-nums;
}

/* 32 px: a finger's target on the phone. */
.instrument__imagery {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border-radius: 4px;
  color: var(--panel-accent);
}

button.instrument__imagery {
  cursor: pointer;
}

.instrument__more {
  padding: 0 4px 10px 26px;
  font-size: 12px;
}

.instrument__full {
  margin-bottom: 4px;
  color: var(--panel-muted);
}

dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
}

dt {
  color: var(--panel-muted);
}

dd {
  margin: 0;
}
</style>
