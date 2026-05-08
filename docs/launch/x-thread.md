# X / Twitter launch thread

**Surface:** X (`https://x.com/compose/post`)
**When:** T-0 + 5 minutes (after HN post is live and the URL is captured)
**Account:** primary + cross-posted from a Cloudflare-adjacent burner if available

Post one tweet at a time. Don't drop it as a megapost — engagement is
much higher when each tweet is its own anchor. ~9 tweets total.

## 1/ Hook

```
i shipped spooool — a video host you can self-run for ~$2/mo, built
entirely on cloudflare. workers + r2 + stream + d1. zero servers, zero
external services for the core path.

(quick thread on what it is, why it exists, and what i learned)
```

## 2/ The pitch

```
2/ spooool is what i kept wanting and not finding:

- youtube-style video host
- self-hostable, MIT licensed
- no vps, no postgres, no s3, no kafka
- runs on a single cloudflare account
- adaptive HLS playback, channels, comments, search, watch history

it works. it's online. https://spooool.com
```

## 3/ The cost story

```
3/ the part i'm proudest of is the cost.

100 videos · 10k monthly views:
  ~$7-15 / mo with cloudflare stream encoding
  ~$0.50-2 / mo with the R2-only path (FFmpeg in a worker)

R2 egress = $0/GB. that single line item is what makes any of this
mathematically possible.
```

## 4/ Why one cloud

```
4/ "but what about lock-in?"

real concern. answer is honest: yes, this bets on cloudflare. the math
just doesn't work on s3+cloudfront+lambda — not even close.

storage + db are abstracted enough that a port is mechanical. but i
haven't done one. if you need portability today, peertube is the move.
```

## 5/ Stack note: the player

```
5/ swapped video.js → hls.js light + native-player adapter mid-build.

reason: video.js shipped ~120kb of UI we didn't use, and on iOS Safari
the native player is already excellent — just hand it the manifest.

result: smaller bundle, better mobile playback, less to maintain.
```

## 6/ Stack note: lifecycle state machine

```
6/ the un-sexy thing that mattered most: a real state machine for
video lifecycle.

uploaded → encoding → ready | failed | removed

before this we had ~5 boolean flags pretending to be a state. found
3 half-states immediately when we modeled it explicitly. classic.
```

## 7/ Stack note: AI Gateway

```
7/ every model call (recs ranking, mod assist) goes through one
cloudflare ai gateway endpoint with dynamic routes.

never an openai sdk import, never an anthropic url. switching providers
is a config change. a CI guard fails the build if anyone hardcodes a
provider.

it's a small thing that pays off forever.
```

## 8/ For builders

```
8/ if you want to fork this and run your own:

1. clone
2. wrangler login
3. create r2 bucket + d1 db
4. wrangler deploy

readme has the cost table, the architecture diagram, and the "should
i use stream or roll my own ffmpeg" decision tree.

repo: https://github.com/aloewright/spooool
```

## 9/ HN link (post-fill at launch time)

```
9/ launch discussion on HN — questions, feedback, "you're wrong about
egress" all welcome:

<HN URL — fill in after the show-hn post lands>
```

## Reply templates (for inevitable replies)

**"why not peertube"**

```
peertube is great if you want a server + federation. spooool is for
the "no server, no federation, just my videos" case.
```

**"this is just a wrapper around stream"**

```
fair if you only use the stream path. the R2-only path uses ffmpeg
in a worker for encoding — no stream involved. you can run either.
```

**"how much would this cost at scale"**

```
the math gets interesting around 1M monthly views — stream is still
fine but the R2-only path is where the savings go nonlinear. happy
to walk through your numbers if you want, dm me.
```

**"is this ai-generated"**

```
no. the only ML in the user-facing path is a small recs ranker via
the cloudflare ai gateway, and a content moderation assist that's
opt-in. all the application code is hand-written, MIT-licensed, in
the repo.
```

## Hashtags / mentions

Don't tack a `#cloudflare #buildinpublic` block on the end. It looks
spammy and X de-ranks tweets that look automated. If a hashtag belongs
in a tweet body it's already there in tweet 7.

Mention `@cloudflaredev` in tweet 8 only if their dev-rel team has
ack'd. Otherwise leave it off and let them retweet on their own
timeline.
