<template>
  <div class="wrapper">
    <multiSelect
      v-model="values"
      search
      history-button
      :filters="filters"
      :options="options"
      :select-options="data"
      :btn-label="btnLabel"
    />
    <input
      type="button"
      @click="update"
    >
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
      btnLabel: "Monitored satellites",
      values: [],
      data: cc.sats.satlist,
      filters: [{
        nameAll: "Select all",
        nameNotAll: "Deselect all",
        func() {
          return true;
        },
      }],
      options: {
        multi: true,
        groups: true,
      },
    };
  },
  watch: {
    values: function(newSats, oldSats) {
      if (newSats.length === 0 && oldSats.length === 0) {
        return;
      }
      cc.sats.monitoredSatellites = newSats;
    }
  },
  methods: {
    update: function() {
      this.data = cc.sats.satlist;
      this.values = cc.sats.monitoredSatellites;
    },
  }
};
</script>
