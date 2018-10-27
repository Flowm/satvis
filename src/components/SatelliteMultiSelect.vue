<template>
  <div class="wrapper">
    <input type="button" @click="update" />
    <multi-select
    v-model="values"
    search
    historyButton
    :filters="filters"
    :options="options"
    :selectOptions="data"
    :btnLabel="btnLabel"
    />
  </div>
</template>

<script>
/*global cc*/
import multiSelect from "vue-multi-select";
import "vue-multi-select/dist/lib/vue-multi-select.min.css";

export default {
  components: {
    multiSelect,
  },
  data() {
    return {
      btnLabel: "Enabled satellites",
      values: [],
      data: cc.sats.satlist,
      filters: [{
          nameAll: 'Select all',
          nameNotAll: 'Deselect all',
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
      cc.sats.enabledSatellites = newSats;
    }
  },
  methods: {
    update: function() {
      this.data = cc.sats.satlist;
      this.values = cc.sats.enabledSatellites;
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
