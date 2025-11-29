<template>
  <div class="app">
    <toast position="bottom-right">
      <template #message="slotProps">
        <div class="toast-content">
          <div class="toast-text">
            <div class="toast-summary">{{ slotProps.message.summary }}</div>
            <div class="toast-detail">{{ slotProps.message.detail }}</div>
          </div>
          <button v-if="slotProps.message.data?.action" class="toast-action-btn" @click="slotProps.message.data.action()">
            {{ slotProps.message.data.actionLabel }}
          </button>
        </div>
      </template>
    </toast>
    <router-view />
  </div>
</template>

<script>
import "@cesium/widgets/Source/widgets.css";
import "./css/main.css";
import Toast from "primevue/toast";
import { useToast } from "primevue/usetoast";
import { onMounted } from "vue";
import { initToastProxy } from "./composables/useToastProxy";

export default {
  components: {
    Toast,
  },
  setup() {
    const toast = useToast();

    onMounted(() => {
      // Initialize toast utility for non-Vue contexts
      initToastProxy(toast);
    });
  },
};
</script>

<style scoped>
.toast-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.toast-summary {
  font-weight: bold;
}

.toast-detail {
  font-size: 0.9em;
}

.toast-action-btn {
  align-self: flex-end;
  padding: 4px 12px;
  background-color: #4dabf7;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.toast-action-btn:hover {
  background-color: #339af0;
}
</style>
