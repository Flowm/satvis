<!-- A numeric table that scrolls sideways when the panel is narrower than its columns. -->
<template>
  <div class="bench__section">
    <h3 v-if="caption" class="bench__table-caption">{{ caption }}</h3>
    <div class="bench__table-scroll">
      <table class="bench__table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column.key" :class="{ bench__num: column.numeric }" :title="column.title">{{ column.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" :class="{ 'bench__row--struck': row.struck }" :title="row.title">
            <td v-for="column in columns" :key="column.key" :class="[column.numeric ? 'bench__num' : '', row.tones?.[column.key] ? `bench__${row.tones[column.key]}` : '']">
              {{ row.cells[column.key] ?? "" }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <slot />
  </div>
</template>

<script setup lang="ts">
/** A column, by the key its rows' cells use. */
export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
  title?: string;
}

export interface TableRow {
  key: string | number;
  cells: Record<string, string>;
  /** A cell's colour, by its column's key. */
  tones?: Record<string, "good" | "warn" | "bad" | "dim" | undefined>;
  /** Noise, kept to show it: struck through rather than dropped. */
  struck?: boolean;
  title?: string;
}

defineProps<{ caption?: string; columns: readonly TableColumn[]; rows: readonly TableRow[] }>();
</script>

<style>
.bench__table-caption {
  margin: 0 0 4px;
  color: var(--bench-dim);
  font-size: 11px;
  font-weight: 500;
}

.bench__table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.bench__table {
  width: 100%;
  border-collapse: collapse;
  white-space: nowrap;
}

.bench__table th {
  padding: 2px 5px;
  border-bottom: 1px solid var(--bench-line);
  color: var(--bench-dim);
  font-weight: 500;
  text-align: left;
}

.bench__table td {
  padding: 2px 5px;
}

.bench__table th.bench__num {
  text-align: right;
}

.bench__table tbody tr:nth-child(even) {
  background: rgba(255, 255, 255, 0.03);
}

.bench__row--struck td {
  color: var(--bench-dim);
  text-decoration: line-through;
}
</style>
