<!-- The button in a tile's heading that opens it large in place, or closes it again. -->
<template>
  <button
    type="button"
    class="tileToggle"
    :title="open ? 'Back to the overview' : 'Open large'"
    :aria-label="open ? `Close ${label}` : `Open ${label} large`"
    :aria-expanded="open"
  >
    <UIcon :name="open ? 'lucide:minimize-2' : 'lucide:maximize-2'" />
  </button>
</template>

<script setup lang="ts">
defineProps<{ open: boolean; label: string }>();
</script>

<style scoped>
.tileToggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--cs-mute);
  font-size: 12px;
  cursor: pointer;
}

.tileToggle:hover {
  background: #ffffff14;
  color: var(--cs-text);
}
</style>
