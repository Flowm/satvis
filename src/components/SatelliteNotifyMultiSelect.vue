<template>
  <div class="wrapper">
    <multi-select
      v-model="values"
      search
      history-button
      :filters="filters"
      :options="options"
      :select-options="data"
      :btn-label="btnLabel"
    />
    <!--
    <button
      class="button"
      @click="update"
    >
      <span class="icon is-small">
        <i class="fas fa-redo" />
      </span>
    </button>
    -->
  </div>
</template>

<script>
/* global cc */
import multiSelect from "vue-multi-select";
import "vue-multi-select/dist/lib/vue-multi-select.css";

export default {
  components: {
    multiSelect,
  },
  data() {
    return {
      btnLabel: values => `Monitored satellites (${values.length})`,
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
      if (newSats.every(e => oldSats.includes(e)) && oldSats.every(e => newSats.includes(e))) {
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
