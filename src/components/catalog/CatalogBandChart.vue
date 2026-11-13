<!-- Satellites per waveband class, in wavelength order under the four spectral regions; a click picks a band. -->
<template>
  <div class="bandChart">
    <div class="cs-tileHead">
      <UIcon name="lucide:audio-waveform" class="cs-mute" /> Bands
      <span class="cs-headEnd">
        <button v-if="picked.size" type="button" class="cs-reset" @click="emit('clear')">reset</button>
      </span>
    </div>
    <div class="bandChart__stats cs-dim">
      <span>Satellites whose instruments sense in each band, as CEOS classes them</span>
    </div>
    <div class="bandChart__regions">
      <div v-for="region in regions" :key="region.name" class="bandChart__region" :style="{ flexGrow: region.bands.length }">
        <div class="bandChart__bars" :style="{ height: `${height}px` }">
          <button
            v-for="band in region.bands"
            :key="band.name"
            type="button"
            class="bandChart__band"
            :class="{ 'bandChart__band--picked': picked.has(band.name), 'bandChart__band--dimmed': picked.size > 0 && !picked.has(band.name) }"
            :style="{ '--band': band.color }"
            :title="`${band.name}: ${formatInteger(band.count)}`"
            :aria-pressed="picked.has(band.name)"
            @click="emit('toggle', band.name)"
          >
            <span class="bandChart__count cs-num">{{ band.count ? formatInteger(band.count) : "" }}</span>
            <span class="bandChart__bar" :style="{ height: `${(Math.sqrt(band.count) / max) * 100}%` }" />
            <span class="bandChart__name">{{ band.name.replace("-Band", "") }}</span>
          </button>
        </div>
        <div class="bandChart__regionName cs-mute">{{ region.name }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { type Waveband, WAVEBANDS } from "@/config/wavebands";
import { formatInteger } from "@/modules/util/formats";

const props = defineProps<{
  /** Band -> satellites, under every filter but the bands. */
  counts: Map<string, number>;
  /** The bands the filter picks. */
  picked: ReadonlySet<string>;
  /** Px, the bars' height. */
  height: number;
}>();
const emit = defineEmits<{ toggle: [band: string]; clear: [] }>();

/** The regions in wavelength order; radar is last, and a band CEOS adds later goes under it. */
const REGIONS = [...new Set(WAVEBANDS.map((waveband) => waveband.region))];
/** A band CEOS adds later takes it. */
const RADAR_COLOUR = WAVEBANDS.find((waveband) => waveband.region === "radar")!.colour;

/** The bars under each region. The optical and thermal bands always show, a radar band only where a satellite has it. */
const regions = computed(() => {
  const known = new Set(WAVEBANDS.map((waveband) => waveband.band));
  const unknown: Waveband[] = [...props.counts.keys()].filter((band) => !known.has(band)).map((band) => ({ band, region: "radar", colour: RADAR_COLOUR }));
  return REGIONS.map((name) => ({
    name,
    bands: [...WAVEBANDS, ...unknown]
      .filter((waveband) => waveband.region === name && (name !== "radar" || (props.counts.get(waveband.band) ?? 0) > 0 || props.picked.has(waveband.band)))
      .map(({ band, colour }) => ({ name: band, count: props.counts.get(band) ?? 0, color: colour })),
  })).filter((region) => region.bands.length > 0);
});
/** Square root, as the launches default to: VIS has 150 satellites, W-Band one. */
const max = computed(() => Math.max(1, ...regions.value.flatMap((region) => region.bands.map((band) => Math.sqrt(band.count)))));
</script>

<style scoped>
.bandChart {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bandChart__stats {
  font-size: 11px;
}

.bandChart__regions {
  display: flex;
  gap: 10px;
}

.bandChart__region {
  display: flex;
  flex-basis: 0;
  flex-direction: column;
  min-width: 0;
}

.bandChart__regionName {
  margin-top: 3px;
  padding-top: 2px;
  border-top: 1px solid var(--cs-line);
  font-size: 10px;
  text-align: center;
}

.bandChart__bars {
  display: flex;
  align-items: stretch;
  gap: 3px;
}

.bandChart__band {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  min-width: 0;
  gap: 2px;
  border-radius: 3px;
  cursor: pointer;
}

.bandChart__band:hover {
  background: #ffffff0d;
}

.bandChart__band:focus-visible {
  outline: 2px solid var(--panel-accent);
}

.bandChart__band--dimmed {
  opacity: 0.35;
}

.bandChart__band--picked .bandChart__name {
  color: var(--band);
  font-weight: 700;
}

.bandChart__band--picked .bandChart__bar {
  box-shadow: 0 0 0 1.5px var(--band);
}

.bandChart__bar {
  width: 100%;
  min-height: 2px;
  border-radius: 3px 3px 0 0;
  background: color-mix(in srgb, var(--band) 72%, transparent);
}

.bandChart__count {
  color: var(--cs-mute);
  font-size: 10px;
}

.bandChart__name {
  font-size: 10.5px;
  white-space: nowrap;
}
</style>
