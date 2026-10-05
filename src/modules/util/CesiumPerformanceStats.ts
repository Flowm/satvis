import { getTimestamp } from "@cesium/engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Scene = any;

const fmt = (n: number): string => n.toFixed(2).padStart(8);

export interface CesiumPerformanceStatsResult {
  avgFps: number;
  avgFrameTime: number;
  worstFrameTime: number;
}

// Mean and worst frame time over a sample period.
export class CesiumPerformanceStats {
  scene: Scene;

  sampleCount = 60;

  idx = 0;

  postRenderTimes: number[] = [];

  discardNext = true;

  avgFps = 0;

  avgFrameTime = 0;

  worstFrameTime = 0;

  constructor(scene: Scene, logContinuously = false) {
    this.scene = scene;

    // Render-on-demand skips idle frames, so the gap between postRender events would
    // measure idleness rather than frame cost.
    this.scene.requestRenderMode = false;

    this.scene.preUpdate.addEventListener(() => {
      performance.mark("preUpdate");
    });

    this.scene.postRender.addEventListener(() => {
      performance.mark("postRender");
      this.postRenderTimes[this.idx] = getTimestamp();
      this.idx = (this.idx + 1) % this.sampleCount;
      if (this.idx === 0) {
        if (this.discardNext) {
          this.discardNext = false;
        } else {
          this.calculateStats();
          if (logContinuously) {
            console.log(this.formatStats());
          }
        }
      }
      performance.measure("SceneRender", "preUpdate", "postRender");
    });
  }

  calculateStats(): void {
    this.worstFrameTime = 0;
    for (let i = 0; i < this.sampleCount - 1; i += 1) {
      const a = this.postRenderTimes[i + 1];
      const b = this.postRenderTimes[i];
      if (a === undefined || b === undefined) continue;
      const frametime = a - b;
      if (frametime > this.worstFrameTime) {
        this.worstFrameTime = frametime;
      }
    }
    const last = this.postRenderTimes[this.sampleCount - 1];
    const first = this.postRenderTimes[0];
    if (last === undefined || first === undefined) return;
    const duration = last - first;
    this.avgFps = this.sampleCount / (duration / 1000);
    this.avgFrameTime = duration / this.sampleCount;
  }

  reset(discardNext = true): void {
    this.idx = 0;
    this.discardNext = discardNext;
    this.avgFps = 0;
    this.avgFrameTime = 0;
    this.worstFrameTime = 0;
  }

  getStats(): CesiumPerformanceStatsResult {
    return {
      avgFps: this.avgFps,
      avgFrameTime: this.avgFrameTime,
      worstFrameTime: this.worstFrameTime,
    };
  }

  formatStats(): string {
    return `Avg FPS: ${fmt(this.avgFps)}; Avg Frametime: ${fmt(this.avgFrameTime)}; Worst Frametime: ${fmt(this.worstFrameTime)};`;
  }
}
