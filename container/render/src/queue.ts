// Bounded FIFO queue for render jobs accepted by the container's HTTP
// server. Capped at maxPending (3 in production) so a single container
// instance can't be swamped — clients beyond the cap get a 429 response
// from the server and back off. Single-process, single-threaded; no
// concurrency primitives needed because Node.js + Hono is event-loop based.

export interface QueueJob {
  jobId: string;
  takeKeys?: string[];
  compositionProps?: Record<string, unknown>;
}

export interface QueueOptions {
  maxPending: number;
}

export class RenderQueue {
  private readonly buf: QueueJob[] = [];

  constructor(private readonly opts: QueueOptions) {}

  enqueue(job: QueueJob): 'accepted' | 'rejected_full' {
    if (this.buf.length >= this.opts.maxPending) return 'rejected_full';
    this.buf.push(job);
    return 'accepted';
  }

  next(): QueueJob | null {
    return this.buf.shift() ?? null;
  }

  get size(): number {
    return this.buf.length;
  }
}
