<!-- The globe's right-click and long-press menu: a station added or looked up from where the click fell, or the station clicked on looked up from or removed. -->
<template>
  <UDropdownMenu v-model:open="open" :items="items" :modal="false" :content="MENU_CONTENT" :ui="MENU_UI" :size="MENU_SIZE">
    <!-- The menu's anchor, where the click or the finger fell. -->
    <span class="globeMenu__anchor" :style="{ left: `${anchor.x}px`, top: `${anchor.y}px` }"></span>
  </UDropdownMenu>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { computed, onBeforeUnmount, ref } from "vue";

import { useController } from "@/composables/useController";
import type { GlobeMenuPlace } from "@/modules/CesiumController";
import { stationLabel } from "@/modules/GroundStationEntity";
import { DeviceDetect } from "@/modules/util/DeviceDetect";
import { formatCoordinates } from "@/modules/util/formats";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

/** Below and right of the click, as a browser's own menu opens; flipped where it would leave the page. */
const MENU_CONTENT = { side: "bottom", align: "start", sideOffset: 2 } as const;
/** BookmarkCard's surface, and `dark`, as the menu is portalled out of `#app`. */
const MENU_UI = { content: "dark bg-(--panel-surface)/95 text-(--panel-ink) ring-white/10" };
const MENU_SIZE = DeviceDetect.hasTouch() ? "xl" : "md";

const emit = defineEmits<{
  /** As it opens, which for a held finger is before it lifts. */
  open: [];
}>();

const cc = useController();
const satStore = useSatStore();
const cesiumStore = useCesiumStore();

const open = ref(false);
const place = ref<GlobeMenuPlace>();
/** In page pixels. */
const anchor = ref({ x: 0, y: 0 });

cc.onGlobeMenu((next) => {
  const canvas = cc.viewer.scene.canvas.getBoundingClientRect();
  anchor.value = { x: canvas.left + next.x, y: canvas.top + next.y };
  place.value = next;
  open.value = true;
  emit("open");
});

// Non-modal, so the globe stays live under it: a second right click moves it, and moving the globe closes it.
const removeMoveListener = cc.viewer.camera.moveStart.addEventListener(() => {
  open.value = false;
});
onBeforeUnmount(removeMoveListener);

/** As Pick on globe places one, which it then ends. */
function addStation(lat: number, lon: number): void {
  satStore.addGroundStation({ lat, lon });
  cesiumStore.pickMode = false;
}

function lookUpFrom(index: number): void {
  satStore.setObserverStation(index);
  cesiumStore.enterSkyView();
}

const items = computed<DropdownMenuItem[][]>(() => {
  const at = place.value;
  if (!at) {
    return [];
  }
  if ("station" in at) {
    const { station: index } = at;
    const station = satStore.groundStations[index];
    if (!station) {
      return [];
    }
    return [
      [{ type: "label", label: stationLabel(station.name, station.lat, station.lon) }],
      [
        { label: "Look up from here", icon: "lucide:telescope", onSelect: () => lookUpFrom(index) },
        { label: "Remove ground station", icon: "lucide:trash-2", color: "error", onSelect: () => satStore.removeGroundStation(index) },
      ],
    ];
  }
  const { lat, lon } = at;
  return [
    [{ type: "label", label: formatCoordinates(lat, lon) }],
    [
      { label: "Add ground station here", icon: "lucide:map-pin-plus", onSelect: () => addStation(lat, lon) },
      {
        label: "Look up from here",
        icon: "lucide:telescope",
        onSelect: () => {
          satStore.observeNewStation({ lat, lon });
          cesiumStore.enterSkyView();
        },
      },
    ],
  ];
});
</script>

<style scoped>
.globeMenu__anchor {
  position: fixed;
  width: 0;
  height: 0;
  pointer-events: none;
}
</style>
