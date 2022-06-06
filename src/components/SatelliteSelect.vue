<template>
  <div class="satellite-select">
    <div class="toolbarTitle">
      Enabled satellite groups
    </div>
    <div class="toolbarContent">
      <multiselect
        v-model="enabledTags"
        mode="tags"
        :options="availableTags"
        :close-on-select="false"
        :hide-selected="false"
        :searchable="true"
        class="multiselect-dark"
      />
    </div>
    <div class="toolbarTitle">
      Enabled satellites
    </div>
    <div class="toolbarContent">
      <multiselect
        v-model="allEnabledSatellites"
        mode="multiple"
        :options="availableSatellites"
        group-label="tag"
        group-options="sats"
        :groups="true"
        :close-on-select="false"
        :hide-selected="false"
        :searchable="true"
        class="multiselect-dark"
      />
    </div>
  </div>
</template>

<script>
import Multiselect from "@vueform/multiselect";
import { mapWritableState } from "pinia";

import { useSatStore } from "../stores/sat";

export default {
  components: {
    Multiselect,
  },
  data() {
    return {
    };
  },
  computed: {
    ...mapWritableState(useSatStore, [
      "availableTags",
      "availableSatellitesByTag",
      "enabledTags",
      "enabledSatellites",
    ]),
    availableSatellites() {
      let satlist = Object.keys(this.availableSatellitesByTag).map((tag) => ({
        tag,
        sats: this.availableSatellitesByTag[tag],
      }));
      if (satlist.length === 0) {
        satlist = [];
      }
      return satlist;
    },
    satellitesEnabledByTag() {
      return this.getSatellitesFromTags(this.enabledTags);
    },
    allEnabledSatellites: {
      get() {
        return this.satellitesEnabledByTag.concat(this.enabledSatellites ?? []);
      },
      set(sats) {
        const enabledTags = this.availableTags.filter((tag) => !this.availableSatellitesByTag[tag].some((sat) => !sats.includes(sat)));
        const satellitesInEnabledTags = this.getSatellitesFromTags(enabledTags);
        const enabledSatellites = sats.filter((sat) => !satellitesInEnabledTags.includes(sat));
        cc.sats.enabledSatellites = enabledSatellites;
        cc.sats.enabledTags = enabledTags;
      },
    },
  },
  watch: {
    enabledTags(newTags) {
      cc.sats.enabledTags = newTags;
    },
  },
  methods: {
    getSatellitesFromTags(taglist) {
      return taglist.map((tag) => this.availableSatellitesByTag[tag] || []).flat();
    },
  },
};
</script>

<style>
@import "@vueform/multiselect/themes/default.css";

.multiselect-dark {
  color: #50596c;
  --ms-max-height: 15rem;
}
</style>
<style scoped>
.satellite-select {
  width: 300px;
}
</style>
