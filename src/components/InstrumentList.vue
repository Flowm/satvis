<template>
  <div class="instrumentList">
    <template v-if="measured.length > 0">
      <div class="table">
        <div class="instrument__line instrument__line--head" aria-hidden="true">
          <span class="instrument__head-name">Instrument</span>
          <span class="instrument__resolution">Res</span>
          <span v-if="anyBands" class="bands">Bands</span>
        </div>
        <section v-for="instrument in measured" :key="instrument.name" class="instrument" :class="{ 'instrument--open': open.has(instrument.name) }" :aria-label="instrument.name">
          <div class="instrument__line">
            <button type="button" class="instrument__toggle" :aria-expanded="open.has(instrument.name)" @click="toggle(instrument.name)">
              <span class="instrument__label">
                <UIcon name="lucide:chevron-right" class="instrument__chevron" />
                <span class="instrument__name">{{ instrument.name }}</span>
                <span class="instrument__full-inline">{{ instrument.fullName }}</span>
              </span>
              <span v-if="instrument.retired" class="instrument__retired">Retired</span>
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
            <span class="instrument__resolution">{{ rowOf(instrument, "Resolution") ?? "—" }}</span>
            <span v-if="instrument.bands.length > 0" class="bands" role="img" :aria-label="`Bands: ${instrument.bands.join(', ')}`" :title="instrument.bands.join(' · ')">
              <span v-for="(colour, index) in wavebandCells(instrument.bands)" :key="index" class="bands__cell" :style="colour && { background: colour }" />
            </span>
            <span v-else-if="anyBands" class="bands bands--none">—</span>
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
      <div v-if="anyBands" class="legend" aria-hidden="true">
        <span v-for="column in WAVEBAND_COLUMNS" :key="column.label"><i :style="{ background: column.colour }" />{{ column.label }}</span>
      </div>
    </template>

    <div v-if="folded.length > 0" class="folded">
      <div class="folded__title">{{ measured.length > 0 ? "Also carries" : "Carries" }}</div>
      <div class="folded__chips">
        <button
          v-for="instrument in folded"
          :key="instrument.name"
          type="button"
          class="chip"
          :class="{ 'chip--open': open.has(instrument.name) }"
          :aria-expanded="open.has(instrument.name)"
          @click="toggle(instrument.name)"
        >
          {{ instrument.name }}
          <span v-if="instrument.retired" class="instrument__retired">Retired</span>
        </button>
      </div>
      <template v-for="instrument in folded" :key="instrument.name">
        <section v-if="open.has(instrument.name)" class="folded__more" :aria-label="instrument.name">
          <div class="folded__name">{{ instrument.name }}</div>
          <div v-if="instrument.fullName" class="instrument__full">{{ instrument.fullName }}</div>
          <dl v-if="instrument.rows.length > 0">
            <template v-for="[label, value] in instrument.rows" :key="label">
              <dt>{{ label }}</dt>
              <dd>{{ value }}</dd>
            </template>
          </dl>
        </section>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";

import { WAVEBAND_COLUMNS, wavebandCells } from "@/config/wavebands";
import type { InstrumentInfo } from "@/modules/util/entityInfo";

/**
 * The Instruments tab: a table of the instruments with figures to compare, each line its
 * name and full name, then its finest resolution and its bands, a strip with a column per
 * class; the kind and the rest behind a press. Those CEOS gives neither for, mostly space
 * weather monitors and data relays, fold into a row of chips that open the same. An
 * instrument with imagery has a button that opens the Imagery tab at it.
 */
const props = defineProps<{ instruments: InstrumentInfo[] }>();
const emit = defineEmits<{ showImagery: [instrument: string] }>();

const open = reactive(new Set<string>());

/** Has a resolution, bands or imagery: a line in the table. */
function isMeasured(instrument: InstrumentInfo): boolean {
  return instrument.bands.length > 0 || rowOf(instrument, "Resolution") !== undefined || instrument.imagery.length > 0;
}

