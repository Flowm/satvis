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
import 'vue-multi-select/dist/lib/vue-multi-select.css';

export default {
  components: {
    multiSelect,
  },
  data() {
    return {
      btnLabel: values => values.length > 0 ? values[0] : 'Select...',
      values: [],
      data: cc.sats.satlist,
      options: {
        groups: true,
      },
    };
  },
  watch: {
    values: function(newSat, oldSat) {
      if (newSat.every(e => oldSat.includes(e)) && oldSat.every(e => newSat.includes(e))) {
        return;
      }
      if (newSat.length === 1) {
        cc.sats.trackedSatellite = newSat[0];
        this.$router.push({query: {...this.$route.query, sat: newSat[0]}});
      } else if (oldSat.length === 1) {
        cc.sats.trackedSatellite = "";
        let query = Object.assign({}, this.$route.query);
        delete query.sat;
        this.$router.replace({query});
      }
    }
  },
  mounted() {
    if (this.$route.query.sat) {
      cc.sats.trackedSatellite = this.$route.query.sat;
    }
    this.$root.$on("updateTracked", this.update);
  },
  beforeDestroy () {
    this.$root.$off("updateTracked", this.update);
  },
  methods: {
    update: function() {
      this.data = cc.sats.satlist;
      if (cc.sats.trackedSatellite) {
        this.values = [cc.sats.trackedSatellite];
      } else {
        this.values = [];
      }
    },
  }
};
</script>
