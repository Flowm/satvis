<template>
  <Teleport to="body">
    <div v-if="visible" class="diff-overlay" @click.self="$emit('close')">
      <div class="diff-popup">
        <div class="diff-header">
          <span class="diff-title">TLE Mismatch: {{ name }}</span>
          <button class="diff-close-btn" @click="$emit('close')">✕</button>
        </div>
        <div class="diff-content">
          <div class="diff-section">
            <div class="diff-section-header">
              <span class="diff-section-label">URL</span>
              <div class="diff-section-buttons">
                <button class="cesium-button diff-action-btn" @click="$emit('use-url')">Replace saved</button>
                <button class="cesium-button diff-action-btn diff-action-btn-danger" @click="$emit('remove-url')">Remove from URL</button>
              </div>
            </div>
            <!-- v-html is safe here: escapeHtml() sanitizes input before highlighting -->
            <pre class="diff-tle" v-html="highlightedUrlTle"></pre>
          </div>
          <div class="diff-section">
            <div class="diff-section-header">
              <span class="diff-section-label">Saved</span>
              <div class="diff-section-buttons">
                <button class="cesium-button diff-action-btn diff-action-btn-secondary" @click="$emit('use-saved')">Replace URL</button>
                <button class="cesium-button diff-action-btn diff-action-btn-danger" @click="$emit('remove-storage')">Remove from storage</button>
              </div>
            </div>
            <!-- v-html is safe here: escapeHtml() sanitizes input before highlighting -->
            <pre class="diff-tle" v-html="highlightedSavedTle"></pre>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script>
export default {
  name: "TleDiffModal",
  props: {
    visible: {
      type: Boolean,
      default: false,
    },
    name: {
      type: String,
      default: "",
    },
    urlTle: {
      type: String,
      default: "",
    },
    savedTle: {
      type: String,
      default: "",
    },
  },
  emits: ["close", "use-url", "use-saved", "remove-url", "remove-storage"],
  computed: {
    highlightedUrlTle() {
      if (!this.visible) return "";
      return this.getHighlightedDiff(this.urlTle, this.savedTle);
    },
    highlightedSavedTle() {
      if (!this.visible) return "";
      return this.getHighlightedDiff(this.savedTle, this.urlTle);
    },
  },
  methods: {
    getHighlightedDiff(text, compareText) {
      const lines = text.split("\n");
      const compareLines = compareText.split("\n");

      return lines
        .map((line, i) => {
          const compareLine = compareLines[i] || "";
          if (line === compareLine) {
            return this.escapeHtml(line);
          }
          return this.highlightCharDiff(line, compareLine);
        })
        .join("\n");
    },
    highlightCharDiff(line, compareLine) {
      let result = "";
      let i = 0;

      while (i < line.length) {
        if (i < compareLine.length && line[i] === compareLine[i]) {
          let matchEnd = i;
          while (matchEnd < line.length && matchEnd < compareLine.length && line[matchEnd] === compareLine[matchEnd]) {
            matchEnd++;
          }
          result += this.escapeHtml(line.substring(i, matchEnd));
          i = matchEnd;
        } else {
          let diffEnd = i;
          while (diffEnd < line.length && (diffEnd >= compareLine.length || line[diffEnd] !== compareLine[diffEnd])) {
            diffEnd++;
          }
          result += `<span class="diff-highlight">${this.escapeHtml(line.substring(i, diffEnd))}</span>`;
          i = diffEnd;
        }
      }

      return result;
    },
    escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    },
  },
};
</script>

<style>
/* Unscoped styles required for Teleport to body */
.diff-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.diff-popup {
  background-color: #1e1e1e;
  border: 1px solid #444;
  border-radius: 8px;
  max-width: 90vw;
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.diff-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background-color: #2a2a2a;
  border-bottom: 1px solid #444;
}

.diff-title {
  font-size: 14px;
  font-weight: bold;
  color: #ffa726;
}

.diff-close-btn {
  background: transparent;
  border: none;
  color: #888;
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
}

.diff-close-btn:hover {
  color: #fff;
}

.diff-content {
  display: flex;
  flex-direction: column;
  overflow: auto;
}

.diff-section {
  background-color: #1e1e1e;
  border-bottom: 1px solid #444;
}

.diff-section:last-child {
  border-bottom: none;
}

.diff-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  background-color: #252525;
  border-bottom: 1px solid #444;
}

.diff-section-label {
  font-size: 13px;
  font-weight: bold;
  color: #aaa;
}

.diff-section-buttons {
  display: flex;
  gap: 6px;
}

.diff-action-btn {
  padding: 5px 12px;
  font-size: 12px;
}

.diff-action-btn-secondary {
  background-color: #404040;
}

.diff-action-btn-secondary:hover {
  background-color: #505050;
}

.diff-action-btn-danger {
  background-color: #c62828;
}

.diff-action-btn-danger:hover {
  background-color: #e53935;
}

.diff-tle {
  margin: 0;
  padding: 12px;
  font-family: monospace;
  font-size: 11px;
  line-height: 1.5;
  color: #edffff;
  white-space: pre;
  overflow-x: auto;
  user-select: text;
  cursor: text;
}

.diff-tle .diff-highlight {
  background-color: rgba(255, 200, 50, 0.8);
  color: #1a1a1a;
  border-radius: 2px;
  padding: 0 1px;
}
</style>
