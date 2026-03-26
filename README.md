# DiscordFrankenstein

Stream movies, TV series, and live sports to Discord voice channels via Go Live.

A Discord bot + selfbot that takes slash commands, finds streams via Stremio addons (Torrentio + RealDebrid), and pipes them through FFmpeg into Discord's Go Live feature with DAVE E2EE encryption.

## Quick Start

```bash
git clone https://github.com/Green-LED99/DiscordFrankenstein.git
cd DiscordFrankenstein
cp .env.example .env     # fill in your tokens
pnpm install             # installs deps + applies library patches
pnpm dev                 # starts the bot
```

## Requirements

- **Node.js** 18+
- **pnpm** (package manager)
- **FFmpeg** with libx264, libopus, and optionally NVENC/VAAPI
- A **Discord Bot Token** (from Discord Developer Portal)
- A **Discord User Token** (selfbot for Go Live streaming)
- A **Stremio Addon URL** (Torrentio configured with RealDebrid)

## Configuration

Create a `.env` file:

```env
# Required
BOT_TOKEN=your_bot_token
USER_TOKEN=your_user_token
STREMIO_ADDON_URL=https://torrentio.strem.fun/sort=seeders|qualityfilter=...|realdebrid=YOUR_KEY/manifest.json

# Optional
MAX_RESOLUTION=720       # 480, 720, or 1080
MAX_FPS=30               # max output framerate
VIDEO_BITRATE=1500       # kbps
HARDWARE_ACCEL=auto      # auto, nvidia, vaapi, or none
LOG_LEVEL=INFO           # DEBUG, INFO, WARN, ERROR
```

## Commands

### Content

| Command | Description | Example |
|---------|-------------|---------|
| `/movie title` | Stream a movie | `/movie F1` |
| `/series title [season] [episode]` | Stream a TV episode | `/series Family Guy season:2 episode:5` |
| `/live team` | Stream a live game | `/live White Sox` |

If season/episode aren't specified, a random episode is picked.

### Playback

| Command | Description | Example |
|---------|-------------|---------|
| `/pause` | Pause and save timestamp | |
| `/play` | Resume from saved timestamp | |
| `/skip seconds` | Skip forward/backward | `/skip seconds:30` or `/skip seconds:-60` |
| `/seek [hours] [minutes] [seconds]` | Jump to specific time | `/seek minutes:5 seconds:30` |
| `/np` | Show what's playing + timestamp | |
| `/next` | Play next episode in series | |
| `/autoplay` | Toggle auto-play next episode | |
| `/stop` | Stop the stream | |

### How It Works

1. You run `/movie Shrek` in a voice channel
2. Bot searches Cinemeta for the title, resolves the IMDB ID
3. Torrentio fetches available streams from RealDebrid
4. Top 5 streams shown as buttons sorted by seeders
5. After you pick a stream, ffprobe detects audio tracks and codecs
6. If multiple audio tracks exist, you choose which language
7. OpenSubtitles addon offers subtitle languages to burn in
8. FFmpeg transcodes to H.264 Baseline / Opus at 720p
9. The selfbot joins your voice channel and starts Go Live
10. DAVE E2EE encryption is handled by the streaming library

## Architecture

```
Discord User
    |
    v
[Bot Client] discord.js v14
    - Slash commands
    - Stream picker (buttons)
    - Audio/subtitle selection
    - Playback controls
    |
    v
[Services Layer]
    - Cinemeta: search movies/series, resolve IMDB IDs, episode metadata
    - Torrentio: fetch stream URLs via RealDebrid
    - OpenSubtitles: fetch/download SRT subtitles
    - FFprobe: detect codecs, audio tracks, resolution, B-frames, VFR
    |
    v
[Streamer Client] discord.js-selfbot-v13 + @dank074/discord-video-stream
    - FFmpeg transcode (H.264 Baseline, Opus, burned subtitles)
    - Auto-tuned encoder settings (benchmarks on startup)
    - NUT pipe to library demuxer
    - RTP packetization with DAVE E2EE
    - Go Live via Discord voice gateway
```

## Encoder Auto-Tuning

On startup, the bot benchmarks your system:

1. Tests NVIDIA NVENC, VAAPI, then CPU (libx264)
2. Tries resolutions (720p, 480p) and framerates (30, 24)
3. Picks the best preset that achieves 2x+ realtime speed
4. Caches the result for all subsequent streams

Override with `HARDWARE_ACCEL=none` to force CPU encoding.

## Library Patches

The bot patches `@dank074/discord-video-stream` via `pnpm patch` for:

- **Subtitle burning**: Injects subtitle filter into the library's `-vf` chain
- **Audio stream selection**: Dynamic `-map 0:a:N?` for multi-audio files
- **HLS User-Agent**: Separates `-user_agent` from `-headers` for HLS segments
- **A/V sync**: 50ms tolerance, deficit reset at 200ms, drift-proportional correction
- **Playout delay**: 0ms on both audio and video for minimal latency

Patches are applied automatically by `pnpm install`.

## Playback Controls

Pause/play uses FFmpeg's `-ss` (fast seek) to resume from the exact timestamp:

- `/pause` calculates elapsed time and saves it
- `/play` restarts FFmpeg with `-ss <saved_time>` before `-i`
- `/skip seconds:30` adds 30s to current position and restarts
- `/seek minutes:5` jumps to absolute time 5:00
- Subtitles are offset to match the seek position (SRT timestamps shifted)

## Autoplay

When enabled, the bot automatically plays the next episode when the current one ends:

1. Detects stream-end via `Promise.allSettled` on the FFmpeg + playStream promises
2. Fetches next episode from Cinemeta (same season next ep, or first ep of next season)
3. Auto-selects the top stream from Torrentio (most seeders)
4. Starts streaming without user interaction

Toggle with `/autoplay`.

## AMP Integration

Template files for CubeCoders AMP are in `amp/`:

- `discordfrankenstein.kvp` - Generic module configuration
- `discordfrankensteinconfig.json` - Settings (tokens, resolution, etc.)
- `discordfrankensteinmetaconfig.json` - Metadata

Install: Create a Generic instance in AMP, copy template files, clone repo into the instance directory.

## Development

```bash
pnpm dev          # run with tsx (hot reload)
pnpm build        # compile TypeScript to dist/
pnpm start        # run compiled dist/index.js
```

## Tech Stack

- **TypeScript** (strict mode, zero `any`)
- **discord.js** v14 (bot slash commands)
- **discord.js-selfbot-v13** (Go Live streaming)
- **@dank074/discord-video-stream** (RTP/DAVE/WebRTC)
- **FFmpeg** (transcode, subtitle burn, hardware acceleration)
- **Stremio Addon Protocol** (Cinemeta, Torrentio, OpenSubtitles)
- **pnpm** (package management + library patches)

## License

MIT
