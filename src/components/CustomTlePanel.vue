<template>
  <div class="custom-tle-panel">
    <textarea
      v-model="customTleInput"
      class="tleTextarea"
      placeholder="Paste TLE data (3-line format):
SATELLITE NAME
1 NNNNN...
2 NNNNN..."
      rows="5"
    ></textarea>
    <input v-model="customTleTags" class="tleTagInput" type="text" placeholder="Tags (e.g. Custom,Weather)" />
    <div class="tleButtons">
      <button class="cesium-button tleBtn" @click="addAndSaveCustomTle">Add Satellite</button>
    </div>
    <div v-if="allTleEntries.length > 0" class="savedTleList">
      <div class="savedTleHeader">TLEs ({{ allTleEntries.length }})</div>
      <TleEntry
        v-for="entry in allTleEntries"
        :key="extractSatelliteName(entry.tle)"
        :entry="entry"
        :name="extractSatelliteName(entry.tle)"
        :is-expanded="expandedTles[extractSatelliteName(entry.tle)]"
        :expanded-width="expandedWidth"
        :has-mismatch="hasMismatch(entry)"
        @toggle-expand="toggleTleExpand(extractSatelliteName(entry.tle))"
        @toggle-url="toggleTleInUrl(entry)"
        @toggle-storage="toggleTleInStorage(entry)"
        @show-mismatch="showMismatchResolution(entry)"
      />
      <div class="tleBulkButtons">
        <button class="cesium-button tleBtn tleBulkBtn" @click="addAllToUrl" title="Add all TLEs to URL"><font-awesome-icon icon="fas fa-link" /> All to URL</button>
        <button class="cesium-button tleBtn tleBulkBtn" @click="addAllToStorage" title="Save all TLEs to storage"><font-awesome-icon icon="fas fa-save" /> All to Storage</button>
        <button class="cesium-button tleBtn tleBulkBtn tleBulkBtnDanger" @click="clearAllFromUrl" title="Clear all from URL">
          <font-awesome-icon icon="fas fa-link-slash" /> Clear URL
        </button>
        <button class="cesium-button tleBtn tleBulkBtn tleBulkBtnDanger" @click="clearAllFromStorage" title="Clear all from storage">
          <font-awesome-icon icon="fas fa-trash" /> Clear Storage
        </button>
      </div>
    </div>

    <!-- Diff Popup Modal -->
    <TleDiffModal
      :visible="diffPopup.visible"
      :name="diffPopup.name"
      :url-tle="diffPopup.urlTle"
      :saved-tle="diffPopup.savedTle"
      @close="closeDiffPopup"
      @use-url="useUrlVersion"
      @use-saved="useSavedVersion"
      @remove-url="removeFromUrl"
      @remove-storage="removeFromStorage"
    />
  </div>
</template>

<script>
import { mapWritableState } from "pinia";

import { useSatStore } from "../stores/sat";
import { useCustomTle } from "../composables/useCustomTle";
import { useToastProxy } from "../composables/useToastProxy";
import TleEntry from "./TleEntry.vue";
import TleDiffModal from "./TleDiffModal.vue";

