<!-- A tile heading's small segmented control: one of a few options, pressed. -->
<template>
  <span class="segments" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :aria-pressed="model === option.value"
      :aria-label="option.name"
      :title="option.hint"
      @click="model = option.value"
    >
      {{ option.label }}
    </button>
  </span>
</template>

<script setup lang="ts" generic="T extends string">
/** One option, as the heading names it. */
export interface SegmentOption<V extends string> {
  value: V;
  /** On the button. */
  label: string;
  /** The button's accessible name. */
  name: string;
  /** On hover. */
  hint: string;
}

defineProps<{
  options: readonly SegmentOption<T>[];
  /** The group, as a screen reader names it. */
  label: string;
}>();
/** The pressed option's value. */
const model = defineModel<T>({ required: true });
</script>

<style scoped>
.segments {
  display: inline-flex;
  margin-right: 2px;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px var(--cs-line);
}

.segments button {
  min-width: 22px;
  padding: 0 4px;
  border: none;
  background: none;
  color: var(--cs-mute);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  line-height: 16px;
  cursor: pointer;
}

.segments button:hover {
  color: var(--cs-text);
}

.segments button[aria-pressed="true"] {
  border-radius: 4px;
  background: #ffffff1a;
  color: var(--cs-text);
}
</style>