const measured = computed(() => props.instruments.filter(isMeasured));
const folded = computed(() => props.instruments.filter((instrument) => !isMeasured(instrument)));
/** Without one, the strip's column and its legend would be empty. */
const anyBands = computed(() => measured.value.some((instrument) => instrument.bands.length > 0));
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
/*
 * Name, Retired, imagery, Res, Bands. Every line is a subgrid of one grid, so a column is
 * as wide as its widest entry on any line, and an empty one takes no room: the full names
 * all end where the widest thing to their right begins.
 */
.table {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto auto;
}

.instrument,
.instrument__line {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  align-items: center;
}

.instrument {
  border-bottom: 1px solid #ffffff10;
}

.instrument__line {
  font-size: 12.5px;
}

.instrument__toggle {
  display: grid;
  grid-column: 1 / 3;
  grid-template-columns: subgrid;
  align-items: center;
  padding: 7px 2px;
  text-align: left;
  cursor: pointer;
}

.instrument__label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
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

/* The name gives way only once the full name beside it is gone. */
.instrument__name {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instrument__full-inline {
  min-width: 0;
  flex: 1 1 0;
  overflow: hidden;
  color: var(--panel-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The panel's width, not the screen's: the open menu column narrows it on a desktop too. */
.instrumentList {
  container-type: inline-size;
}

/* A panel under 440 px, less the tab's 12 px sides: a full name would show a word or two there; the expanded line has it whole. */
@container (max-width: 415px) {
  .instrument__full-inline {
    display: none;
  }
}

.instrument__line--head {
  border-bottom: 1px solid #ffffff20;
  color: var(--panel-faint);
  font-size: 11px;
}

.instrument__line--head:hover {
  background: none;
}

/* Over the names, past the chevron. */
.instrument__head-name {
  grid-column: 1;
  padding: 4px 0 4px 26px;
}

/* Amber: the app colour for "away from rest", as on the status chip. */
.instrument__retired {
  grid-column: 2;
  flex: none;
  padding-left: 8px;
  color: var(--panel-amber);
  font-size: 11px;
}

/* 9 × 8 px and its gaps: fits beside the name on a phone. */
.bands {
  display: inline-flex;
  width: 88px;
  grid-column: 5;
  gap: 2px;
  margin: 0 4px 0 10px;
}

.bands--none {
  color: var(--panel-faint);
}

.bands__cell {
  width: 8px;
  height: 12px;
  border-radius: 2px;
  background: #ffffff12;
}

.instrument__resolution {
  grid-column: 4;
  padding-left: 8px;
  text-align: right;
  color: var(--panel-muted);
  font-variant-numeric: tabular-nums;
}

/* 32 px: a finger's target on the phone. */
.instrument__imagery {
  display: grid;
  width: 32px;
  height: 32px;
  grid-column: 3;
  place-items: center;
  border-radius: 4px;
  color: var(--panel-accent);
}

button.instrument__imagery {
  cursor: pointer;
}

.instrument__more {
  grid-column: 1 / -1;
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

.folded {
  margin-top: 12px;
}

.folded__title {
  margin-bottom: 4px;
  color: var(--panel-faint);
  font-size: 11px;
}

.folded__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border: 1px solid #ffffff2b;
  border-radius: 999px;
  color: #edffffdd;
  font-size: 12px;
  cursor: pointer;
}

.chip .instrument__retired {
  padding-left: 0;
}

.chip:hover,
.chip--open {
  border-color: #ffffff70;
  background: #ffffff14;
}

.folded__more {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #ffffff08;
  font-size: 12px;
}

.folded__name {
  font-weight: 600;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 8px;
  color: var(--panel-faint);
  font-size: 10.5px;
}

.legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 3px;
  border-radius: 2px;
}

dd {
  margin: 0;
}
</style>
