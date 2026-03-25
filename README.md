# DiscordFrankenstein

A Discord application that streams movies and TV series to voice channels via Go Live. Uses a bot for slash commands and a selfbot for video streaming with DAVE (E2EE) protocol support.

## Architecture

```
User runs /movie or /series in Discord
            |
   [Discord Bot] (discord.js v14)
    - Receives slash command
    - Shows top 5 streams as buttons for user to pick
    - Searches TMDB for content metadata
    - Resolves IMDB ID for Torrentio lookup
    - Fetches stream URLs from Torrentio + RealDebrid
            |
   [Selfbot Streamer] (discord.js-selfbot-v13 + @dank074/discord-video-stream)
    - Joins the user's voice channel
    - Probes source stream with ffprobe
    - Decides copy mode vs transcode based on source properties
    - Launches FFmpeg pipeline (NUT output format)
    - Streams via Go Live with DAVE E2EE encryption (@snazzah/davey)
    - Library handles PTS-based A/V sync with 50ms tolerance (patched)
    - RTP packetization with codec-aware DAVE frame encryption
```

### Data Flow

```
Torrentio/RealDebrid HTTP URL
    -> FFmpeg (transcode or copy)
    -> NUT pipe (interleaved A/V packets with PTS)
    -> node-av demuxer (extracts packets, highWaterMark: 8)
    -> VideoStream + AudioStream (precisionSleep pacing, video syncs to audio)
    -> WebRTC connection (RTP packets, DAVE encryption, zero playout delay)
    -> Discord voice server (SFU relay)
    -> Viewers
```

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/movie <title>` | Stream a movie | `/movie F1` |
| `/series <title> [season] [episode]` | Stream a TV episode | `/series Family Guy season 2 episode 5` |
| `/stop` | Stop the current stream | `/stop` |

- Both `/movie` and `/series` show the **top 5 streams** as numbered buttons, sorted by seeders. The user picks which one to play.
- If neither season nor episode are specified for `/series`, both are chosen randomly.
- If season is specified but episode is not, a random episode from that season is picked.
- If episode is specified but season is not, it defaults to season 1.

## Prerequisites

- **Node.js** >= 18
- **pnpm** package manager (v10+)
- **FFmpeg** with libopus, libzmq, and optionally NVENC/VAAPI support
- A Discord **bot** token with `applications.commands` scope
- A Discord **user** token for the selfbot streamer
- A **TMDB** API key (v3)
- A **Stremio/Torrentio** addon URL with RealDebrid configured

## Setup

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd DiscordFrankenstein
   ```

2. Install dependencies (this also applies library patches):
   ```bash
   pnpm install
   ```

3. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your tokens and keys
   ```

4. Build and run:
   ```bash
   pnpm build
   pnpm start
   ```

   Or for development:
   ```bash
   pnpm dev
   ```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | Yes | - | Discord bot token |
| `USER_TOKEN` | Yes | - | Discord user token for the selfbot streamer |
| `TMDB_API_KEY` | Yes | - | TMDB v3 API key |
| `STREMIO_ADDON_URL` | Yes | - | Full Torrentio addon URL with RealDebrid key (without `/manifest.json`) |
| `MAX_RESOLUTION` | No | `720` | Max output resolution: `720` or `480` |
| `MAX_FPS` | No | `30` | Max framerate: `30` or `24` |
| `VIDEO_BITRATE` | No | `2500` | Target video bitrate in kbps |
| `HARDWARE_ACCEL` | No | `auto` | Hardware acceleration: `auto`, `nvidia`, `vaapi`, or `none` |
| `LOG_LEVEL` | No | `INFO` | Logging level: `DEBUG`, `INFO`, `WARN`, or `ERROR` |

All required variables are validated at startup. Invalid integer values or unrecognized `HARDWARE_ACCEL` values cause an immediate exit with a descriptive error.

## Auto-Tuning

On startup, the application benchmarks FFmpeg encoding to find optimal settings for your hardware:

1. Detects available hardware acceleration (NVENC, VAAPI)
2. Runs a 5-second encoding benchmark with test patterns
3. Requires **>= 2x realtime** speed to validate a configuration
4. For hardware encoders: tests at the configured max resolution/fps
5. For software encoders: iterates presets (medium -> ultrafast) and resolutions (720p -> 480p) until one passes
6. Falls back to ultrafast 480p@24fps if nothing passes

Results are cached for the session lifetime.

## Copy Mode

When the source video meets **all** of these criteria, FFmpeg uses copy mode (no video transcoding):

- Codec is H.264
- Resolution is <= configured max (default 1280x720)
- Frame rate is <= configured max (default 30fps)
- **No B-frames** (B-frames cause non-monotonic PTS which breaks the library's pacing)
- **Not VFR** (variable frame rate causes uneven pacing in copy mode)

In copy mode:
- Video is passed through as-is with `-bsf:v h264_mp4toannexb` (overrides the NUT muxer's `h264_metadata` BSF that crashes on many Torrentio streams)
- Audio is always transcoded to Opus at 48kHz stereo (Discord requirement)
- If copy mode fails, the bot automatically retries with full transcoding

## A/V Synchronization

Audio/video sync is handled at multiple levels:

### FFmpeg Level (timestamp production)

Input flags:
- `-fflags +nobuffer+genpts+discardcorrupt` — low-latency, generate PTS, drop corrupt packets
- `-flags low_delay` — minimize codec-level buffering
- `-thread_queue_size 4096` — prevent packet queue blocking on HTTP sources
- `-analyzeduration 10000000 -probesize 10000000` — thorough stream analysis for RealDebrid sources

Output flags:
- `-fps_mode cfr` — constant frame rate (transcode mode only)
- `-avoid_negative_ts make_zero` — normalize negative timestamps
- `-sc_threshold 0` — no scene-change keyframes (consistent GOP)

The transcode framerate **matches the source** (e.g., 24fps source outputs at 24fps, not forced to 30fps) to avoid 3:2 pulldown judder.

NVENC-specific:
- `-rc-lookahead 0 -delay 0 -forced-idr 1` — zero-latency encoding, force IDR keyframes

### Library Level (patched via pnpm patch)

The `@dank074/discord-video-stream` library is patched with four changes:

1. **`precisionSleep`** — hybrid `setTimeout` + spin-wait for sub-millisecond accuracy. Windows `setTimeout` has ~15.6ms resolution which causes visible stutter at 24-30fps. precisionSleep wakes 2ms early then spin-waits for the remainder.

2. **No `resetTimingCompensation()`** on sync correction — the original library resets its PTS-to-wall-clock reference every time the sync mechanism corrects, causing timing discontinuities visible as stutter. The patch removes this, matching WrappedStream's approach.

3. **`syncTolerance` = 50ms** (up from 20ms) — reduces overcorrection frequency for HTTP-sourced streams with natural timestamp jitter.

4. **Demuxer `highWaterMark` = 8** (down from 128) — reduces packet buffering in the NUT demuxer pipes, preventing burst reads that cause uneven frame delivery.

5. **`playoutDelayMax` = 0** on both audio and video (down from audio=1/video=10) — forces Discord's client to render both streams immediately with zero jitter buffer. The original values allowed video to be buffered up to 1 second while audio played immediately, causing a ~1s audio-ahead-of-video offset.

### Runtime Monitoring

The sync monitor parses FFmpeg stderr for encoding speed:
- Warns when average speed drops below 1.5x realtime
- Triggers drift callback after 5 consecutive warnings
- Resets warnings when speed recovers above 2.0x

## DAVE Protocol (E2EE)

Discord's Audio/Video End-to-End Encryption is handled by the `@dank074/discord-video-stream` library via `@snazzah/davey`:

- MLS key exchange with ciphersuite `DHKEMP256_AES128GCM_SHA256_P256`
- Per-sender AES-128-GCM symmetric encryption
- Codec-aware frame encryption (H264 NAL unit handling, Opus full encryption)
- `max_dave_protocol_version` negotiated in voice gateway Identify
- Automatic passthrough for non-E2EE channels
- DAVE has been mandatory since March 1, 2026

## Stream Selection

Users are presented with the **top 5 streams** as Discord buttons, sorted by:
1. **Seeders** (most available/reliable first)
2. **Resolution** (highest within max)
3. **Codec** (H.264 preferred for copy mode compatibility)
4. **File size** (larger = better quality)

Each button shows: resolution, codec, file size, and seeder count. The user has 30 seconds to pick before the selection times out.

## Error Handling

- **Copy mode failure**: Auto-retries with full transcoding on any copy mode error (e.g., malformed H264 NAL units from Torrentio sources)
- **Voice connection stale**: `cleanup()` always calls `stopStream()` and `leaveVoice()` on both natural end and error, preventing stale voice connections
- **Stream replacement**: Starting a new stream while one is active cleanly stops the old one first
- **Interaction timeout**: `deferReply()` is called immediately on all commands to avoid Discord's 3-second timeout
- **Button picker**: Uses `deferUpdate()` to acknowledge button clicks without corrupting the parent interaction state
- **Graceful shutdown**: SIGINT/SIGTERM handlers destroy both clients cleanly

## AMP Deployment

DiscordFrankenstein includes a CubeCoders AMP Generic Module template. A template repository is available at [Green-LED99/AMPTemplates](https://github.com/Green-LED99/AMPTemplates).

### Setup via AMP Template Repository

1. In AMP web panel, go to **Configuration -> Instance Deployment**
2. Add repository: `Green-LED99/AMPTemplates:master`
3. Click **Fetch** and refresh the browser
4. Create a new instance using the **DiscordFrankenstein** template
5. Clone this repo into the instance's `GenericApplication` directory
6. Click **Update** to run `pnpm install` (applies library patches) and `pnpm build`
7. Configure tokens in the **Settings** tab
8. Click **Start**

### Manual Setup

1. Copy template files from `amp/` into your AMP instance:
   - `discordfrankenstein.kvp`
   - `discordfrankensteinconfig.json`
   - `discordfrankensteinmetaconfig.json`
2. Clone the repo, install, build, configure, start

AMP monitors stdout for `Bot ready` to confirm startup and watches `ffmpeg` child processes.

## Project Structure

```
src/
  index.ts                Entry point with graceful shutdown
  bot/
    client.ts             Discord.js bot initialization
    interactions.ts       Interaction router (defer + dispatch)
    commands/
      register.ts         Slash command registration (global)
      movie.ts            /movie command handler
      series.ts           /series command handler
      stop.ts             /stop command handler
      picker.ts           Stream selection UI (Discord buttons)
  streamer/
    client.ts             Selfbot + Streamer singleton
    stream.ts             Go Live streaming lifecycle (start/stop/retry)
    encoder.ts            FFmpeg settings, auto-tuner, A/V sync flags
  services/
    tmdb.ts               TMDB API client (search, external IDs, episode resolution)
    torrentio.ts          Torrentio stream fetcher + ranker
    ffprobe.ts            Stream probing (codec, resolution, fps, B-frames, VFR)
  utils/
    config.ts             Environment variable loader with validation
    logger.ts             Structured logger with level filtering
    sync.ts               FFmpeg encoding speed monitor
