# spooool

[![CI](https://github.com/aloewright/spooool/actions/workflows/ci.yml/badge.svg)](https://github.com/aloewright/spooool/actions/workflows/ci.yml)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aloewright/spooool)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/allosaurus)

A video host that respects your time. Built **entirely on Cloudflare infrastructure** — zero external dependencies for core functionality.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge Network                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐    ┌──────────────────┐  ┌────────────────────┐   │
│  │   Workers    │──────│   Durable    │──────│ D1 Database    │   │
│  │  (Frontend   │    │   Objects    │    │  (Metadata) │   │
│  │   + API)     │    │  (Cache+     │    │             │   │
│  └──────────────────┘    │   State)     │    └────────────────────┘   │
│        │             └──────────────────┘                       │
│        │                     │                              │
│        ▼                     ▼                              │
│  ┌──────────────────┐    ┌──────────────────┐  ┌────────────────────┐   │
│  │  Pages       │    │   Stream     │──────│ R2 Storage  │   │
│  │  (Hosting)   │    │  (Encoding)  │    │  (Videos)   │   │
│  └──────────────────┘    └──────────────────┘    └────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Component Breakdown

| Component | Purpose | Cost |
|-----------|---------|------|
| **Workers** | Frontend (React SPA), Video API, Auth, Upload handler | $0.15/million requests |
| **Pages** | Static site hosting | Free |
| **Stream** | Video encoding/transcoding to HLS | $5-20/1000 min stored + $1/1000 min delivered |
| **R2** | Raw video storage (no egress fees) | $0.015/GB/month stored |
| **D1** | Video metadata, user data, playlists | Free tier (500k reads/writes) |
| **Durable Objects** | Session management, rate limiting, real-time features | $0.15/million ops |
| **KV** | Cache layer, temporary uploads | Free tier (100k reads/day) |

### Alternative: R2-Only Path (No Stream Cost)

For cost-conscious deployment:
- Use R2 + FFmpeg Worker for local encoding
- Generate HLS manifests on the fly
- Serve pre-encoded video tiers from R2
- **Est. Cost**: $0.015-0.05/GB/month (no transcoding fees)

## Features

### MVP Features
- ✅ Upload videos to R2 via Web UI
- ✅ Automatic encoding with Stream or local FFmpeg
- ✅ HLS video playback with adaptive bitrate
- ✅ Video browsing and search (D1 database)
- ✅ Responsive web player
- ✅ Channel/creator support
- ✅ View counts and engagement metrics

### Phase 2 Features
- Comments and nested replies (D1)
- Playlists and watch history (D1 + KV)
- User subscriptions (Durable Objects for real-time)
- Live streaming (Stream Live API)
- Analytics dashboard
- Content moderation queue
- Video recommendations engine

### Phase 3 Features
- Social features (likes, shares, pins)
- Premium memberships (Polar)
- Channel monetization (Polar partner payouts)
- Creator studio dashboard
- Advanced analytics
- A/B testing framework

## Quick Start

### Prerequisites
- Cloudflare account with Stream enabled
- Wrangler CLI installed
- Node.js 16+
- FFmpeg (if using local encoding path)

### Installation

```bash
# Clone and install
git clone https://github.com/aloewright/spooool.git
cd spooool
npm install

# Configure Wrangler
wrangler login

# Create R2 bucket
wrangler r2 bucket create spooool-videos

# Deploy database schema (includes better-auth tables)
wrangler d1 migrations apply spooool-prod --remote

# Set the better-auth signing secret (32+ random bytes)
openssl rand -hex 32 | wrangler secret put BETTER_AUTH_SECRET

# Deploy workers
wrangler deploy
```

### Environment Variables (.env.local)

```env
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
CLOUDFLARE_ZONE_ID=your_zone_id
CF_STREAM_TOKEN=your_stream_token
R2_BUCKET_NAME=spooool-videos
R2_BUCKET_DOMAIN=https://yourdomain.r2.cloudflareaaccess.com
DATABASE_URL=postgresql://...  # Only if using external DB
```

## Project Structure

```
spooool/
├── src/
│   ├── api/               # Workers endpoints
│   │   ├── videos.ts      # Video CRUD operations
│   │   ├── upload.ts      # Upload handler
│   │   ├── stream.ts      # Stream API wrapper
│   │   ├── auth.ts        # Authentication
│   │   └── search.ts      # Video search
│   ├── workers/
│   │   ├── index.ts       # Main Worker entry
│   │   ├── middleware.ts  # Auth, CORS, etc
│   │   └── encoding.ts    # FFmpeg encoding (R2 path)
│   ├── frontend/          # React SPA
│   │   ├── components/    # Video player, upload, etc
│   │   ├── pages/         # Watch, browse, channel
│   │   └── App.tsx
│   └── db/
│       ├── schema.sql     # D1 database schema
│       └── migrations/
├── wrangler.toml          # Wrangler configuration
├── package.json
└── README.md
```

## Configuration

### wrangler.toml

```toml
name = "spooool"
type = "javascript"
account_id = "your_account_id"
workers_dev = true
route = "api.spooool.com/*"

[env.production]
route = "api.spooool.com/*"

[[r2_buckets]]
binding = "VIDEOS"
bucket_name = "spooool-videos"

[[d1_databases]]
binding = "DB"
database_name = "spooool-prod"
database_id = "your_database_id"

[[kv_namespaces]]
binding = "CACHE"
id = "your_kv_namespace_id"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiter"
script_name = "spooool"

[env.production.env]
ENVIRONMENT = "production"
API_HOST = "https://api.spooool.com"
```

## Deployment

### Deploy to Cloudflare Workers

```bash
# Development
wrangler dev

# Production
wrangler deploy --env production

# Create Pages project
wrangler pages project create spooool-web

# Deploy frontend
wrangler pages deploy ./dist --project-name spooool-web
```

### Using Stream for Encoding

```bash
# Enable Stream API in Cloudflare Dashboard
# Then configure in wrangler.toml with Stream API token
```

### Using R2 + Local Encoding Path

```bash
# Deploy encoding Worker separately
wrangler deploy --name spooool-encoder

# Or use scheduled Worker for batch encoding
# Configure in wrangler.toml:
[triggers]
crons = ["0 */4 * * *"]  # Run every 4 hours
```

## API Endpoints

### Video Management

```
POST   /api/videos/upload           # Upload video
GET    /api/videos/:id              # Get video details
GET    /api/videos                  # List/search videos
PUT    /api/videos/:id              # Update metadata
DELETE /api/videos/:id              # Delete video
GET    /api/videos/:id/stream       # Get HLS stream URL
```

### Authentication

```
POST   /api/auth/register           # Register user
POST   /api/auth/login              # Login
POST   /api/auth/logout             # Logout
GET    /api/auth/me                 # Get current user
```

### Channels

```
GET    /api/channels/:username      # Get channel
PUT    /api/channels/:username      # Update channel
POST   /api/channels/:username/follow   # Follow channel
GET    /api/channels/:username/videos   # Get channel videos
```

## Video Processing Workflows

### Stream Path (Easiest)

```
1. Upload video → R2
2. POST /api/videos/upload with R2 path
3. Trigger Stream encoding
4. Stream processes and stores HLS in R2
5. Get manifest URL from Stream API
6. Client plays via HLS manifest
```

### R2-Only Path (Cheapest)

```
1. Upload video → R2 (raw)
2. Scheduled Worker triggers encoding
3. FFmpeg container encodes to HLS
4. Store output segments + manifest in R2
5. Generate signed URLs
6. Client plays via R2-hosted HLS manifest
```

## Performance Optimizations

### Caching Strategy
- Cache video manifests: 1 hour (KV)
- Cache metadata: 10 minutes (KV)
- Cache search results: 5 minutes (KV)
- Edge caching via Stream CDN

### Upload Optimization
- Chunked upload to R2 (5MB chunks)
- Parallel chunk uploads
- Resume capability via R2 API

### Playback Optimization
- Adaptive bitrate (HLS variants)
- Preload next chunk
- Connection adaptive switching
- Geographic edge routing

## Cost Analysis

### Scenario: 100 videos, 1GB stored, 10k monthly views

| Component | Usage | Cost |
|-----------|-------|------|
| Workers | 100k requests | $0.015 |
| Stream (if used) | 1GB stored + 10k plays | $7-15 |
| R2 Storage | 1GB | $0.015 |
| D1 | 50k queries | Free |
| KV Cache | 10k reads | Free |
| **Total** | | **$7.03-15.03/month** |

### With Local Encoding (R2-only path)
- **Storage**: $0.015/GB/month
- **Compute**: $0.15 per 100k CPU-ms (FFmpeg)
- **Est. total**: $0.50-2/month at 10k views

## Security Considerations

- ✅ Token-based auth (JWT in KV)
- ✅ CORS validation on all endpoints
- ✅ Rate limiting via Durable Objects
- ✅ Signed R2 URLs (time-limited)
- ✅ Content security policies
- ✅ DDoS protection via Cloudflare
- ⚠️ TODO: DMCA takedown handling
- ⚠️ TODO: Content moderation API

## Troubleshooting

### Videos not encoding
```bash
# Check Stream status
curl https://api.cloudflare.com/client/v4/accounts/{account_id}/stream/{video_id} \
  -H "Authorization: Bearer {token}"

# Check R2 upload
wrangler r2 object list spooool-videos
```

### High egress costs
- Verify Stream is enabled (R2 → Stream egress is free)
- Or switch to R2-only path with local FFmpeg
- Use signed URLs with CF cache

### Worker timeouts
- Break uploads into chunks
- Use Queue for async processing
- Deploy separate encoding Worker

## Contributing

Contributions welcome! Areas needing help:
- Video player UI improvements
- Comment system implementation
- Search ranking algorithm
- Encoding optimization
- Mobile app (Tauri)

## Roadmap

- [ ] MVP with Stream encoding (Week 1-2)
- [ ] R2-only local encoding path (Week 2-3)
- [ ] Authentication system (Week 3)
- [ ] Channel/creator system (Week 4)
- [ ] Analytics dashboard (Week 4)
- [ ] Live streaming support (Week 5)
- [ ] Mobile app with Tauri (Week 6+)

## License

MIT - Build your own video platform!

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare Stream Docs](https://developers.cloudflare.com/stream/)
- [Cloudflare R2 Docs](https://developers.cloudflare.com/r2/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [Video.js Documentation](https://docs.videojs.com/)
- [HLS Streaming Guide](https://datatracker.ietf.org/doc/html/rfc8216)

## Support

- Issues: [GitHub Issues](https://github.com/aloewright/spooool/issues)
- Discussions: [GitHub Discussions](https://github.com/aloewright/spooool/discussions)
- Email: support@spooool.com

---

**Building the future of video on Cloudflare** 🚀
