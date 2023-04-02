import { getTimestamp } from "cesium";

// A Cesium Performance Monitor that logs avarage and worst performance over a sample period
export class CesiumPerformanceStats {
  constructor(scene, logContinuously = false) {
    this.scene = scene;
    this.sampleCount = 60;
    this.idx = 0;
    this.postRenderTimes = [];
    this.discardNext = true;

    this.avgFps = 0;
    this.avgFrameTime = 0;
    this.worstFrameTime = 0;

    // Disable requestRenderMode to caclulate time betweeen consecutive postRender events
    // This is required as many updates happen during clock onTick events before scene.preUpdate is called
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

  calculateStats() {
    this.worstFrameTime = 0;
    for (let i = 0; i < this.sampleCount - 1; i += 1) {
      const frametime = this.postRenderTimes[i + 1] - this.postRenderTimes[i];
      if (frametime > this.worstFrameTime) {
        this.worstFrameTime = frametime;
      }
    }
    const duration = this.postRenderTimes[this.sampleCount - 1] - this.postRenderTimes[0];
    this.avgFps = this.sampleCount / (duration / 1000);
    this.avgFrameTime = duration / this.sampleCount;
  }

  reset(discardNext = true) {
    this.idx = 0;
    this.discardNext = discardNext;
    this.avgFps = 0;
    this.avgFrameTime = 0;
    this.worstFrameTime = 0;
  }

  getStats() {
    return {
      avgFps: this.avgFps,
      avgFrameTime: this.avgFrameTime,
      worstFrameTime: this.worstFrameTime,
    };
  }

  formatStats() {
    const fmt = (n) => n.toFixed(2).padStart(8);
    return `Avg FPS: ${fmt(this.avgFps)}; Avg Frametime: ${fmt(this.avgFrameTime)}; Worst Frametime: ${fmt(this.worstFrameTime)};`;
  }
}
