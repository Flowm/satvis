<template>
  <UCard class="gpGraphqlPanel">
    <template #header>
      <div class="gpGraphqlPanel__head">
        <span class="gpGraphqlPanel__title">Satellite data (GraphQL)</span>
        <span class="gpGraphqlPanel__src">{{ sourceLabel }}</span>
      </div>
    </template>

    <div v-if="groups.length > 0" class="gpGraphqlPanel__controls">
      <USelect
        v-model="selected"
        :items="groupOptions"
        placeholder="Pick a group"
        class="gpGraphqlPanel__select"
        @update:model-value="loadGroup"
      />
      <UButton :loading="loading" variant="soft" @click="loadGroups">Refresh</UButton>
    </div>

    <div v-if="error" class="gpGraphqlPanel__error">{{ error }}</div>

    <div v-else-if="loading" class="gpGraphqlPanel__note">Loading…</div>

    <div v-else-if="current" class="gpGraphqlPanel__body">
      <div class="gpGraphqlPanel__meta">
        {{ current.name }} · {{ current.count ?? current.satellites.length }} satellites
        <span v-if="current.updated" class="gpGraphqlPanel__updated">· updated {{ current.updated }}</span>
      </div>
      <UList :items="satelliteItems" class="gpGraphqlPanel__list" />
    </div>

    <div v-else-if="groups.length === 0 && !loading" class="gpGraphqlPanel__note">
      No groups available from the GraphQL API.
    </div>
  </UCard>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { graphqlRequest, resetGraphqlProbe, type GpGroup, type GpIndexEntry } from "../modules/util/graphql";

const groups = ref<GpIndexEntry[]>([]);
const current = ref<GpGroup | null>(null);
const selected = ref<string | undefined>(undefined);
const loading = ref(false);
const error = ref<string | undefined>(undefined);
// True when the data came from the live /api/graphql worker rather than the
// static snapshot fallback, so the panel can label its source honestly.
const liveApi = ref(false);

const sourceLabel = computed(() => (liveApi.value ? "live GraphQL API" : "static snapshot"));

const groupOptions = computed(() =>
  groups.value.map((g) => ({ label: `${g.name} (${g.count ?? "?"})`, value: g.name })),
);

const satelliteItems = computed(() =>
  current.value?.satellites.map((s) => ({ label: s.name })) ?? [],
);

async function loadGroups(): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    const result = await graphqlRequest("{ groups { name count updated } }");
    groups.value = result.data?.groups ?? [];
    liveApi.value = result.data !== undefined && groups.value.length > 0;
    // Auto-select the first group so the panel shows data on first open.
    if (groups.value.length > 0 && !selected.value) {
      selected.value = groups.value[0]!.name;
      await loadGroup(selected.value);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load groups";
  } finally {
    loading.value = false;
  }
}

async function loadGroup(name: string): Promise<void> {
  if (!name) return;
  loading.value = true;
  error.value = undefined;
  try {
    const result = await graphqlRequest(`{ group(name: "${name}") { name count updated satellites { name } } }`);
    current.value = result.data?.group ?? null;
    liveApi.value = result.data !== undefined;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load group";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  resetGraphqlProbe();
  void loadGroups();
});
</script>

<style scoped>
.gpGraphqlPanel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.gpGraphqlPanel__title {
  font-weight: 600;
}

.gpGraphqlPanel__src {
  color: var(--ui-text-dimmed, #9ca3af);
  font-size: 11px;
}

.gpGraphqlPanel__controls {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.gpGraphqlPanel__select {
  flex: 1 1 auto;
}

.gpGraphqlPanel__meta {
  font-size: 12px;
  margin-bottom: 6px;
}

.gpGraphqlPanel__updated {
  color: var(--ui-text-dimmed, #9ca3af);
}

.gpGraphqlPanel__error {
  color: #fca5a5;
  font-size: 13px;
}

.gpGraphqlPanel__note {
  color: var(--ui-text-dimmed, #9ca3af);
  font-size: 13px;
  font-style: italic;
}
</style>
