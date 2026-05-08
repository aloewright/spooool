# Demo video — script + production plan

**Length:** 60-90 seconds (HN/X attention budget; 60s preferred)
**Aspect:** 16:9 1920×1080 master, 1:1 1080×1080 for X, 9:16 1080×1920
            for any short-form republish
**Voice:** First-person, conversational, no music bed under VO
**Format:** Screen-cap with picture-in-picture webcam in corner
            (optional — fine to ship VO-only)
**Where it lives:** Embedded on `https://spooool.com` homepage
                    (autoplay muted, loop), uploaded to YouTube as
                    canonical, linked from each launch post

## Master shot list (60s)

| t | Shot | VO | On-screen |
|---|---|---|---|
| 0:00 | Logo + URL | "spooool — a self-hostable YouTube alternative." | spooool.com clean |
| 0:03 | Homepage scroll | "Built entirely on Cloudflare. Workers, R2, Stream, D1." | Homepage hero, tile grid |
| 0:08 | Sign-up flow | "Sign up — email + password, magic link if you want." | Login screen, type, click |
| 0:14 | Upload click | "Upload a video. Goes straight to R2." | Upload button → file picker → progress bar |
| 0:22 | Encoding state | "Stream encodes it. Or your own FFmpeg-in-a-Worker if you want to skip the bill." | Lifecycle UI ticking through states |
| 0:30 | Watch page | "HLS playback. Adaptive bitrate. Comments. Shareable." | Watch page playing, comment posted |
| 0:38 | Channel page | "Each user gets a channel. Search the whole site. FTS-backed." | /channel/aloe + /search?q=demo |
| 0:46 | Cost callout | "100 videos, 10k monthly views — about two dollars a month." | Animated cost counter |
| 0:52 | Repo + license | "Open source. MIT. Run your own." | github.com/aloewright/spooool, MIT badge |
| 0:58 | URL hold | "spooool.com" | spooool.com end card 2s |

## Voice-over script (paste into prompter)

```
spooool — a self-hostable YouTube alternative,
built entirely on Cloudflare.

Workers handle the app. R2 stores the videos.
Stream encodes them, or — if you want to skip
the bill — your own FFmpeg in a Worker.
D1 has the metadata.

Sign up. Upload. Wait a minute for encoding.
Watch in HLS with adaptive bitrate.
Comments, channels, search — all of it.

A hundred videos, ten thousand monthly views —
about two bucks a month.

Open source. MIT-licensed. Run your own.

spooool dot com.
```

(58-62 seconds at a relaxed cadence. Don't rush.)

## Recording / capture checklist

- [ ] Record at 60fps, downsample for delivery — looks crisper on
      static UI shots
- [ ] Hide all browser bookmarks, switch to a clean profile
- [ ] Disable browser dev-tools auto-open
- [ ] Demo account with at least 6 pre-uploaded test videos so the
      tile grid isn't empty in the homepage shot
- [ ] Cursor highlighter on (CleanShot or Cursor Pro)
- [ ] Record the upload flow with a real ~30s test clip — fake
      progress bars look fake
- [ ] Record the encoding state with the lifecycle state machine
      actually ticking through; do not edit a fake transition in
- [ ] Real comment text, not lorem ipsum
- [ ] If using webcam PiP, frame chest-up, even lighting, no
      backlight from window

## Editing notes

- Cut hard between scenes; no fades. Keeps it punchy.
- Bake captions in (Helvetica Neue / Inter, 48pt, off-white,
  bottom-third). Many HN/Reddit viewers watch muted.
- Don't speed up the encoding wait. Use a hard cut + a "~1 minute
  later" caption. Speed-ups feel dishonest.
- End card holds for 2s with the URL frozen — gives screenshot
  shareability.

## Distribution

| Where | Format | When |
|---|---|---|
| YouTube (canonical, public, unlisted-during-launch then public T-0) | 1080p 16:9 | Upload T-1d, flip to public T-0 |
| Homepage hero | 1080p 16:9 muted autoplay loop | Deployed T-1d |
| X | Native upload, 1:1 1080×1080, captions burned in | T-0 + 5min in tweet 1 of thread |
| HN body | Link to YouTube (HN doesn't render embeds) | T-0 |
| Reddit (both) | Link to YouTube; native uploads disabled | T-0 + 30/60min |

## Fallback plan

If the demo isn't recorded by T-2d, post launch with a static
homepage screenshot + a "demo coming Thursday" line. Do not
launch with a half-baked demo. A missing video is better than a
mediocre one — for HN especially, a bad video sets the post tone
and is hard to recover from.
