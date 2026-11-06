<template>
  <UApp :toaster="{ position: 'bottom-right' }">
    <div class="app">
      <router-view />
    </div>
  </UApp>
</template>

<script setup lang="ts">
import "@cesium/widgets/Source/widgets.css";
import "@/css/main.css";
import { useToast } from "@nuxt/ui/composables/useToast";
import { onMounted } from "vue";

import { initToastProxy } from "@/composables/useToastProxy";

const toast = useToast();

onMounted(() => {
  initToastProxy(toast);
});
</script>
