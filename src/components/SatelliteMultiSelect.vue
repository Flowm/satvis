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
      if (newSats.every(e => oldSats.includes(e))) {
        return;
      }
      cc.sats.enabledSatellitesByName = newSats;
    }
  },
  methods: {
    update: function() {
      this.data = cc.sats.satlist;
      this.values = cc.sats.enabledSatellitesByName;
    },
  }
};
</script>

<style lang="css">
.wrapper .select .btn-select {
    width: 250px;
}

.wrapper .select .buttonLabel {
    width: 100%;
}

.wrapper .select .buttonLabel .caret {
    display: none;
}

.wrapper .select .checkboxLayer {
    width: 400px;
    max-width: calc(100vw - 20px);
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

.wrapper button {
    background-color: Transparent;
    border: none;
    color: white;
    outline: none;
    height: 100%;
}
</style>
