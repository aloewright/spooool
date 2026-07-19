export function videoViewProperties(videoId: string): { video_id: string } {
  return { video_id: videoId };
}

export function subscribeToggledProperties(subscribed: boolean): { subscribed: boolean } {
  return { subscribed };
}
