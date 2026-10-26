<!-- Two or three short options side by side, as the iOS app's segmented pickers. Native
     radios underneath, so the arrow keys, focus and `.check()` work as on a radio list. -->
<template>
  <div class="segments" :class="{ 'segments--disabled': disabled }" role="radiogroup" :aria-label="label" :aria-disabled="disabled || undefined">
    <label v-for="option in options" :key="option.value" class="segments__option">
      <input type="radio" :name="name" :value="option.value" :checked="model === option.value" :disabled="disabled" @change="model = option.value" />
      {{ option.label }}
    </label>
  </div>
</template>

<script setup lang="ts" generic="T extends string">
import { useId } from "vue";

/** Undefined checks no option, as the Globe panel's projections in the sky view. */
const model = defineModel<T | undefined>();
defineProps<{ label: string; options: readonly { value: T; label: string }[]; disabled?: boolean }>();

/** Groups the radios, so the arrow keys move between them. */
const name = useId();
</script>

<style scoped>
/* The Bookmarks panel's tabs: a raised track, the chosen option lifted. */
.segments {
  display: flex;
  gap: 2px;
  margin: 4px 8px 2px;
  padding: 2px;
  background: var(--panel-raised);
  border-radius: 8px;
  font-size: 13px;
}

/* Equal widths whatever the names, so the options do not shift as one is chosen. */
.segments__option {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  height: 26px;
  border-radius: 6px;
  color: var(--panel-muted);
  line-height: 26px;
  text-align: center;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    background-color 0.15s,
    color 0.15s;
}

/* The track is a row's 36px. */
@media (pointer: coarse) {
  .segments__option {
    height: 32px;
    line-height: 32px;
  }
}

.segments__option:has(input:checked) {
  background: var(--panel-selected);
  color: var(--panel-ink);
}

@media (hover: hover) {
  .segments__option:hover:not(:has(input:checked, input:disabled)) {
    color: var(--panel-ink);
  }
}

.segments__option:has(input:focus-visible) {
  outline: 2px solid var(--panel-accent);
  outline-offset: -2px;
}

/* Invisible over the whole option: the label is what shows, the radio what is pressed. */
.segments__option input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}

.segments--disabled {
  opacity: 0.4;
}

.segments--disabled .segments__option {
  cursor: default;
}
</style>
