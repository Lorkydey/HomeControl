interface Job {
  key: string;
  task: () => Promise<unknown>;
  resolve: ((value: unknown) => void)[];
  reject: ((error: unknown) => void)[];
}
/** Serial ordering per device, independent devices in parallel, only the newest pending value per control. */
export class LatestQueue {
  private lanes = new Map<number, { running: boolean; pending: Job[] }>();
  run<T>(device: number, key: string, task: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(device) ?? { running: false, pending: [] };
    this.lanes.set(device, lane);
    return new Promise<T>((resolve, reject) => {
      const index = lane.pending.findIndex((job) => job.key === key);
      let job: Job;
      if (index >= 0) {
        job = lane.pending.splice(index, 1)[0];
        job.task = task;
      } else job = { key, task, resolve: [], reject: [] };
      job.resolve.push(resolve as (value: unknown) => void);
      job.reject.push(reject);
      lane.pending.push(job);
      if (!lane.running) void this.drain(device, lane);
    });
  }
  private async drain(
    device: number,
    lane: { running: boolean; pending: Job[] },
  ) {
    lane.running = true;
    while (lane.pending.length) {
      const job = lane.pending.shift()!;
      try {
        const result = await job.task();
        job.resolve.forEach((resolve) => resolve(result));
      } catch (error) {
        job.reject.forEach((reject) => reject(error));
      }
    }
    lane.running = false;
    this.lanes.delete(device);
  }
}
