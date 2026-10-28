<!-- A panel opened from the menu column: its name, a close button, and the controls. -->
<template>
  <section class="toolbarSwitches toolbarPanel panelSurface" :class="wide ? 'toolbarPanel--wide' : 'toolbarPanel--fixed'" :aria-label="title">
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
  background: var(--panel-glow), var(--panel-surface-dense);
}

.toolbarPanel--fixed {
  box-sizing: border-box;
  width: min(var(--panel-width), var(--toolbar-panel-max), var(--toolbar-card-max));
  max-height: calc(100dvh - 140px);
  padding: 0 6px 6px;
}

/* The body scrolls, not the panel, so the title and close button stay in view. */
.toolbarPanel__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* With the panel's own padding, the iOS app's 12 points around the cards. */
.toolbarPanel--fixed .toolbarPanel__body {
  padding: 0 6px 6px;
  overflow-y: auto;
}

/* As wide as the cards, which it stands among. */
.toolbarPanel--fixed .toolbarPanel__body > :deep(.segments) {
  margin: 0;
}

/* Rows keep their height and the body scrolls: a row's `overflow: hidden`, which cuts a long
   name short, let it shrink instead, and its mark slid off its label on a short screen. */
.toolbarPanel--fixed .toolbarPanel__body > :deep(*) {
  flex-shrink: 0;
}

/* With the divider, level with the divider under the Menu row. */
.toolbarPanel__header {
  flex: none;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: var(--toolbar-row);
  margin-bottom: 4px;
  padding-left: 4px;
  border-bottom: 1px solid var(--panel-hairline);
  font-size: var(--text-title);
  font-weight: 600;
}

.toolbarPanel--wide .toolbarPanel__header {
  margin: 0 6px 6px;
}

/* The divider already spaces a first section. */
.toolbarPanel__body > :deep(.toolbarTitle:first-child) {
  margin-top: 8px;
}

/* A card with no heading, as Components', a little further from the divider. */
.toolbarPanel__body > :deep(:is(.toolbarSwitch, .toolbarPlace):first-child) {
  margin-top: 6px;
}

/* The header's height and as wide, its icon centred. */
.toolbarPanel__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--toolbar-row);
  height: 100%;
  padding: 0;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--panel-ink);
  cursor: pointer;
}

.toolbarPanel__close:focus-visible {
  outline: 2px solid var(--panel-accent);
  outline-offset: -2px;
}

@media (hover: hover) {
  .toolbarPanel__close:hover {
    background: #ffffff14;
  }
}
</style>
