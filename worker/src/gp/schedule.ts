// The Docker image's refresh schedule (scripts/serve.mjs fires these; the deployed
// Worker has no trigger, ADR 0008). The scheduled handler tells the two apart by cron.

/**
 * At :23, off the hour, as CelesTrak asks. 6 h rather than 3 halves our share of its
 * 250 MB/day per-IP budget: ~7 MB a run is ~29 MB/day, for a few hundred metres of SGP4 drift.
 */
export const GP_CRON = "23 */6 * * *";

/** The upstream tables, daily: SATCAT changes once or twice a day, GCAT about weekly. */
export const CATALOG_CRON = "47 4 * * *";
