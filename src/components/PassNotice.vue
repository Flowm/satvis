<!-- A passes layer that is on, with the clock past its newest pass (ADR 0024): how old that is, and a way there. -->
<template>
  <div class="passNotice" title="Passes come in hours to days after they are sensed: there is none at the clock's time yet" @click.stop>
    <UIcon name="lucide:clock-alert" class="passNotice__icon" />
    <span class="passNotice__text">Newest pass {{ timeAgoInWords(newest) }}</span>
    <button type="button" class="passNotice__go" aria-label="Go to the newest pass" @click="emit('go')">
      <UIcon name="lucide:skip-back" />
      Go
    </button>
  </div>
</template>

<script setup lang="ts">
import { timeAgoInWords } from "@/modules/util/bookmarks";

defineProps<{
  /** The newest pass's start, epoch ms. */
  newest: number;
}>();

const emit = defineEmits<{ go: [] }>();
</script>

<style scoped>
/* Amber, as the clock deck's reset: away from live. One line, so it does not push the rows below. */
.passNotice {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 2px 2px 2px 8px;
  border-radius: 6px;
  background: #ffb02e14;
  color: var(--panel-amber);
  font-size: 12px;
  line-height: 24px;
  cursor: default;
}

.passNotice__icon {
  width: 14px;
  height: 14px;
}

.passNotice__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.passNotice__go {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--panel-accent) 18%, transparent);
  color: var(--panel-accent);
  font-weight: 600;
  cursor: pointer;
}

@media (hover: hover) {
  .passNotice__go:hover {
    background: color-mix(in srgb, var(--panel-accent) 30%, transparent);
  }
}

.passNotice__go:focus-visible {
  outline: 2px solid var(--panel-accent);
  outline-offset: 1px;
}
</style>
