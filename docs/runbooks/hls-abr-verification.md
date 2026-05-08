# HLS adaptive bitrate verification (ALO-142)

End-to-end check that Cloudflare Stream is emitting multiple HLS renditions
and that our player would step them down under bandwidth pressure.

## What we verify

1. **Variants surface to the player.** The Stream master manifest at
   `https://videodelivery.net/<stream_video_id>/manifest/video.m3u8` lists
   2+ `EXT-X-STREAM-INF` entries with distinct `BANDWIDTH` values.
2. **ABR ladder is monotonic.** Simulating a throttle from 10 Mbps down to
   250 kbps using the same selection rule hls.js uses (highest variant
   ≤ ceiling) yields heights that never go up as bandwidth drops.

The runtime ABR switching itself is delegated to `hls.js` (Chrome/Firefox)
or Safari's native HLS stack. We verify the input it receives.

## Run the check against a real video

```bash
# Either pass the full master manifest URL …
node scripts/verify-hls-abr.mjs https://videodelivery.net/<id>/manifest/video.m3u8

# … or just the Stream video id; the script expands to the canonical URL.
node scripts/verify-hls-abr.mjs <stream_video_id>
```

Expected output: a list of variants with bitrate + resolution, a throttle
ladder showing renditions stepping down, and `OK:` at the end. Non-zero
exit on a single-variant manifest or non-monotonic ladder.

## Manual browser verification (throttle test)

1. Upload a >30s clip and wait until `videos.status = 'ready'`.
2. Open the watch page in Chrome DevTools with **Network → Throttling →
   Custom** profiles set to 5 Mbps, 1.5 Mbps, 500 kbps in turn.
3. In the Network panel, filter on `m3u8` and `.ts`/`.m4s`. Confirm that
   after each throttle change hls.js fetches a different rendition
   playlist (e.g. `1080p/index.m3u8` → `480p/index.m3u8` → `240p/...`)
   and that the `<video>` element keeps playing without stalling longer
   than the buffer.

## Unit coverage

- `src/frontend/lib/hls-manifest.test.ts` — parser + ABR ladder simulation.
- `src/frontend/lib/native-player.test.ts` — confirms hls.js is wired up
  for `.m3u8` sources on browsers without native HLS.
