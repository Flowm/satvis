<template>
  <div class="wrapper">
    <input
      type="button"
      @click="update"
    >
    <multi-select
      v-model="values"
      search
      history-button
      :options="options"
      :select-options="data"
      :btn-label="btnLabel"
    />
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
      btnLabel: "Tracked satellite",
      values: [],
      data: cc.sats.satlist,
      options: {
        groups: true,
      },
    };
  },
  watch: {
    values: function(newSat) {
      if (newSat.length !== 1) {
        return;
      }
      cc.sats.trackedSatellite = newSat[0];
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

<style lang="css">
.wrapper .select .checkboxLayer {
  min-width: 400px;
}

.wrapper .tab {
  padding: 0px;
  justify-content: space-around;
}

.wrapper .tab .tab-item span {
  color: #50596c;
}

.wrapper .select .selectItem, .selectItemDeactive {
  min-height: 0px;
}
</style>
