import { describe, expect, it } from 'vitest';
import { classifyUploadError } from './Upload';

describe('classifyUploadError', () => {
  it('treats messages without an HTTP status as network errors', () => {
    expect(classifyUploadError('Failed to fetch')).toBe('network_error');
    expect(classifyUploadError('No upload response')).toBe('network_error');
  });

  it('maps the quota-exceeded 413 into its own bucket', () => {
    expect(classifyUploadError('Upload failed (413): quota exceeded')).toBe('http_413');
  });

  it('maps 429 rate limits into their own bucket', () => {
    expect(classifyUploadError('Upload failed (429): slow down')).toBe('http_429');
  });

  it('buckets other 4xx and 5xx statuses', () => {
    expect(classifyUploadError('Upload failed (400): bad shape')).toBe('http_4xx');
    expect(classifyUploadError('Upload failed (404): not found')).toBe('http_4xx');
    expect(classifyUploadError('Upload failed (500): internal')).toBe('http_5xx');
    expect(classifyUploadError('Upload failed (503): unavailable')).toBe('http_5xx');
  });

  it('returns unknown for non-error status codes the regex could still parse', () => {
    expect(classifyUploadError('Upload failed (301): moved')).toBe('unknown');
  });
});
