<!-- Inclination by mean altitude; dragging a box picks a region. -->
<template>
  <catalog-scatter
    icon="lucide:scatter-chart"
    title="Orbit shape"
    chart-label="Satellites by inclination and mean altitude"
    :x="INCLINATION"
    :y="ALTITUDE"
    :rows="rows"
    :bright-rows="brightRows"
    :box="box && { x: box.inclinationDeg, y: box.altitudeKm }"
    :marks="MARKS"
    :draw-under="drawSunSync"
    :height="height"
    :open="open"
    @update:box="emit('update:box', $event && { inclinationDeg: $event.x, altitudeKm: $event.y })"
    @toggle-open="emit('toggle-open')"
  />
</template>

<script setup lang="ts">
import { SUN_SYNC_COLOR } from "../../config/orbitClass";
import { type CatalogRow, formatKm, type ShapeBox } from "../../modules/catalogFacets";
import CatalogScatter, { type ScatterAxis, type ScatterScale } from "./CatalogScatter.vue";

defineProps<{
  rows: readonly CatalogRow[];
  /** The rows passing every filter but the box: drawn bright, the rest faint for context. */
  brightRows: readonly CatalogRow[];
  box: ShapeBox | null;
  /** Px, the plot's height. */
  height: number;
  open: boolean;
}>();
const emit = defineEmits<{ "update:box": [box: ShapeBox | null]; "toggle-open": [] }>();

/** Degrees; nothing in the catalog orbits beyond ~145°, and 120 spreads the polar orbits. A box to the edge reaches every retrograde orbit. */
const INCLINATION: ScatterAxis = {
  min: 0,
  max: 120,
  log: false,
  limits: [0, 180],
  ticks: () => [0, 30, 60, 90, 120],
  format: (deg) => deg.toFixed(0),
  unit: "°",
  tickUnit: "°",
  value: (row) => row.inclinationDeg,
};
/** Km on a log axis, as the LEO shells and GEO would not share a linear one: below the lowest LEO to above GEO. A short plot labels every other altitude. */
const ALTITUDE: ScatterAxis = {
  min: 150,
  max: 50_000,
  log: true,
  ticks: (px) => (px < 150 ? [200, 1000, 5000, 20_000] : [200, 500, 1000, 2000, 5000, 20_000]),
  format: formatKm,
  unit: " km",
  value: (row) => row.altitudeKm,
};
/** Labels at the altitudes GNSS and GEO crowd at. */
const MARKS = [
  { label: "GNSS", y: 20_200 },
  { label: "GEO", y: 35_786 },
];
/** GCAT's sun-sync band: LEO between 95° and 104°. */
const SUN_SYNC = { inclinationDeg: [95, 104], altitudeKm: 2000 } as const;

/** Shades the sun-sync band. */
function drawSunSync(ctx: CanvasRenderingContext2D, { x, y, height }: ScatterScale): void {
  ctx.fillStyle = `${SUN_SYNC_COLOR}14`;
  ctx.fillRect(x(SUN_SYNC.inclinationDeg[0]), y(SUN_SYNC.altitudeKm), x(SUN_SYNC.inclinationDeg[1]) - x(SUN_SYNC.inclinationDeg[0]), height - y(SUN_SYNC.altitudeKm));
}
</script>
