<!-- A panel opened from the menu column: its name, a close button, and the controls. -->
<template>
  <section class="toolbarSwitches toolbarPanel" :class="wide ? 'toolbarPanel--wide' : 'toolbarPanel--fixed'" :aria-label="title">
    <header class="toolbarPanel__header">
      <span>{{ title }}</span>
      <button type="button" class="toolbarPanel__close" aria-label="Close panel" @click="emit('close')"><UIcon name="lucide:x" /></button>
    </header>
    <div class="toolbarPanel__body"><slot /></div>
  </section>
</template>

<script setup lang="ts">
/** A `wide` panel sizes itself; the rest share one width. */
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<style scoped>
.toolbarPanel {
  padding-bottom: 4px;
}

.toolbarPanel--fixed {
  box-sizing: border-box;
  width: min(240px, var(--toolbar-panel-max));
  max-height: calc(100dvh - 140px);
  padding: 0 6px 6px;
}

/* The body scrolls, not the panel, so the title and close button stay in view. */
.toolbarPanel__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.toolbarPanel--fixed .toolbarPanel__body {
  overflow-y: auto;
}

.toolbarPanel--fixed :deep(.toolbarSwitch) {
  padding-right: 12px;
}

/* 32px with the divider, level with the divider under the Menu row. */
.toolbarPanel__header {
  flex: none;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 32px;
  margin-bottom: 4px;
  padding-left: 4px;
  border-bottom: 1px solid #ffffff1f;
  font-size: 15px;
  font-weight: 600;
}

.toolbarPanel--wide .toolbarPanel__header {
  margin: 0 6px 6px;
}

/* The divider already spaces a first section. */
.toolbarPanel__body > :deep(.toolbarTitle:first-child) {
  margin-top: 4px;
}

.toolbarPanel__close {
  display: inline-flex;
  padding: 4px;
  background: none;
  border: none;
  border-radius: 6px;
  color: #edffff;
  cursor: pointer;
}

.toolbarPanel__close:focus-visible {
  outline: 2px solid #7fd2ea;
  outline-offset: -2px;
}

@media (hover: hover) {
  .toolbarPanel__close:hover {
    background: #ffffff14;
  }
}
</style>
