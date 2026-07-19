import { describe, expect, it } from 'vitest';
import {
  subscribeToggledProperties,
  videoLikeToggledProperties,
  videoShareProperties,
  videoViewProperties,
} from './watch-analytics';

describe('Watch analytics property audit', () => {
  it('never includes channel handles or other user-authored names', () => {
    expect(videoViewProperties('video-42')).toEqual({ video_id: 'video-42' });
    expect(subscribeToggledProperties(true)).toEqual({ subscribed: true });
    expect(videoLikeToggledProperties('video-42', true)).toEqual({ video_id: 'video-42', liked: true });
    expect(videoShareProperties('video-42', 'copy_link')).toEqual({ video_id: 'video-42', platform: 'copy_link' });

    for (const properties of [
      videoViewProperties('video-42'),
      subscribeToggledProperties(false),
      videoLikeToggledProperties('video-42', false),
      videoShareProperties('video-42', 'twitter'),
    ]) {
      expect(Object.keys(properties)).not.toContain('channel');
      expect(Object.keys(properties)).not.toContain('channel_username');
      expect(Object.keys(properties)).not.toContain('channelUsername');
      expect(Object.keys(properties)).not.toContain('channel_name');
      expect(Object.keys(properties)).not.toContain('channelName');
    }
  });
});
