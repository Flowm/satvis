<!-- The header and the position strip are always visible; the orbit, the spacecraft and
     the passes are tabs, because stacking them overflowed a 500 px window by almost 900 px. -->
<template>
  <div v-if="selection" class="entity-info-panel">
    <UCard :ui="{ root: 'bg-[#303336]/95 text-[#edffff] divide-neutral-600', header: 'p-2 sm:px-3', body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="head">
          <div class="head__title">
            <span v-if="orbitClass" class="dot" :style="{ background: orbitColor }" :title="orbitClass" />
            <input
              v-if="renaming"
              ref="renameEl"
              v-model="draftName"
              class="head__rename"
              type="text"
              placeholder="unnamed"
              aria-label="Station name"
              @keydown.enter="commitRename"
              @keydown.esc="cancelRename"
              @blur="commitRename"
            />
            <span v-else class="head__name">{{ name }}</span>
            <UTooltip v-if="canRename" :text="renaming ? 'Done' : 'Rename'">
              <!-- mousedown.prevent keeps focus in the input, so a press commits once via the click, not also via the blur. -->
              <UButton
                :icon="renaming ? 'i-lucide-check' : 'i-lucide-pencil'"
                variant="ghost"
                color="neutral"
                size="xs"
                :aria-label="renaming ? 'Finish renaming' : 'Rename station'"
                @mousedown.prevent
                @click="toggleRename"
              />
            </UTooltip>
            <span class="head__id">{{ satnum ? `#${satnum}` : "" }}</span>
            <UTooltip text="Notify for upcoming passes">
              <UButton icon="i-lucide-bell" variant="ghost" color="neutral" size="xs" aria-label="Notify for upcoming passes" @click="notifyPasses" />
            </UTooltip>
            <UTooltip v-if="canEnterSkyView" text="View the sky from here">
              <UButton icon="i-lucide-telescope" variant="ghost" color="neutral" size="xs" aria-label="View the sky from this ground station" @click="enterSkyView" />
            </UTooltip>
            <!-- Hidden, not disabled, in the sky view: that view owns the camera. -->
            <UTooltip v-if="!inSkyView" :text="isTracked ? 'Stop tracking' : 'Track entity'">
              <UButton icon="i-lucide-video" variant="ghost" :color="isTracked ? 'primary' : 'neutral'" size="xs" aria-label="Track entity" @click="toggleTrack" />
            </UTooltip>
            <UButton icon="i-lucide-x" variant="ghost" color="neutral" size="xs" aria-label="Close" @click="deselect" />
          </div>
          <div v-if="chips.length > 0" class="head__chips">
            <span v-for="chip in chips" :key="chip">{{ chip }}</span>
          </div>
        </div>
      </template>

      <div v-if="liveRows.length > 0" class="strip">
        <span v-for="row in liveRows" :key="row.label" class="strip__cell">
          <span class="strip__label">{{ row.label.slice(0, 3) }}</span>
          <span class="strip__value">{{ row.value }}</span>
        </span>
      </div>

      <div v-if="staleNotice" class="stale" title="Only the latest element set is kept, so positions far from its epoch drift by kilometres to thousands of kilometres.">
        <UIcon name="i-lucide-triangle-alert" class="stale__icon" />
        <span>{{ staleNotice }}</span>
      </div>

      <!-- The tab row shows even with one tab: pressing it folds the body.
           `min-h-8` reserves the height of a badged trigger, so the row does not grow when the pass count arrives. -->
      <UTabs
        v-model="activeTab"
        :items="tabs"
        variant="link"
        size="sm"
        :ui="{
          root: 'gap-0',
          list: 'px-2 border-y border-neutral-600',
          trigger: 'min-h-8',
          content: collapsed ? 'hidden' : 'px-3 pb-3 info-body',
        }"
      >
        <template #passes>
          <div class="tab-body__pad">
            <template v-if="!passesPending && hasAnyPasses">
              <div v-if="nextPass" class="hero" :class="{ 'hero--live': isOngoing }">
                <div class="hero__label">
                  {{ isOngoing ? "Overhead now" : "Next pass" }}
                  <span v-if="nextPassSubject">· {{ nextPassSubject }}</span>
                </div>
                <div class="hero__value">{{ formatCountdown(nowMs, nextPass) }}</div>
                <div class="hero__meta">{{ passSummary(nextPass) }}</div>
                <div v-if="isOngoing" class="hero__progress"><span :style="{ width: `${ongoingFraction * 100}%` }" /></div>
              </div>

              <pass-timeline v-if="showTimeline" :passes="passes" :now-ms="nowMs" :mode="overpassMode" :picked="pickedPassMs" @pick="pickPass" />
            </template>

            <!-- Outside the empty branches: swath mode can empty the list, and the switch back must stay reachable. -->
            <div class="passes__bar">
              <div class="modes" role="group" aria-label="Overpass calculation">
                <button
                  v-for="option in OVERPASS_MODES"
                  :key="option.value"
                  type="button"
                  class="modes__option"
                  :class="{ 'modes__option--on': overpassMode === option.value }"
                  :aria-pressed="overpassMode === option.value"
                  @click="overpassMode = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
              <USwitch v-model="showPastPasses" label="Past" size="xs" />
            </div>

            <div v-if="passesPending" class="empty">Computing passes…</div>
            <div v-else-if="!hasAnyPasses" class="empty">{{ emptyPassText }}</div>
            <div v-else-if="passRows.length === 0" class="empty">No upcoming passes</div>
            <table v-else ref="tableEl" class="info-table">
              <thead>
                <tr>
                  <th v-if="subjectCount > 1">{{ selection.kind === "groundstation" ? "Satellite" : "Station" }}</th>
                  <th>In</th>
                  <th>Start</th>
                  <th>End</th>
                  <th class="num">{{ overpassMode === "swath" ? "Dist" : "El" }}</th>
                  <th class="num">{{ overpassMode === "swath" ? "Swath" : "Az" }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in passRows"
                  :key="row.key"
                  :data-start-ms="row.startMs"
                  :class="{ 'is-next': row.startMs === nextPass?.start, 'is-picked': row.startMs === pickedPassMs }"
                >
                  <td v-if="subjectCount > 1">{{ row.name }}</td>
                  <td class="mono">{{ row.countdown }}</td>
                  <td>
                    <a class="link" @click="cc.setTime(row.startMs)">{{ row.startLabel }}</a>
                  </td>
                  <td>{{ row.endLabel }}</td>
                  <td class="num">{{ row.primary }}</td>
                  <td class="num">{{ row.secondary }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template #orbit>
          <div class="tab-body__pad">
            <table v-if="satelliteInfo" class="info-table info-table--facts">
              <tbody>
                <tr v-for="[label, value] in satelliteInfo.orbitRows" :key="label">
                  <th>{{ label }}</th>
                  <td class="right">{{ value }}</td>
                </tr>
              </tbody>
            </table>

            <template v-if="elements">
              <div class="section">{{ elements.kind === "tle" ? "TLE" : "Elements" }} · epoch {{ elements.epoch }}</div>
              <pre v-if="elements.kind === 'tle'" class="info-code"><code>{{ elements.lines }}</code></pre>
              <table v-else class="info-table info-table--facts">
                <tbody>
                  <tr v-for="[label, value] in elements.rows" :key="label">
                    <th>{{ label }}</th>
                    <td class="right mono">{{ value }}</td>
                  </tr>
                </tbody>
              </table>
            </template>
          </div>
        </template>

        <template #spacecraft>
          <div class="tab-body__pad">
            <satellite-model-view v-if="modelFile && !collapsed" :model-file="modelFile" :name="name" />

            <table v-if="spacecraftRows.length > 0" class="info-table info-table--facts" :class="{ 'info-table--below-model': modelFile }">
              <tbody>
                <tr v-for="[label, value] in spacecraftRows" :key="label">
                  <th>{{ label }}</th>
                  <td class="right">{{ value }}</td>
                </tr>
              </tbody>
            </table>

            <template v-if="links.length > 0">
              <div class="section">Links</div>
              <div class="links">
                <a v-for="link in links" :key="link.label" class="links__item" :href="link.href" :title="link.title" target="_blank" rel="noopener">{{ link.label }}</a>
              </div>
            </template>
          </div>
        </template>
      </UTabs>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "@nuxt/ui/composables/useToast";
import dayjs from "dayjs";
import { storeToRefs } from "pinia";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";

import { useController } from "../composables/useController";
import { useSelectedEntity } from "../composables/useSelectedEntity";
import { externalLinks } from "../config/externalLinks";
import { ORBIT_CLASS_COLOR } from "../config/orbitClass";
import { SKY_MODE } from "../config/viewModes";
import { formatCountdown, passSummary, type Pass } from "../modules/PassPredictor";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import PassTimeline from "./PassTimeline.vue";
import SatelliteModelView from "./SatelliteModelView.vue";

const cc = useController();
const toast = useToast();

const {
  selection,
  isTracked,
  name,
  position,
  passRows,
  passes,
  nextPass,
  subjectCount,
  nowMs,
  hasAnyPasses,
  passesPending,
  showPastPasses,
  pickedPassMs,
  pickPass,
  preferredTab,
  groundStationAvailable,
  elements,
  staleNotice,
  satelliteInfo,
  canEnterSkyView,
  enterSkyView,
  deselect,
  toggleTrack,
} = useSelectedEntity(cc);

const satStore = useSatStore();
const { overpassMode } = storeToRefs(satStore);
const { sceneMode } = storeToRefs(useCesiumStore());
const inSkyView = computed(() => sceneMode.value === SKY_MODE);
const OVERPASS_MODES = [
  { value: "elevation", label: "Elevation" },
  { value: "swath", label: "Swath" },
] as const;

const emptyPassText = computed(() => (groundStationAvailable.value ? "No passes in the prediction window" : "No ground station set"));

const satnum = computed(() => (selection.value?.kind === "satellite" ? selection.value.sat.props.satnum : undefined));
const links = computed(() => (satnum.value ? externalLinks(satnum.value) : []));
const spacecraftRows = computed(() => satelliteInfo.value?.spacecraftRows ?? []);
/** Only satellites a model manifest lists have one (ADR 0007). */
const modelFile = computed(() => (selection.value?.kind === "satellite" ? selection.value.sat.props.metadata.modelFile : undefined));

const orbitClass = computed(() => satelliteInfo.value?.orbitClass);
const orbitColor = computed(() => (orbitClass.value ? ORBIT_CLASS_COLOR[orbitClass.value] : "transparent"));
const chips = computed(() => satelliteInfo.value?.chips ?? []);

/** The card title already carries the name. */
const liveRows = computed(() => position.value.filter((row) => row.label !== "Name"));

const isOngoing = computed(() => !!nextPass.value && nextPass.value.start <= nowMs.value);
const ongoingFraction = computed(() => {
  const pass = nextPass.value;
  if (!pass || pass.end <= pass.start) {
    return 0;
  }
  return Math.min(1, Math.max(0, (nowMs.value - pass.start) / (pass.end - pass.start)));
});
const nextPassSubject = computed(() => (nextPass.value ? (nextPass.value.groundStationName ?? nextPass.value.name) : ""));

/** A station's passes are too dense for a timeline; see PassTimeline.vue. */
const showTimeline = computed(() => selection.value?.kind === "satellite");

const tabs = computed(() => {
  const items: { label: string; slot: string; value: string; badge?: number }[] = [];
  if (satelliteInfo.value || elements.value) {
    items.push({ label: "Orbit", slot: "orbit", value: "orbit" });
  }
  if (modelFile.value || spacecraftRows.value.length > 0 || links.value.length > 0) {
    items.push({ label: "Spacecraft", slot: "spacecraft", value: "spacecraft" });
  }
  items.push({ label: "Passes", slot: "passes", value: "passes", ...(passRows.value.length > 0 ? { badge: passRows.value.length } : {}) });
  return items;
});

/**
 * Controlled, not left to UTabs: the component is not remounted across selections,
 * and an uncontrolled UTabs keeps a tab the new selection lacks (a ground station has no Orbit).
 */
const resolvedTab = computed(() => (tabs.value.some((item) => item.value === preferredTab.value) ? preferredTab.value : (tabs.value[0]?.value ?? "passes")));

/** Pressing the active tab folds the body away; the selection stays. */
const collapsed = ref(false);

// The panel is not remounted between entities, so a new selection unfolds it here.
watch(selection, () => {
  collapsed.value = false;
});

const activeTab = computed({
  get: () => resolvedTab.value,
  set: (value: string) => {
    // Reka's trigger sets the model on every press, so a press on the active tab arrives as its own value.
    if (value === resolvedTab.value) {
      collapsed.value = !collapsed.value;
      return;
    }
    collapsed.value = false;
    preferredTab.value = value;
  },
});

const tableEl = useTemplateRef<HTMLTableElement>("tableEl");
watch(pickedPassMs, (startMs) => {
  if (startMs === null) {
    return;
  }
  // Wait for the row's class, so `nearest` measures the right element.
  nextTick(() => {
    tableEl.value?.querySelector(`tr[data-start-ms="${startMs}"]`)?.scrollIntoView({ block: "nearest" });
  });
});

const canRename = computed(() => selection.value?.kind === "groundstation");
const renaming = ref(false);
const renameEl = useTemplateRef<HTMLInputElement>("renameEl");
/**
 * Local, not bound to the station: Vue patches `:value` against the live DOM value,
 * so a bound input loses the typing on every one-second refresh. Seeded from
 * `givenName`, because the displayed fallback (coordinates) has a comma that `wireSafeName` refuses.
 */
const draftName = ref("");

watch(selection, () => {
  renaming.value = false;
});

function toggleRename(): void {
  if (renaming.value) {
    commitRename();
    return;
  }
  draftName.value = selection.value?.kind === "groundstation" ? selection.value.gs.givenName : "";
  renaming.value = true;
  // Select after the input mounts, so typing replaces the name.
  nextTick(() => renameEl.value?.select());
}

function cancelRename(): void {
  renaming.value = false;
}

/**
 * Blur commits as well as Enter. The `renaming` guard stops the blur that fires when
 * Escape unmounts the input from committing. Matched by list position, not by the old name.
 */
function commitRename(): void {
  if (!renaming.value) {
    return;
  }
  renaming.value = false;
  const sel = selection.value;
  if (sel?.kind !== "groundstation") {
    return;
  }
  const { index } = sel.gs;
  satStore.renameGroundStation(index, draftName.value);
  // The write rebuilds every station entity and drops the selection; re-select the replacement.
  nextTick(() => cc.sats.groundStations[index]?.select());
}

function notifyForPass(pass: Pass, aheadMin = 5): void {
  const start = dayjs(pass.start).startOf("second");
  cc.pm.notifyAtDate(start.subtract(aheadMin, "minute").toDate(), `${pass.name} pass in ${aheadMin} minutes`);
  cc.pm.notifyAtDate(start.toDate(), `${pass.name} pass starting now`);
}

function notifyPasses(): void {
  if (!cc.sats.groundStationAvailable) {
    toast.add({
      color: "warning",
      title: "Warning",
      description: "Ground station required to notify for passes",
      duration: 3000,
    });
    return;
  }
  let upcoming: Pass[] = [];
  if (selection.value?.kind === "satellite") {
    upcoming = selection.value.sat.props.passPredictor.passes(cc.viewer.clock.currentTime);
  } else if (selection.value?.kind === "groundstation") {
    upcoming = selection.value.gs.passes(cc.viewer.clock.currentTime);
  }
  if (upcoming.length === 0) {
    toast.add({
      color: "info",
      title: "Info",
      description: "No passes available",
      duration: 3000,
    });
    return;
  }
  upcoming.forEach((pass) => notifyForPass(pass));
  toast.add({
    color: "success",
    title: "Success",
    description: `Notifying for ${upcoming.length} passes`,
    duration: 3000,
  });
}
</script>

<style scoped>
/* The width loses both side insets, or the card overflows beside a landscape notch. */
.entity-info-panel {
  position: absolute;
  /* 18px: the toolbars' 5px offset and 2px margin, and an 11px gap below the row. */
  top: calc(18px + var(--toolbar-row) + var(--safe-top, 0px));
  right: calc(5px + var(--safe-right, 0px));
  width: calc(100% - 10px - var(--safe-left, 0px) - var(--safe-right, 0px));
  max-width: 540px;
  z-index: 5;
  font-size: 14px;
  /* The body turns selection off for the globe; the name, position and facts are worth copying. Safari needs the prefix. */
  -webkit-user-select: text;
  user-select: text;
}

/* A long press on a tab would select its label. */
.entity-info-panel :deep([role="tablist"]) {
  -webkit-user-select: none;
  user-select: none;
}

/* dvh, not vh: an installed iOS app reports vh as the full screen, taller than the viewport it paints. */
.entity-info-panel :deep(.info-body) {
  max-height: min(520px, 58dvh);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.head__title {
  display: flex;
  align-items: center;
  gap: 4px;
}

.head__name {
  overflow: hidden;
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Matches .head__name, so entering edit mode moves nothing. */
.head__rename {
  min-width: 0;
  flex: 1;
  padding: 0 4px;
  border: 1px solid #ffffff40;
  border-radius: 3px;
  background: #0000004d;
  color: inherit;
  font-size: 16px;
  font-weight: 600;
}

/* Takes the slack even when there is no catalog number. */
.head__id {
  flex-grow: 1;
  color: #edffff70;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 999px;
}

.head__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding-left: 2px;
  color: #edffffb0;
  font-size: 11px;
}

.head__chips span:not(:last-child)::after {
  margin-left: 6px;
  color: #edffff60;
  content: "·";
}

.strip {
  display: flex;
  gap: 1px;
  background: #ffffff14;
}

.strip__cell {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  padding: 5px 10px;
  background: #ffffff08;
}

.strip__label {
  color: #edffff80;
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.strip__value {
  overflow: hidden;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Amber: the app colour for "away from rest", as on the clock's reset. */
.stale {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #ffd47914;
  color: #ffd479;
  font-size: 11px;
}

.stale__icon {
  flex-shrink: 0;
}

.hero {
  margin-bottom: 10px;
  padding: 8px 10px 10px;
  border-radius: 4px;
  background: linear-gradient(180deg, #4caf5024, #4caf5008);
}

.hero--live {
  background: linear-gradient(180deg, #56b4e930, #56b4e910);
}

.hero__label {
  color: #edffffb0;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.hero__value {
  font-size: 34px;
  font-variant-numeric: tabular-nums;
  font-weight: 300;
  line-height: 1.1;
}

.hero__meta {
  margin-top: 2px;
  color: #edffffcc;
  font-size: 12.5px;
}

.hero__progress {
  margin-top: 8px;
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: #ffffff20;
}

.hero__progress span {
  display: block;
  height: 100%;
  background: #56b4e9;
}

/* Here, not on the scroll container, so the sticky table header pins flush and rows do not show above it. */
.tab-body__pad {
  padding-top: 12px;
}

/* A pair rather than a switch: "Swath: off" is not what the other mode is called. */
.modes {
  display: flex;
  overflow: hidden;
  border: 1px solid #ffffff2b;
  border-radius: 999px;
}

.modes__option {
  padding: 1px 8px;
  cursor: pointer;
  color: #edffff90;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.modes__option:hover {
  color: #edffff;
}

.modes__option--on {
  background: #4caf5033;
  color: #edffff;
}

.passes__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 8px 0 6px;
  color: #edffff90;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.section {
  margin: 12px 0 5px;
  color: #edffff90;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.info-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.info-table th,
.info-table td {
  padding: 3px 6px;
  text-align: left;
}

.info-table tbody tr:nth-child(odd) {
  background: #ffffff08;
}

.info-table--below-model {
  margin-top: 10px;
}

.info-table--facts tbody th {
  color: #edffffb0;
  font-weight: 400;
}

.info-table thead th {
  position: sticky;
  top: 0;
  background: #383b3e;
  color: #edffffb0;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.info-table tbody tr.is-next {
  box-shadow: inset 3px 0 #4caf50;
}

.info-table tbody tr.is-picked {
  background: #edffff1f;
  box-shadow: inset -3px 0 #edffff;
}

.info-table tbody tr.is-picked.is-next {
  box-shadow:
    inset 3px 0 #4caf50,
    inset -3px 0 #edffff;
}

.num,
.right {
  text-align: right !important;
}

.mono {
  font-variant-numeric: tabular-nums;
}

.link {
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.links__item {
  padding: 2px 7px;
  border: 1px solid #ffffff2b;
  border-radius: 999px;
  color: #edffffdd;
  font-size: 11.5px;
}

.links__item:hover {
  border-color: #ffffff70;
  background: #ffffff14;
  color: #ffffff;
}

.info-code {
  margin: 0;
  padding: 4px;
  overflow-x: auto;
  background: #26262699;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.empty {
  padding: 10px 0;
  color: #edffffb0;
  text-align: center;
  font-size: 13px;
}
</style>
