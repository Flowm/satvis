import { describe, expect, it, vi } from "vitest";

import { frameQueue, requestedFrameMs } from "./framePump";

describe("requestedFrameMs", () => {
  it("is off without the parameter", () => {
    expect(requestedFrameMs("")).toBeUndefined();
    expect(requestedFrameMs("?bench=true")).toBeUndefined();
  });

  it("takes the interval it is given", () => {
    expect(requestedFrameMs("?framems=16")).toBe(16);
    expect(requestedFrameMs("?bench=true&framems=33")).toBe(33);
  });

  it("stands in for 60 Hz when bare, or given nonsense", () => {
    expect(requestedFrameMs("?framems")).toBe(16);
    expect(requestedFrameMs("?framems=-5")).toBe(16);
    expect(requestedFrameMs("?framems=soon")).toBe(16);
  });

  it("can be turned off in a url being reused", () => {
    expect(requestedFrameMs("?framems=0")).toBeUndefined();
    expect(requestedFrameMs("?framems=false")).toBeUndefined();
  });
});

describe("frameQueue", () => {
  const at = (times: number[]) => {
    let index = 0;
    return () => times[Math.min(index++, times.length - 1)] as number;
  };

  it("holds callbacks until a frame is due", () => {
    const queue = frameQueue(16, at([0, 5, 20]));
    const callback = vi.fn();
    queue.request(callback);

    expect(queue.runDue()).toBe(true); // the first frame is never overdue
    expect(callback).toHaveBeenCalledTimes(1);

    queue.request(callback);
    expect(queue.runDue()).toBe(false); // 5 ms later
    expect(callback).toHaveBeenCalledTimes(1);

    expect(queue.runDue()).toBe(true); // 20 ms later
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("passes the frame timestamp to the callback", () => {
    const queue = frameQueue(16, at([42]));
    const callback = vi.fn();
    queue.request(callback);
    queue.runDue();
    expect(callback).toHaveBeenCalledWith(42);
  });

  it("forgets a cancelled callback", () => {
    const queue = frameQueue(0, () => 0);
    const callback = vi.fn();
    queue.cancel(queue.request(callback));
    queue.runDue();
    expect(callback).not.toHaveBeenCalled();
  });

  it("cancels only the handle it is given", () => {
    const queue = frameQueue(0, () => 0);
    const kept = vi.fn();
    const dropped = vi.fn();
    queue.request(kept);
    queue.cancel(queue.request(dropped));
    queue.runDue();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("defers a callback queued from inside a frame to the next one", () => {
    // Draining the live queue rather than a snapshot recurses to the stack limit,
    // because Cesium asks for its next frame from inside the current one.
    const queue = frameQueue(0, () => 0);
    let frames = 0;
    const loop = () => {
      frames += 1;
      if (frames < 10) {
        queue.request(loop);
      }
    };
    queue.request(loop);

    queue.runDue();
    expect(frames).toBe(1);
    queue.runDue();
    expect(frames).toBe(2);
  });

  it("gives the rest of the frame to the others when one callback throws", () => {
    const queue = frameQueue(0, () => 0);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    queue.request(() => {
      throw new Error("bad frame");
    });
    queue.request(after);

    expect(() => queue.runDue()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
