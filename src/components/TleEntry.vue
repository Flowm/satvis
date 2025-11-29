<template>
  <div
    class="tle-entry-wrapper"
    :class="{ expanded: isExpanded }"
    :style="isExpanded && expandedWidth ? { width: expandedWidth } : {}"
    :title="!isExpanded ? name : undefined"
    @click="handleClick"
  >
    <div class="tle-entry-content">
      <pre class="tle-data">{{ entry.tle }}</pre>
    </div>
    <div class="tle-entry-footer">
      <div class="tle-entry-footer-inner">
        <div v-if="entry.tags && entry.tags.length" class="tle-tags">
          <span v-for="tag in entry.tags" :key="tag" class="tle-tag">{{ tag }}</span>
        </div>
      </div>
    </div>
    <div class="tle-entry-buttons">
      <!-- Mismatch: only show warning icon -->
      <button v-if="hasMismatch" class="tle-entry-btn tle-warn-btn" @click.stop="$emit('show-mismatch')" title="TLE differs between URL and storage">
        <font-awesome-icon icon="fas fa-exclamation-triangle" />
      </button>
      <!-- No mismatch: show URL and Storage buttons -->
      <template v-else>
        <!-- URL button: blue link to add, red link-slash to remove -->
        <button
          class="tle-entry-btn"
          :class="entry.inUrl ? 'tle-url-btn-remove' : 'tle-url-btn-add'"
          @click.stop="$emit('toggle-url')"
          :title="entry.inUrl ? 'Remove from URL' : 'Add to URL'"
        >
          <font-awesome-icon :icon="entry.inUrl ? 'fas fa-link-slash' : 'fas fa-link'" />
        </button>
        <!-- Storage button: blue save to add, red save to remove -->
        <button
          class="tle-entry-btn"
          :class="entry.inStorage ? 'tle-save-btn-remove' : 'tle-save-btn-add'"
          @click.stop="$emit('toggle-storage')"
          :title="entry.inStorage ? 'Remove from storage' : 'Save to storage'"
        >
          <font-awesome-icon icon="fas fa-save" />
        </button>
      </template>
    </div>
  </div>
</template>

<script>
export default {
  name: "TleEntry",
  props: {
    entry: {
      type: Object,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    isExpanded: {
      type: Boolean,
      default: false,
    },
    expandedWidth: {
      type: String,
      default: null,
    },
    hasMismatch: {
      type: Boolean,
      default: false,
    },
  },
  emits: ["toggle-expand", "toggle-url", "toggle-storage", "show-mismatch"],
  methods: {
    handleClick() {
      // If there's a mismatch, show resolution popup instead of expanding
      if (this.hasMismatch) {
        this.$emit("show-mismatch");
        return;
      }

      if (!this.isExpanded) {
        // Collapsed: always expand on click
        this.$emit("toggle-expand");
      } else {
        // Expanded: only collapse if user isn't selecting text
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.toString().length === 0) {
          this.$emit("toggle-expand");
        }
      }
    },
  },
};
</script>

<style scoped>
.tle-entry-wrapper {
  position: relative;
  margin-bottom: 3px;
  background-color: #252525;
  border-radius: 3px;
  overflow: hidden;
  width: 100%;
  min-width: 100%;
  cursor: pointer;
  /* Collapsed: show only first line (~23px = 4px top padding + 15px line + 4px bottom padding) */
  max-height: 23px;
  /* Animate width and height together */
  transition:
    width 0.3s ease,
    max-height 0.3s ease;
}

.tle-entry-wrapper:hover {
  background-color: #303030;
}

.tle-entry-wrapper.expanded {
  user-select: text;
  /* Expanded: 3 TLE lines (~46px) + footer (~26px) + padding (~8px) = ~80px */
  max-height: 80px;
}

.tle-entry-content {
  padding: 4px 8px;
}

.tle-entry-footer {
  padding: 0 8px 4px 8px;
}

.tle-entry-footer-inner {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tle-data {
  font-family: monospace;
  font-size: 11px;
  color: #edffff;
  margin: 0;
  white-space: pre;
  line-height: 1.4;
}

.tle-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.tle-tag {
  display: inline-block;
  padding: 2px 6px;
  background-color: #41b883;
  color: #fff;
  border-radius: 4px;
  font-size: 10px;
  line-height: 10px;
}

.tle-entry-buttons {
  position: absolute;
  right: 8px;
  bottom: 4px;
  display: flex;
  gap: 4px;
}

.tle-entry-btn {
  background-color: #353535;
  border: none;
  cursor: pointer;
  font-size: 10px;
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
}

/* URL button styles */
.tle-url-btn-add {
  color: #4dabf7;
}

.tle-url-btn-add:hover {
  background-color: #454545;
  color: #74c0fc;
}

.tle-url-btn-remove {
  color: #ff6b6b;
}

.tle-url-btn-remove:hover {
  background-color: #454545;
  color: #ff4444;
}

/* Storage button styles */
.tle-save-btn-add {
  color: #4dabf7;
}

.tle-save-btn-add:hover {
  background-color: #454545;
  color: #74c0fc;
}

.tle-save-btn-remove {
  color: #ff6b6b;
}

.tle-save-btn-remove:hover {
  background-color: #454545;
  color: #ff4444;
}

.tle-warn-btn {
  color: #ffa726;
}

.tle-warn-btn:hover {
  background-color: #454545;
  color: #ffb74d;
}
</style>
