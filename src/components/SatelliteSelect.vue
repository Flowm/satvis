<template>
  <div class="wrapper">
    <multi-select
      v-model="values"
      search
      history-button
      :options="options"
      :select-options="data"
      :btn-label="btnLabel"
    />
    <button
      class="button"
      @click="update"
    >
      <span class="icon is-small">
        <i class="fas fa-redo" />
      </span>
    </button>
  </div>
</template>

<script>
/* global cc */
import multiSelect from "vue-multi-select";
import "vue-multi-select/dist/lib/vue-multi-select.min.css";

export default {
  components: {
    multiSelect,
  },
  data() {
    return {
      btnLabel: "No tracked satellite",
      values: [],
      data: cc.sats.satlist,
      options: {
        groups: true,
      },
    };
  },
  watch: {
    values: function(newSat, oldSat) {
      if (newSat.length !== 1) {
        if (oldSat.length === 1) {
          this.$router.replace({'query': null});
        }
        return;
      }
      cc.sats.trackedSatellite = newSat[0];
      this.$router.push({query: {sat: newSat[0]}})
    }
  },
  methods: {
    update: function() {
      this.data = cc.sats.satlist;
      this.values = [cc.sats.trackedSatellite];
    },
  }
};
</script>
