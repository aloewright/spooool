export function videoViewProperties(videoId: string): { video_id: string } {
  return { video_id: videoId };
}

export function subscribeToggledProperties(subscribed: boolean): { subscribed: boolean } {
  return { subscribed };
}

export function videoLikeToggledProperties(videoId: string, liked: boolean): { video_id: string; liked: boolean } {
  return { video_id: videoId, liked };
}

export function videoShareProperties(videoId: string, platform: string): { video_id: string; platform: string } {
  return { video_id: videoId, platform };
}
