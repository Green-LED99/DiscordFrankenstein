# DiscordFrankenstein

A Discord bot that streams movies, TV series, and live sports directly into Discord voice channels via Go Live. It uses a dual-client architecture: one official bot for slash commands, and one user account (selfbot) that joins voice and broadcasts video through Discord's Go Live feature.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running](#running)
- [Commands](#commands)
- [Architecture](#architecture)
- [How Streaming Works](#how-streaming-works)
- [Content Sources](#content-sources)
- [Playback System](#playback-system)
- [Encoding Pipeline](#encoding-pipeline)
- [Hardware Acceleration](#hardware-acceleration)
- [File Reference](#file-reference)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)

---

## Prerequisites

You need ALL of the following installed and available before starting:

### Required Software

| Software | Minimum Version | Purpose | Install |
|----------|----------------|---------|---------|
| **Node.js** | 22.4.0 | Runtime | https://nodejs.org (use LTS 22.x+) |
| **pnpm** | 10.33.0 | Package manager | `npm install -g pnpm@10.33.0` |
| **FFmpeg** | 6.0+ | Video transcoding | https://ffmpeg.org/download.html |
| **FFprobe** | (bundled with FFmpeg) | Stream analysis | Included with FFmpeg |

FFmpeg and FFprobe must be on your system PATH. Verify:

```bash
node --version    # Must be >= 22.4.0
pnpm --version    # Must be >= 10.33.0
ffmpeg -version   # Must return version info
ffprobe -version  # Must return version info
```

### Required Accounts and Tokens

You need **two** Discord accounts and one streaming service:

1. **Discord Bot Application** (the slash command bot)
   - Go to https://discord.com/developers/applications
   - Create a new application
   - Go to "Bot" tab, create a bot, copy the **Bot Token** (`BOT_TOKEN`)
   - Under "Privileged Gateway Intents", enable **Server Members Intent** and **Message Content Intent** (not strictly required but recommended)
   - Go to "OAuth2" > "URL Generator", select scopes: `bot`, `applications.commands`
   - Select permissions: `Send Messages`, `Connect`, `Speak`
   - Use the generated URL to invite the bot to your server

2. **Discord User Account** (the selfbot that Go Lives)
   - This is a regular Discord user account (NOT a bot)
   - This account must be in the same server as the bot
   - You need its **User Token** (`USER_TOKEN`)
   - This account will appear as "Go Live" in voice channels when streaming

3. **Stremio Torrentio Addon with RealDebrid**
   - Go to https://torrentio.strem.fun/configure
   - Configure with your RealDebrid API key
   - Copy the full addon URL — it looks like: `https://torrentio.strem.fun/realdebrid=YOURAPIKEY/`
   - This is your `STREMIO_ADDON_URL`

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/Green-LED99/DiscordFrankenstein.git
cd DiscordFrankenstein

# 2. Install dependencies (pnpm applies the library patch automatically)
pnpm install

# 3. Create your .env file (see Configuration below)

# 4. Build the TypeScript
pnpm build

# 5. Run
pnpm start
```

If `pnpm install` fails on native modules, ensure you have build tools:
- **Windows**: `npm install -g windows-build-tools` or install Visual Studio Build Tools
- **Linux**: `sudo apt install build-essential python3`
- **macOS**: `xcode-select --install`

---

## Configuration

Create a `.env` file in the project root with these variables:

### Required Variables

```env
# Discord bot token (from Developer Portal > Bot > Token)
BOT_TOKEN=your_bot_token_here

# Discord user token (the account that will Go Live)
USER_TOKEN=your_user_token_here

# Stremio Torrentio addon URL (with RealDebrid configured)
# Get this from https://torrentio.strem.fun/configure
STREMIO_ADDON_URL=https://torrentio.strem.fun/realdebrid=YOURAPIKEY/
```

### Optional Variables

```env
# Maximum output resolution in pixels (default: 720)
# Options: 2160, 1080, 720, 480
MAX_RESOLUTION=720

# Maximum output frame rate (default: 30)
MAX_FPS=30

# Video bitrate in kbps (default: 1500)
VIDEO_BITRATE=1500

# Hardware acceleration mode (default: auto)
# Options: auto, nvidia, vaapi, none
# - auto: detects NVIDIA NVENC or VAAPI, falls back to software
# - nvidia: force NVIDIA NVENC (requires NVIDIA GPU + CUDA drivers)
# - vaapi: force VAAPI (Linux Intel/AMD GPU)
# - none: force software encoding (libx264, works everywhere)
HARDWARE_ACCEL=auto

# Log verbosity (default: INFO)
# Options: DEBUG, INFO, WARN, ERROR
LOG_LEVEL=INFO
```

### Configuration Validation

On startup, the bot validates all configuration. If a required variable is missing or an optional variable has an invalid value, it exits immediately with a clear error message:

```
[FATAL] Missing required environment variable: BOT_TOKEN
[FATAL] Invalid HARDWARE_ACCEL: "gpu". Must be one of: auto, nvidia, vaapi, none
[FATAL] Invalid integer for MAX_FPS: "thirty"
```

---

## Running

### Production

```bash
pnpm build    # Compile TypeScript to dist/
pnpm start    # Run compiled JavaScript
```

### Development

```bash
pnpm dev      # Run TypeScript directly with tsx (hot reload)
```

### Startup Sequence

When the bot starts, it performs these steps in order:

1. **Load configuration** — Validates all environment variables
2. **Auto-tune encoder** — Benchmarks FFmpeg to find the best resolution/FPS/preset that maintains 2x+ realtime encoding speed
3. **Initialize selfbot** — Logs in the user account that will Go Live
4. **Initialize bot** — Logs in the bot account, registers slash commands
5. **Register commands** — Clears stale global commands, then PUTs all 11 slash commands to each guild

Expected startup logs:

```
[INFO] [Main] DiscordFrankenstein starting...
[INFO] [Main] Configuration loaded
[INFO] [Main] Running encoder auto-tune...
[INFO] [Encoder] Benchmark: 1280x720@30fps preset=medium -> speed=15.80x
[INFO] [Encoder] Auto-tune result: 1280x720@30fps preset=medium (speed: 15.80x)
[INFO] [Main] Auto-tune complete: 1280x720@30fps preset=medium hwaccel=none
[INFO] [Main] Initializing streamer client...
[INFO] [StreamerClient] Selfbot logged in as YourUserAccount
[INFO] [Main] Initializing bot client...
[INFO] [Bot] Bot logged in as YourBot#1234
[INFO] [Commands] Cleared global commands
[INFO] [Commands] Registering 11 commands to 2 guild(s)...
[INFO] [Commands] Registered 11 commands in Your Server
[INFO] [Commands] Guild command registration complete
[INFO] [Main] Bot ready
```

### Stopping

Press `Ctrl+C` or send `SIGTERM`. The bot will:
1. Stop any active stream
2. Kill FFmpeg processes
3. Disconnect the selfbot from voice
4. Destroy both Discord clients
5. Exit cleanly

---

## Commands

All commands are ephemeral (only visible to the user who ran them). You must be in a voice channel to use streaming commands.

### Streaming Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/movie <title>` | Stream a movie | `/movie Fight Club` |
| `/series <title> [season] [episode]` | Stream a TV episode. Picks a random episode if season/episode are omitted. | `/series Family Guy 5 3` |
| `/live <team>` | Stream a live sports game. Fuzzy-matches team names and abbreviations. | `/live Lakers` |

### Playback Controls

| Command | Description | Notes |
|---------|-------------|-------|
| `/pause` | Pause the stream. Saves current timestamp, kills FFmpeg, leaves voice. | Not available for live streams. |
| `/play` | Resume from where you paused. Restarts FFmpeg with `-ss` seek. | Only works after `/pause`. |
| `/skip <seconds>` | Jump forward or backward by N seconds. Negative values rewind. | `/skip -30` rewinds 30s. Not available for live streams. |
| `/seek [hours] [minutes] [seconds]` | Jump to an exact timestamp. | `/seek 0 45 0` jumps to 45:00. Not available for live streams. |
| `/np` | Show what's currently playing with elapsed time. | Works while playing or paused. |
| `/next` | Play the next episode in the current series. | Only works when a series is playing or paused. |
| `/autoplay` | Toggle automatic next-episode playback. When enabled, the next episode starts automatically when the current one ends. | Only works with series. |
| `/stop` | Stop everything. Kills the stream, clears paused state, disables autoplay. | |

### How Skip and Seek Work

Skip and seek use an atomic restart approach:
1. Capture the current stream's full state (URL, headers, audio track, etc.)
2. Tear down the current FFmpeg process and leave voice
3. Wait 1 second for OS process cleanup
4. Verify no zombie FFmpeg processes remain
5. Rejoin voice and start a new FFmpeg process with `-ss <timestamp>` for keyframe-based fast seeking

This is handled by `restartAtPosition()` in `stream.ts` under a single mutex lock to prevent race conditions.

### How Autoplay Works

1. User enables autoplay with `/autoplay` while a series is playing
2. A callback is registered that will fire when the current stream ends
3. When the stream ends (naturally or via watchdog timeout):
   - Full teardown runs (FFmpeg kill, voice leave)
   - 1-second delay for process reaping
   - Zombie FFmpeg check
   - The callback fetches the next episode from Cinemeta
   - Auto-selects the top-ranked stream from Torrentio
   - Starts the new stream with updated series metadata
   - Re-registers the callback for the next episode
4. Autoplay disables automatically when there are no more episodes or no streams are found

---

## Architecture

```
                    Discord Server
                    ┌─────────────────────────┐
                    │                         │
User ──slash cmd──> │  Dr. Frankenstein (Bot)  │ <── discord.js v14
                    │  Handles commands,       │     Slash commands, interactions
                    │  UI (pickers, buttons)   │
                    │                         │
                    │  greenl.e.d (Selfbot)    │ <── discord.js-selfbot-v13
                    │  Joins voice, Go Lives   │     + @dank074/discord-video-stream
                    │  Streams video+audio     │
                    └─────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │     FFmpeg        │
                    │  H.264 Baseline   │
                    │  Opus 128kbps     │
                    │  -> NUT pipe ->   │
                    │  Discord RTP/DAVE │
                    └───────────────────┘
```

### Dual-Client Model

- **Bot Client** (`discord.js`): A standard Discord bot that registers slash commands and handles user interactions. It cannot Go Live — only user accounts can.
- **Selfbot Client** (`discord.js-selfbot-v13`): A user account that joins voice channels and uses the Go Live feature to broadcast video. The `@dank074/discord-video-stream` library handles the WebRTC/RTP/DAVE protocol layer.

### State Management

All stream state is managed in `src/streamer/stream.ts` with a single async mutex lock (`streamLock`) protecting all transitions:

- `activeStream` — Currently playing stream (FFmpeg process, timers, metadata)
- `pausedState` — Saved state from `/pause` (URL, timestamp, audio track, etc.)
- `autoplayEnabled` + `autoplayCallback` — Autoplay state and trigger function
- `lastKnownGuildId` + `lastKnownChannelId` — For autoplay to know where to rejoin

Every public function that modifies state (`startVideoStream`, `pauseStream`, `restartAtPosition`, `stopVideoStream`, `handleStreamEnd`) acquires the lock first. This prevents race conditions between user commands and stream-end events.

---

## How Streaming Works

### Movie/Series Flow

```
/movie "Fight Club"
    |
    v
1. Search Cinemeta --> GET v3-cinemeta.strem.io/catalog/movie/top/search=Fight%20Club.json
    |                  Returns: { id: "tt0137523", name: "Fight Club", year: "1999" }
    v
2. Fetch Streams ----> GET torrentio.strem.fun/.../stream/movie/tt0137523.json
    |                 Returns: Array of stream objects with URLs, seeders, resolution
    v
3. Rank & Filter ----> Sort by: seeders DESC, resolution DESC, h264 codec bonus, size DESC
    |                 Filter to MAX_RESOLUTION, take top 5
    v
4. User Picks -------> Discord button UI (30s timeout, auto-selects if only 1 stream)
    |
    v
5. Probe Stream -----> ffprobe analyzes URL: codec, resolution, FPS, audio tracks
    |
    v
6. Audio/Sub Pick ---> User selects audio track and subtitle language via buttons
    |
    v
7. Start Stream -----> Selfbot joins voice -> FFmpeg encodes -> Go Live broadcasts
```

### Live Sports Flow

```
/live "Lakers"
    |
    v
1. Fetch Events -----> Scrape sportsurge.ws for live game links
    |
    v
2. Fuzzy Match ------> Token-based scoring with team alias expansion
    |                  "Lakers" expands to ["lakers", "los", "angeles"]
    v
3. User Picks -------> Button UI if multiple matches (auto-select if 1)
    |
    v
4. Resolve URL ------> Fetch event page -> extract embed ID -> decode base64 HLS URL
    |
    v
5. Probe & Stream ---> ffprobe -> FFmpeg with auth headers -> Go Live
```

---

## Content Sources

### Cinemeta (Movie/Series Metadata)

- **Base URL**: `https://v3-cinemeta.strem.io`
- **Search**: `/catalog/{movie|series}/top/search={query}.json`
- **Series metadata**: `/meta/series/{imdbId}.json` (includes all episodes)
- **Timeout**: 15 seconds
- Returns IMDB IDs, names, years, episode lists

### Torrentio (Stream URLs)

- **Base URL**: Your configured `STREMIO_ADDON_URL`
- **Movie streams**: `/stream/movie/{imdbId}.json`
- **Series streams**: `/stream/series/{imdbId}:{season}:{episode}.json`
- **Timeout**: 15 seconds
- Returns stream URLs through RealDebrid, with metadata (resolution, codec, seeders, size)

### OpenSubtitles (Subtitles)

- **Base URL**: `https://opensubtitles-v3.strem.io`
- **Endpoint**: `/subtitles/{movie|series}/{videoId}.json`
- **Timeout**: 10 seconds (fetch), 15 seconds (download)
- Downloads SRT files to temp directory, offsets timestamps for seeking

### Sportsurge (Live Sports)

- **Main URL**: `https://sportsurge.ws`
- **Embed host**: `https://gooz.aapmains.net`
- **Timeout**: 10 seconds
- Scrapes HTML for game links, resolves embedded HLS stream URLs
- Returns HLS URLs with required auth headers (User-Agent, Referer, Origin)

---

## Playback System

### Pause/Resume

**Pause** (`/pause`):
1. Calculates elapsed time: `(Date.now() - startedAt) / 1000 + seekOffsetSec`
2. Saves full stream context to `pausedState` (URL, headers, audio track, subtitles, series info)
3. Tears down FFmpeg and leaves voice channel

**Resume** (`/play`):
1. Reads `pausedState`
2. If subtitles exist, offsets SRT timestamps by the elapsed time
3. Calls `startVideoStream()` with `seekSeconds = elapsedSec`
4. FFmpeg starts with `-ss <elapsedSec>` for keyframe-based seeking
5. Clears `pausedState`

### Skip/Seek

Both use `restartAtPosition(seekSec)`:
1. Acquires stream lock
2. Captures full stream context from `activeStream`
3. Calls `teardownStream(true)` — kills FFmpeg, leaves voice
4. Waits 1 second for OS process reaping
5. Checks for zombie FFmpeg processes
6. Calls `startVideoStreamInner()` with the new seek position
7. Releases lock

### Now Playing

Returns the current title and elapsed time:
- **Active stream**: `(Date.now() - startedAt) / 1000 + seekOffsetSec`
- **Paused**: `pausedState.elapsedSec`

### Stream End Detection

Two mechanisms detect when a stream ends:

1. **Natural end**: `Promise.allSettled([ffmpegPromise, playPromise])` resolves when FFmpeg finishes encoding and the library finishes sending
2. **Watchdog timer**: Every 5 seconds, checks if `Date.now() - lastFrameTime > 15000`. If no frame data for 15 seconds (after initial startup), triggers stream end

Both call `handleStreamEnd()` which runs full teardown and optionally triggers autoplay.

---

## Encoding Pipeline

### FFmpeg Configuration

The bot transcodes all streams to Discord-compatible format:

| Setting | Value | Reason |
|---------|-------|--------|
| Video codec | H.264 Baseline, Level 3.1 | Maximum Discord compatibility |
| Audio codec | Opus | Required by Discord voice |
| Audio bitrate | 128 kbps | Good quality, low bandwidth |
| Video bitrate | Configurable (default 1500 kbps) | Balance quality/bandwidth |
| Max bitrate | 1.4x video bitrate | VBR ceiling |
| Buffer size | Equal to video bitrate | Single-second buffer |
| Keyframe interval | 2x FPS | Every 2 seconds |

### Custom FFmpeg Flags

```
-max_delay 0              # Low-latency output
-flush_packets 1          # Flush every packet immediately
-bufsize:v {bitrate}k     # Video buffer size
-profile:v baseline       # H.264 Baseline profile
-level:v 3.1              # H.264 Level 3.1
-af aresample=async=4:first_pts=0,volume@internal_lib=1.0   # Audio resampling for sync
```

### Seeking

When seeking (`-ss` flag):
- Applied as an **input option** (before `-i`), enabling fast keyframe-based seeking
- FFmpeg seeks to the nearest keyframe before the target, then decodes forward
- Format: `-ss <seconds>` with 3 decimal places

---

## Hardware Acceleration

### Auto-Detection

On startup with `HARDWARE_ACCEL=auto`, the bot:
1. Runs `ffmpeg -hide_banner -hwaccels`
2. Checks for `cuda`/`nvenc` (NVIDIA) or `vaapi` (Intel/AMD on Linux)
3. Falls back to software encoding if neither is found

### Auto-Tuning

The bot benchmarks FFmpeg at startup to find the optimal settings:

1. Tests resolution/FPS/preset combinations in order of quality
2. Runs a 5-second synthetic encode for each combination
3. Selects the first combination that achieves >= 2.0x realtime speed
4. Falls back to 854x480@24fps ultrafast if nothing qualifies

**Benchmark order** (tries highest quality first):
- 1280x720 @ 30fps with presets: medium, fast, faster, veryfast, superfast, ultrafast
- 854x480 @ 24fps with presets: medium, fast, faster, veryfast, superfast, ultrafast

### Encoder Settings by Hardware

| Hardware | Video Encoder | Preset | Notes |
|----------|--------------|--------|-------|
| NVIDIA | h264_nvenc | p1-p7 (mapped from x264 presets) | Requires CUDA drivers |
| VAAPI | h264_vaapi | N/A | Linux only, Intel/AMD |
| Software | libx264 | ultrafast-slow (auto-tuned) | Works everywhere |

---

## File Reference

### Project Structure

```
DiscordFrankenstein/
├── .env                          # Environment variables (create this)
├── .gitignore                    # Git exclusions
├── package.json                  # Dependencies, scripts, pnpm config
├── tsconfig.json                 # TypeScript compiler settings
├── patches/
│   └── @dank074__discord-video-stream.patch   # Library patch for A/V sync + features
├── src/
│   ├── index.ts                  # Entry point: startup, shutdown, signal handlers
│   ├── bot/
│   │   ├── client.ts             # Discord bot client setup (discord.js)
│   │   ├── interactions.ts       # Command dispatcher (routes to handlers)
│   │   └── commands/
│   │       ├── register.ts       # Slash command registration (REST API)
│   │       ├── movie.ts          # /movie command handler
│   │       ├── series.ts         # /series command handler
│   │       ├── live.ts           # /live command handler
│   │       ├── stop.ts           # /stop command handler
│   │       ├── playback.ts       # /pause /play /skip /seek /np /next /autoplay
│   │       ├── picker.ts         # Stream selection button UI
│   │       └── options.ts        # Audio track and subtitle selection UI
│   ├── streamer/
│   │   ├── client.ts             # Selfbot client setup (discord.js-selfbot-v13)
│   │   ├── stream.ts             # Core streaming engine, state management, FFmpeg lifecycle
│   │   └── encoder.ts            # FFmpeg options builder, hardware detection, auto-tune
│   ├── services/
│   │   ├── cinemeta.ts           # Movie/series search and episode resolution
│   │   ├── torrentio.ts          # Stream fetching, parsing, and ranking
│   │   ├── opensubtitles.ts      # Subtitle fetching, downloading, time offset
│   │   ├── ffprobe.ts            # Stream metadata probing (codec, resolution, audio tracks)
│   │   ├── sportsurge.ts         # Live sports event scraping and stream URL resolution
│   │   └── livematch.ts          # Team name fuzzy matching with alias expansion
│   └── utils/
│       ├── config.ts             # Environment variable loading and validation
│       ├── logger.ts             # Structured logging with component tags
│       └── sync.ts               # A/V sync monitoring from FFmpeg stderr
└── dist/                         # Compiled JavaScript output (after pnpm build)
```

### Key Files Explained

| File | What It Does |
|------|-------------|
| `stream.ts` | The heart of the bot. Manages the FFmpeg lifecycle, voice connections, playback state (active/paused), the mutex lock, watchdog timer, and autoplay callbacks. Every streaming operation flows through here. |
| `encoder.ts` | Builds the FFmpeg command-line options. Detects hardware acceleration, benchmarks encoding speed at startup, and constructs the full option set (codec, bitrate, resolution, FPS, seeking, headers, audio filters). |
| `register.ts` | Registers all 11 slash commands via Discord REST API. Clears global commands on every boot to prevent stale commands, then PUTs the full command set to each guild. Handles rate limits with retry. |
| `interactions.ts` | Routes incoming slash commands to their handlers. Defers replies immediately (Discord's 3-second deadline). If deferReply fails (expired interaction), logs a warning but still attempts the command. |
| `playback.ts` | Implements all playback control commands plus the autoplay system. Skip and seek use `restartAtPosition()` for atomic FFmpeg restart. Next episode and autoplay share the `playNextEpisode()` function. |
| `torrentio.ts` | Fetches available streams from the Torrentio addon, parses metadata from stream titles (resolution, codec, size, seeders, language), ranks them, and returns the top 5 for user selection. |
| `cinemeta.ts` | Searches for movies/series by title, resolves specific episodes (or picks random ones), and finds the next episode for autoplay/next-episode functionality. |

### Library Patch

The file `patches/@dank074__discord-video-stream.patch` modifies the `@dank074/discord-video-stream` library to:

1. **Reduce playout delay** — Sets audio and video playout delay to 0ms (from 1ms/10ms) for tighter synchronization
2. **Increase sync tolerance** — From 20ms to 50ms to reduce unnecessary corrections
3. **Add precision sleep** — Custom sleep function for accurate frame timing
4. **Add drift correction** — Diagnostic logging every 300 frames with sync statistics
5. **Improve HLS handling** — Better detection of HLS streams, `-extension_picky 0` for non-standard segments
6. **Add subtitle/audio passthrough** — FFmpeg subtitle burning and audio stream selection options

This patch is applied automatically by `pnpm install`.

---

## Troubleshooting

### Bot doesn't respond to commands

- Check that the bot is online in your server
- Check logs for `Registered 11 commands in <your server>`
- If commands show on the wrong account, restart the bot (it clears global commands on boot)
- Discord can take up to 1 hour to propagate guild command changes

### "Unknown interaction" errors

This means Discord's 3-second interaction deadline expired before the bot could respond. The bot handles this gracefully (logs a warning, continues). Causes:
- Network latency between your server and Discord
- Bot was busy with a previous command
- These are transient and can be ignored

### Stream starts but no video/audio

- Verify FFmpeg is on PATH: `ffmpeg -version`
- Check the auto-tune log — if speed is below 2.0x, the encoder is too slow
- Try setting `HARDWARE_ACCEL=none` to force software encoding
- Try lowering `MAX_RESOLUTION=480` and `VIDEO_BITRATE=1000`

### FFmpeg zombie processes

The bot has multi-stage FFmpeg kill verification:
1. Direct kill via FFmpeg command object
2. OS-level kill (`taskkill` on Windows, `pkill` on Linux)
3. 3-attempt polling with 500ms intervals
4. If still alive after all attempts, logs `CRITICAL: FFmpeg still alive`

If you see zombie FFmpeg processes, manually kill them:
```bash
# Windows
taskkill /F /IM ffmpeg.exe

# Linux/macOS
pkill -9 ffmpeg
```

### Autoplay stops working

- Autoplay disables itself when: no more episodes exist, no streams found, or the callback errors
- Check logs for `Autoplay: no more episodes` or `Autoplay: no streams`
- Use `/autoplay` to re-enable after it auto-disables

### Live streams fail

- Sportsurge may be down or have changed their page structure
- The bot scrapes HTML — any layout change can break it
- Check logs for `Failed to fetch live events`
- Live streams cannot be paused, skipped, or seeked

### "Could not determine your voice channel"

- You must be in a voice channel **before** running a streaming command
- The bot checks `interaction.member.voice.channelId`

---

## Known Limitations

1. **Subtitle burning is disabled** — The library patch supports it, but burning subtitles creates extra NUT streams that break Discord's Go Live. Subtitles are downloaded but not applied.

2. **Audio stream selection is disabled** — Same library limitation. The audio track selection UI works, but the selected track index is not applied during encoding.

3. **No live stream reconnection** — If a live stream's HLS URL expires mid-playback, the stream will end. The `reconnectCount` field exists but reconnection is not implemented.

4. **Single stream at a time** — Only one stream can be active across all guilds. The selfbot can only be in one voice channel.

5. **User token required** — The selfbot requires a regular Discord user token. Discord's ToS considers selfbots a gray area. Use at your own risk.

6. **Windows-primary** — FFmpeg process management uses `taskkill`/`tasklist` on Windows and `pkill`/`pgrep` on Linux. macOS uses the Linux path but is untested.

7. **No persistent state** — All state (playback, autoplay, paused) is in-memory. Restarting the bot loses everything.