amp/
  *.kvp, *.json           CubeCoders AMP Generic Module template files
patches/
  @dank074__discord-video-stream@6.0.0.patch
                          Library patch (precisionSleep, sync tolerance,
                          demuxer buffer, playout delay)
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Bot | discord.js v14 | Slash commands, interaction handling |
| Selfbot | discord.js-selfbot-v13 | Voice channel + Go Live |
| Streaming | @dank074/discord-video-stream v6 (patched) | FFmpeg pipeline, NUT demuxing, RTP packetization |
| E2EE | @snazzah/davey | DAVE protocol (MLS + AES-128-GCM) |
| Transcoding | FFmpeg (h264_nvenc / libx264) | Video encode, audio -> Opus |
| Content Search | TMDB API v3 | Movie/TV metadata, IMDB ID resolution |
| Stream Source | Torrentio + RealDebrid | HTTP stream URLs for content |
| Language | TypeScript (strict, ESM) | Type safety, modern module system |

## Known Limitations

- Always picks the first TMDB search result (no disambiguation UI)
- No permission checks on `/stop` (any server member can stop)
- Global slash command registration takes up to 1 hour to propagate
- `MAX_RESOLUTION=1080` is not fully supported (encoder only benchmarks 720p and 480p)
- No retry logic on TMDB/Torrentio HTTP requests (transient failures fail the command)
- Selfbot usage violates Discord ToS (risk of account ban)

## License

MIT
