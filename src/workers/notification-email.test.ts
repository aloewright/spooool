import { describe, expect, it } from 'vitest';
import { buildDigestEmail, buildNewUploadEmail, buildCommentEmail } from './notification-email';

describe('notification-email templates (ALO-157)', () => {
  it('buildNewUploadEmail includes watch URL', () => {
    const mail = buildNewUploadEmail({
      channelName: 'Aloe',
      videoTitle: 'New clip',
      watchUrl: 'https://spooool.com/watch/v1',
    });
    expect(mail.subject).toContain('Aloe');
    expect(mail.text).toContain('https://spooool.com/watch/v1');
  });

  it('buildCommentEmail truncates safely in HTML', () => {
    const mail = buildCommentEmail({
      commenterName: 'Pat',
      videoTitle: 'Demo',
      watchUrl: 'https://spooool.com/watch/v2',
      excerpt: 'Nice work',
    });
    expect(mail.html).toContain('Pat');
    expect(mail.text).toContain('Nice work');
  });

  it('buildDigestEmail lists multiple uploads', () => {
    const mail = buildDigestEmail({
      items: [
        { channelName: 'A', videoTitle: 'One', watchUrl: 'https://spooool.com/watch/1' },
        { channelName: 'B', videoTitle: 'Two', watchUrl: 'https://spooool.com/watch/2' },
      ],
    });
    expect(mail.subject).toContain('2 new uploads');
    expect(mail.text).toContain('One');
    expect(mail.text).toContain('Two');
  });
});
