import { describe, expect, it } from 'vitest';
import { subscribeToggledProperties, videoViewProperties } from './watch-analytics';

describe('Watch analytics property audit', () => {
  it('never includes channel handles or other user-authored names', () => {
    expect(videoViewProperties('video-42')).toEqual({ video_id: 'video-42' });
    expect(subscribeToggledProperties(true)).toEqual({ subscribed: true });

    for (const properties of [videoViewProperties('video-42'), subscribeToggledProperties(false)]) {
      expect(Object.keys(properties)).not.toContain('channel');
      expect(Object.keys(properties)).not.toContain('channel_username');
      expect(Object.keys(properties)).not.toContain('channelUsername');
      expect(Object.keys(properties)).not.toContain('channel_name');
      expect(Object.keys(properties)).not.toContain('channelName');
    }
  });
});
