import { describe, expect, it } from 'vitest';
import { RenderQueue } from './queue';

describe('RenderQueue', () => {
  it('accepts up to maxPending jobs', () => {
    const q = new RenderQueue({ maxPending: 3 });
    expect(q.enqueue({ jobId: 'a' })).toBe('accepted');
    expect(q.enqueue({ jobId: 'b' })).toBe('accepted');
    expect(q.enqueue({ jobId: 'c' })).toBe('accepted');
  });

  it('rejects beyond maxPending', () => {
    const q = new RenderQueue({ maxPending: 3 });
    q.enqueue({ jobId: 'a' }); q.enqueue({ jobId: 'b' }); q.enqueue({ jobId: 'c' });
    expect(q.enqueue({ jobId: 'd' })).toBe('rejected_full');
  });

  it('next() returns FIFO ordering', () => {
    const q = new RenderQueue({ maxPending: 3 });
    q.enqueue({ jobId: 'a' }); q.enqueue({ jobId: 'b' });
    expect(q.next()?.jobId).toBe('a');
    expect(q.next()?.jobId).toBe('b');
    expect(q.next()).toBeNull();
  });

  it('size reflects pending count', () => {
    const q = new RenderQueue({ maxPending: 3 });
    expect(q.size).toBe(0);
    q.enqueue({ jobId: 'a' });
    expect(q.size).toBe(1);
    q.next();
    expect(q.size).toBe(0);
  });
});
