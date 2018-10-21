<template>
  <div>
    <input type="button" @click="update" />
    <multi-select
    v-model="values"
    search
    :options="options"
    :selectOptions="data" />
  </div>
</template>

<script>
import multiSelect from 'vue-multi-select';
import 'vue-multi-select/dist/lib/vue-multi-select.min.css';

export default {
  data() {
    return {
      btnLabel: 'A simple vue multi select',
      name: 'first group',
      values: [],
      data: cc.sats.satlist,
      options: {
        multi: true,
        groups: true,
      },
    };
  },
  components: {
    multiSelect,
  },
  watch: {
    values: function(newSats, oldSats) {
      console.log("DIFF ", newSats, oldSats);
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