export default {
  components: {
    TleEntry,
    TleDiffModal,
  },
  emits: ["open-menu"],
  data() {
    return {
      customTleInput: "",
      customTleTags: "Custom",
      savedCustomTles: [],
      expandedTles: {},
      expandedWidth: null,
      diffPopup: {
        visible: false,
        name: "",
        savedTle: "",
        urlTle: "",
        entry: null,
      },
    };
  },
  computed: {
    ...mapWritableState(useSatStore, ["customTles"]),
    allTleEntries() {
      // Combine storage and URL TLEs, deduplicating by name
      const entries = new Map();

      // Add storage TLEs first
      this.savedCustomTles.forEach((entry) => {
        const name = this.extractSatelliteName(entry.tle);
        entries.set(name, { ...entry, inStorage: true, inUrl: false });
      });

      // Add/update with URL TLEs
      (this.customTles || []).forEach((entry) => {
        const name = this.extractSatelliteName(entry.tle);
        if (entries.has(name)) {
          entries.get(name).inUrl = true;
          entries.get(name).urlTle = entry.tle;
          entries.get(name).urlTags = entry.tags;
        } else {
          entries.set(name, { ...entry, inStorage: false, inUrl: true });
        }
      });

      return Array.from(entries.values());
    },
  },
  mounted() {
    this.loadCustomTlesFromStorage();
    this.$nextTick(() => {
      this.measureExpandedWidth();
      this.checkForMismatches();
    });
  },
  methods: {
    extractSatelliteName(tle) {
      const { extractSatelliteName } = useCustomTle();
      return extractSatelliteName(tle);
    },
    toggleTleExpand(name) {
      this.expandedTles = { ...this.expandedTles, [name]: !this.expandedTles[name] };
    },
    hasMismatch(entry) {
      // Only mismatch if in both URL and storage with different content
      if (!entry.inUrl || !entry.inStorage) return false;
      // Compare TLE content using urlTle if available
      if (entry.urlTle) {
        return entry.urlTle !== entry.tle;
      }
      return false;
    },
    checkForMismatches() {
      const toast = useToastProxy();
      // Use allTleEntries which has the computed inUrl, inStorage, and urlTle properties
      const mismatches = this.allTleEntries.filter((entry) => this.hasMismatch(entry));
      if (mismatches.length > 0) {
        const names = mismatches.map((e) => this.extractSatelliteName(e.tle)).join(", ");
        toast.add({
          severity: "warn",
          summary: "TLE Mismatch",
          detail: `${mismatches.length} TLE(s) differ from saved: ${names}. URL version is being used.`,
          life: 8000,
          data: {
            actionLabel: "Resolve",
            action: () => {
              // Open diff popup for the first mismatch
              this.showMismatchResolution(mismatches[0]);
            },
          },
        });
      }
    },
    showMismatchResolution(entry) {
      const name = this.extractSatelliteName(entry.tle);
      // Emit event to open the satellite selection menu in parent
      this.$emit("open-menu");
      // Open diff popup
      this.diffPopup = {
        visible: true,
        name,
        savedTle: entry.tle,
        urlTle: entry.urlTle || "",
        entry,
        urlEntry: entry.inUrl ? { tle: entry.urlTle, tags: entry.urlTags } : null,
      };
    },
    closeDiffPopup() {
      this.diffPopup.visible = false;
    },
    useUrlVersion() {
      const toast = useToastProxy();
      const { addOrUpdateInStorage, loadFromStorage } = useCustomTle();
      if (this.diffPopup.urlEntry) {
        addOrUpdateInStorage(this.diffPopup.urlEntry);
        this.savedCustomTles = loadFromStorage();
        toast.add({ severity: "success", summary: "Saved", detail: "URL version saved to storage", life: 3000 });
      }
      this.closeDiffPopup();
    },
    useSavedVersion() {
      const toast = useToastProxy();
      const name = this.diffPopup.name;
      // Update URL with saved version
      const savedEntry = this.diffPopup.entry;
      this.customTles = this.customTles.map((e) => (this.extractSatelliteName(e.tle) === name ? { tle: savedEntry.tle, tags: savedEntry.tags } : e));
      toast.add({ severity: "success", summary: "Updated", detail: "URL updated with saved version", life: 3000 });
      this.closeDiffPopup();
    },
    removeFromUrl() {
      const toast = useToastProxy();
      const name = this.diffPopup.name;
      this.customTles = this.customTles.filter((e) => this.extractSatelliteName(e.tle) !== name);
      toast.add({ severity: "info", summary: "Removed", detail: "Removed from URL", life: 3000 });
      this.closeDiffPopup();
    },
    removeFromStorage() {
      const toast = useToastProxy();
      const { removeFromStorage, loadFromStorage } = useCustomTle();
      const name = this.diffPopup.name;
      removeFromStorage(name);
      this.savedCustomTles = loadFromStorage();
      toast.add({ severity: "info", summary: "Removed", detail: "Removed from storage", life: 3000 });
      this.closeDiffPopup();
    },
    toggleTleInUrl(entry) {
      const name = this.extractSatelliteName(entry.tle);
      if (entry.inUrl) {
        // Remove from URL
        this.customTles = this.customTles.filter((e) => this.extractSatelliteName(e.tle) !== name);
        // If also not in storage, remove from visualization
        if (!entry.inStorage) {
          cc.sats.removeSatellite(name);
        }
      } else {
        // Add to URL
        this.customTles = [...this.customTles, { tle: entry.tle, tags: entry.tags }];
      }
    },
    toggleTleInStorage(entry) {
      const toast = useToastProxy();
      const name = this.extractSatelliteName(entry.tle);
      const { addOrUpdateInStorage, removeFromStorage, loadFromStorage } = useCustomTle();

      if (entry.inStorage) {
        // If not in URL, confirm before removing (it will be lost)
        if (!entry.inUrl) {
          if (!confirm(`Remove "${name}" from storage?\n\nThis TLE is not in the URL and will be permanently deleted.`)) {
            return;
          }
          // Remove from visualization since it's not in URL either
          cc.sats.removeSatellite(name);
        }
        // Remove from storage
        removeFromStorage(name);
        this.savedCustomTles = loadFromStorage();
        toast.add({ severity: "info", summary: "Removed", detail: "Removed from storage", life: 3000 });
      } else {
        // Add to storage (use URL version if available)
        const tleToSave = entry.urlTle || entry.tle;
        const tagsToSave = entry.urlTags || entry.tags;
        addOrUpdateInStorage({ tle: tleToSave, tags: tagsToSave });
        this.savedCustomTles = loadFromStorage();
        toast.add({ severity: "success", summary: "Saved", detail: "Saved to storage", life: 3000 });
      }
      this.$nextTick(() => this.measureExpandedWidth());
    },
    addAndSaveCustomTle() {
      const toast = useToastProxy();
      const { parseTleInput, validateTle, extractSatelliteName, addOrUpdateInStorage, loadFromStorage } = useCustomTle();

      if (!this.customTleInput.trim()) {
        toast.add({ severity: "warn", summary: "Warning", detail: "Please enter TLE data", life: 3000 });
        return;
      }

      const tles = parseTleInput(this.customTleInput);
      if (tles.length === 0) {
        toast.add({ severity: "error", summary: "Error", detail: "Invalid TLE format. Expected 3-line format.", life: 5000 });
        return;
      }

      const tags = this.customTleTags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t);
      if (tags.length === 0) tags.push("Custom");

      let addedCount = 0;
      let updatedCount = 0;

      tles.forEach((tle) => {
        const validation = validateTle(tle);
        if (!validation.valid) {
          toast.add({ severity: "error", summary: "Error", detail: `Invalid TLE for ${extractSatelliteName(tle)}: ${validation.error}`, life: 5000 });
          return;
        }
        // Save to storage
        addOrUpdateInStorage({ tle, tags });
        // Add to visualization (autoEnable = true)
        const result = cc.sats.addOrUpdateFromTle(tle, tags, true, true);
        if (result.added) addedCount++;
        if (result.updated) updatedCount++;
      });

      if (addedCount > 0 || updatedCount > 0) {
        const messages = [];
        if (addedCount > 0) messages.push(`${addedCount} added`);
        if (updatedCount > 0) messages.push(`${updatedCount} updated`);
        toast.add({ severity: "success", summary: "Success", detail: `Satellites: ${messages.join(", ")}`, life: 3000 });
        this.customTleInput = "";
        this.savedCustomTles = loadFromStorage();
        this.$nextTick(() => this.measureExpandedWidth());
      }
    },
    loadCustomTlesFromStorage() {
      const { loadFromStorage } = useCustomTle();
      this.savedCustomTles = loadFromStorage();
      this.$nextTick(() => this.measureExpandedWidth());
    },
    addAllToUrl() {
      const toast = useToastProxy();
      let addedCount = 0;

      // Add all entries that aren't already in URL
      this.allTleEntries.forEach((entry) => {
        if (!entry.inUrl) {
          const tleToAdd = entry.tle;
          const tagsToAdd = entry.tags;
          this.customTles = [...this.customTles, { tle: tleToAdd, tags: tagsToAdd }];
          addedCount++;
        }
      });

      if (addedCount > 0) {
        toast.add({ severity: "success", summary: "Added to URL", detail: `${addedCount} TLE(s) added to URL`, life: 3000 });
      } else {
        toast.add({ severity: "info", summary: "No changes", detail: "All TLEs already in URL", life: 3000 });
      }
    },
    addAllToStorage() {
      const toast = useToastProxy();
      const { addOrUpdateInStorage, loadFromStorage } = useCustomTle();
      let addedCount = 0;

      // Add all entries that aren't already in storage
      this.allTleEntries.forEach((entry) => {
        if (!entry.inStorage) {
          const tleToSave = entry.urlTle || entry.tle;
          const tagsToSave = entry.urlTags || entry.tags;
          addOrUpdateInStorage({ tle: tleToSave, tags: tagsToSave });
          addedCount++;
        }
      });

      if (addedCount > 0) {
        this.savedCustomTles = loadFromStorage();
        toast.add({ severity: "success", summary: "Saved to Storage", detail: `${addedCount} TLE(s) saved to storage`, life: 3000 });
        this.$nextTick(() => this.measureExpandedWidth());
      } else {
        toast.add({ severity: "info", summary: "No changes", detail: "All TLEs already in storage", life: 3000 });
      }
    },
    clearAllFromUrl() {
      const toast = useToastProxy();

      // Check if any TLEs are only in URL (not in storage) - they would be lost
      const urlOnlyTles = this.allTleEntries.filter((e) => e.inUrl && !e.inStorage);

      if (urlOnlyTles.length > 0) {
        const names = urlOnlyTles.map((e) => this.extractSatelliteName(e.tle)).join(", ");
        if (!confirm(`Clear all TLEs from URL?\n\nThe following TLEs are not in storage and will be lost:\n${names}`)) {
          return;
        }
        // Remove from visualization
        urlOnlyTles.forEach((entry) => {
          cc.sats.removeSatellite(this.extractSatelliteName(entry.tle));
        });
      }

      this.customTles = [];
      toast.add({ severity: "info", summary: "Cleared", detail: "All TLEs removed from URL", life: 3000 });
    },
    clearAllFromStorage() {
      const toast = useToastProxy();
      const { clearStorage, loadFromStorage, extractSatelliteName } = useCustomTle();

      // Check if any TLEs are only in storage (not in URL) - they would be lost
      const storageOnlyTles = this.allTleEntries.filter((e) => e.inStorage && !e.inUrl);

      if (storageOnlyTles.length > 0) {
        const names = storageOnlyTles.map((e) => this.extractSatelliteName(e.tle)).join(", ");
        if (!confirm(`Clear all TLEs from storage?\n\nThe following TLEs are not in the URL and will be permanently deleted:\n${names}`)) {
          return;
        }
        // Remove from visualization
        storageOnlyTles.forEach((entry) => {
          cc.sats.removeSatellite(this.extractSatelliteName(entry.tle));
        });
      }

      clearStorage();
      this.savedCustomTles = loadFromStorage();
      this.$nextTick(() => this.measureExpandedWidth());
      toast.add({ severity: "info", summary: "Cleared", detail: "All TLEs removed from storage", life: 3000 });
    },
    measureExpandedWidth() {
      if (this.allTleEntries.length === 0) {
        this.expandedWidth = null;
        return;
      }

      // Create hidden measurer element
      const measurer = document.createElement("pre");
      measurer.style.cssText = `
        position: absolute;
        visibility: hidden;
        white-space: pre;
        font-family: monospace;
        font-size: 11px;
        line-height: 1.4;
        padding: 0;
        margin: 0;
      `;
      document.body.appendChild(measurer);

      // Measure each TLE and find max width
      let maxWidth = 0;
      this.allTleEntries.forEach((entry) => {
        measurer.textContent = entry.tle;
        const width = measurer.offsetWidth;
        if (width > maxWidth) maxWidth = width;
      });

      document.body.removeChild(measurer);

      // Add padding: 8px left + 8px right
      this.expandedWidth = maxWidth + 16 + "px";
    },
  },
};
</script>

