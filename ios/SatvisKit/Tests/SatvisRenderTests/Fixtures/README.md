`10-1086-781.terrain` is one tile of Re:Earth Terrain (Mapterhorn, CC BY 4.0;
https://terrain.reearth.land/), level 10, TMS column 1086 row 781: the Wetterstein,
around the Zugspitze. Fetched with octvertexnormals, as the app asks for it.

`tracking-frames.json` is written by `pnpm update-parity-fixtures` from CesiumJS's own
`EntityView`; never edit it by hand.

`frame-summaries.json` is written by `pnpm update-parity-fixtures` from the web app's
`summarize` (src/modules/benchmark/frameSummary.ts): frame recordings and the figures
the benchmark reports for them. Never edit it by hand.

`sweep.json` is written by `pnpm update-parity-fixtures` from the web app's sweep plan and
tables (src/modules/benchmark/benchmarkPlan.ts and report.ts): plans, synthetic sweeps
and every table, csv and pasted text read from them. Never edit it by hand.
