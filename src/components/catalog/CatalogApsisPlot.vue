<!-- Apogee by perigee; circular orbits line the diagonal, eccentric ones stand above it. Dragging a box picks a region. -->
<template>
  <catalog-scatter
    icon="lucide:ellipse"
    title="Apogee × perigee"
    chart-label="Satellites by perigee and apogee altitude"
    :x="PERIGEE"
    :y="APOGEE"
    :rows="rows"
    :bright-rows="brightRows"
    :box="box && { x: box.perigeeKm, y: box.apogeeKm }"
    :marks="MARKS"
    :draw-under="drawCircular"
    :height="height"
    :open="open"
    @update:box="emit('update:box', $event && { perigeeKm: $event.x, apogeeKm: $event.y })"
    @toggle-open="emit('toggle-open')"
  />
</template>

<script setup lang="ts">
import { type ApsisBox, type CatalogRow, formatKm } from "../../modules/catalogFacets";
import CatalogScatter, { type ScatterAxis, type ScatterScale } from "./CatalogScatter.vue";

defineProps<{
  rows: readonly CatalogRow[];
  /** The rows passing every filter but the box: drawn bright, the rest faint for context. */
  brightRows: readonly CatalogRow[];
  box: ApsisBox | null;
  /** Px, the plot's height. */
  height: number;
  open: boolean;
}>();
const emit = defineEmits<{ "update:box": [box: ApsisBox | null]; "toggle-open": [] }>();

/** Km, both axes alike so circular orbits lie on the diagonal: below the lowest perigee, above MMS's 171,000 km apogee. */
const KM_RANGE = { min: 150, max: 200_000, log: true } as const;
/** The ticks for an axis's length in px, every other decade step where short. */
const kmTicks = (px: number) => (px < 150 ? [200, 1000, 5000, 20_000, 100_000] : [200, 500, 1000, 2000, 5000, 20_000, 100_000]);
/** The x axis. */
const PERIGEE: ScatterAxis = { ...KM_RANGE, ticks: kmTicks, format: formatKm, unit: " km", value: (row) => row.perigeeKm };
/** The y axis. */
const APOGEE: ScatterAxis = { ...KM_RANGE, ticks: kmTicks, format: formatKm, unit: " km", value: (row) => row.apogeeKm };
/** GEO on the apogee axis, and the diagonal's name in the empty half below it, where no apogee is under its perigee. */
const MARKS = [
  { label: "GEO", y: 35_786 },
  { label: "circular", x: 3000, y: 800 },
];

/** Draws the diagonal. */
function drawCircular(ctx: CanvasRenderingContext2D, { x, y }: ScatterScale): void {
  ctx.strokeStyle = "#ffffff30";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x(KM_RANGE.min), y(KM_RANGE.min));
  ctx.lineTo(x(KM_RANGE.max), y(KM_RANGE.max));
  ctx.stroke();
  ctx.setLineDash([]);
}
</script>