<style scoped>
.tleTextarea {
  width: 100%;
  padding: 6px;
  border: 1px solid #555;
  border-radius: 4px;
  background-color: #1a1a1a;
  color: #edffff;
  font-family: monospace;
  font-size: 10px;
  resize: vertical;
  box-sizing: border-box;
  margin-bottom: 5px;
}

.tleTextarea::placeholder {
  color: #888;
}

.tleTagInput {
  width: 100%;
  padding: 5px 6px;
  border: 1px solid #555;
  border-radius: 4px;
  background-color: #1a1a1a;
  color: #edffff;
  font-size: 11px;
  box-sizing: border-box;
  margin-bottom: 5px;
}

.tleTagInput::placeholder {
  color: #888;
}

.tleButtons {
  display: flex;
  gap: 5px;
}

.tleBtn {
  flex: 1;
  padding: 4px 8px;
  font-size: 11px;
}

.savedTleList {
  margin-top: 8px;
  border-top: 1px solid #444;
  padding-top: 5px;
}

.savedTleHeader {
  font-size: 11px;
  color: #aaa;
  margin-bottom: 4px;
}

.tleBulkButtons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #444;
}

.tleBulkBtn {
  padding: 4px 6px;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.tleBulkBtnDanger {
  background-color: #c62828;
}

.tleBulkBtnDanger:hover {
  background-color: #e53935;
}
</style>
