<template>
  <div class="satellite-select">
    <div class="toolbarTitle">
      Enabled satellite groups
    </div>
    <div class="toolbarContent">
      <vue-multiselect
        v-model="enabledTags"
        :options="availableTags"
        :multiple="true"
        :searchable="false"
        placeholder="0 satellite groups selected"
      />
    </div>
    <div class="toolbarTitle">
      Enabled satellites
    </div>
    <div class="toolbarContent">
      <vue-multiselect
        v-model="allEnabledSatellites"
        :options="availableSatellites"
        :multiple="true"
        group-values="sats"
        group-label="tag"
        :group-select="true"
        placeholder="Type to search"
        :close-on-select="false"
        :limit="0"
        :limit-text="count => `${count} satellite${ count > 1 ? 's' : '' } selected`"
        :options-limit="100000"
      >
        <template #noResult>
          No matching satellites
        </template>
      </vue-multiselect>
    </div>
  </div>
</template>

<script>
import VueMultiselect from "vue-multiselect";
import { mapWritableState } from "pinia";

import { useSatStore } from "../stores/sat";

export default {
  components: {
    VueMultiselect,
  },
  data() {
    return {
    };
  },
  computed: {
    ...mapWritableState(useSatStore, [
      "availableSatellitesByTag",
      "availableTags",
      "enabledSatellites",
      "enabledTags",
      "trackedSatellite",
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
    enabledSatellites(sats) {
      cc.sats.enabledSatellites = sats;
    },
    enabledTags(tags) {
      cc.sats.enabledTags = tags;
    },
    trackedSatellite(satellite) {
      cc.sats.trackedSatellite = satellite;
    },
  },
  methods: {
    getSatellitesFromTags(taglist) {
      return taglist.map((tag) => this.availableSatellitesByTag[tag] || []).flat();
    },
  },
};
</script>

<style scoped>
.satellite-select {
  width: 300px;
}
</style>

<style>
@import "vue-multiselect/dist/vue-multiselect.css";

.multiselect__single {
  display: none;
}
</style>
