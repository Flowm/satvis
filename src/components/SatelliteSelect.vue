<template>
  <div class="satellite-select">
    <div class="toolbarTitle">
      Enabled satellite tags
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
      "enabledTags",
    ]),
  },
  watch: {
    enabledTags(newTags) {
      cc.sats.enabledTags = newTags;
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
