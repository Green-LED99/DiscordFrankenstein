<div align="center">
  <h1>
    <br />
    DiscordFrankenstein
    <br />
  </h1>
  <p><strong>Stream movies, TV series, and live sports directly into Discord voice channels via Go Live.</strong></p>
  <p>
    <a href="https://github.com/Green-LED99/DiscordFrankenstein/blob/master/LICENSE"><img src="https://img.shields.io/github/license/Green-LED99/DiscordFrankenstein?style=flat-square" alt="License" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22.4.0-brightgreen?style=flat-square&logo=node.js&logoColor=white" alt="Node" />
    <img src="https://img.shields.io/badge/discord.js-v14-5865F2?style=flat-square&logo=discord&logoColor=white" alt="discord.js" />
    <img src="https://img.shields.io/badge/typescript-v6-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/ffmpeg-7.1%2B-007808?style=flat-square&logo=ffmpeg&logoColor=white" alt="FFmpeg" />
  </p>
</div>

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running](#running)
- [Commands](#commands)
- [Architecture](#architecture)
- [Streaming Pipeline](#streaming-pipeline)
- [Content Sources](#content-sources)
- [Encoding Pipeline](#encoding-pipeline)
- [State Management](#state-management)
- [Key Design Patterns](#key-design-patterns)
- [File Reference](#file-reference)
- [Deployment](#deployment)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)
- [License](#license)

---

## Features

- **Dual-Client Architecture** — Official bot handles slash commands; a separate user account Go Lives in voice channels
- **Movie & TV Streaming** — Search by title via Cinemeta, fetch streams via Torrentio + RealDebrid, probe with FFprobe, transcode with FFmpeg
- **Live Sports** — Scrape Sportsurge for live games with fuzzy team name matching (80+ aliases across NHL, NBA, NFL, MLB, soccer, MMA)
- **Full Playback Controls** — Pause, resume, skip, seek, now-playing, with atomic FFmpeg restart under mutex lock
- **Autoplay** — Automatic next-episode progression for TV series with zero user interaction
- **Smart Command Registration** — SHA256 hash-based deduplication; both global + guild-specific commands; `guildCreate` listener for runtime joins
- **Selfbot Voice Fallback** — Global commands work in guilds where only the streamer account is present
- **Encoder Auto-Tuning** — Benchmarks FFmpeg at startup to find optimal resolution/FPS/preset for ≥2x realtime speed
- **Hardware Acceleration** — Auto-detects NVIDIA NVENC, VAAPI, or falls back to software x264
- **Aggressive Process Cleanup** — Multi-stage FFmpeg kill verification with zombie detection, 15-second watchdog for stalled streams

---

## Prerequisites

| Software | Version | Purpose | Install |
|----------|---------|---------|---------|
| **Node.js** | ≥ 22.4.0 | Runtime | [nodejs.org](https://nodejs.org) (LTS 22.x+) |
| **pnpm** | ≥ 10.33.0 | Package manager | `npm install -g pnpm@10.33.0` |
| **FFmpeg** | ≥ 7.1 | Video transcoding | [BtbN static builds](https://github.com/BtbN/FFmpeg-Builds/releases) |
| **FFprobe** | (bundled) | Stream analysis | Included with FFmpeg |

Verify:

```bash
node --version     # ≥ 22.4.0
pnpm --version     # ≥ 10.33.0
ffmpeg -version    # ≥ 7.1
ffprobe -version   # ≥ 7.1
```

### Required Accounts

1. **Discord Bot Application** — [Developer Portal](https://discord.com/developers/applications) → New Application → Bot tab → copy `BOT_TOKEN`. OAuth2 scopes: `bot`, `applications.commands`. Permissions: `Send Messages`, `Connect`, `Speak`.
2. **Discord User Account** (selfbot) — A regular user account that will Go Live. Must be in the same server(s). You need its `USER_TOKEN`.
3. **Stremio Torrentio Addon** — [torrentio.strem.fun/configure](https://torrentio.strem.fun/configure) with RealDebrid API key. Copy the full addon URL as `STREMIO_ADDON_URL`.

---

## Installation

```bash
git clone https://github.com/Green-LED99/DiscordFrankenstein.git
cd DiscordFrankenstein
pnpm install    # Applies the @dank074/discord-video-stream patch automatically
pnpm build      # Compile TypeScript to dist/
```

If `pnpm install` fails on native modules:
- **Windows**: Install Visual Studio Build Tools or `npm install -g windows-build-tools`
- **Linux**: `sudo apt install build-essential python3`
- **macOS**: `xcode-select --install`

---

## Configuration

Create a `.env` file in the project root:

### Required

```env
BOT_TOKEN=your_bot_token_here
USER_TOKEN=your_user_token_here
STREMIO_ADDON_URL=https://torrentio.strem.fun/realdebrid=YOURAPIKEY/
```

### Optional

| Variable | Default | Options | Description |
|----------|---------|---------|-------------|
| `MAX_RESOLUTION` | `720` | `2160`, `1080`, `720`, `480` | Maximum output resolution in pixels |
| `MAX_FPS` | `30` | Any integer | Maximum output frame rate |
| `VIDEO_BITRATE` | `1500` | Any integer (kbps) | Video bitrate |
| `HARDWARE_ACCEL` | `auto` | `auto`, `nvidia`, `vaapi`, `none` | Hardware encoder selection |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR` | Log verbosity |

Startup validates all config and exits immediately with a clear error if anything is wrong.

---

## Running

### Production

```bash
pnpm build && pnpm start
```

### Development

```bash
pnpm dev    # tsx — runs TypeScript directly
```

### Startup Sequence

1. **Load config** — Validate all environment variables
2. **Auto-tune encoder** — Benchmark FFmpeg across resolution/FPS/preset combos, select first achieving ≥2x realtime
3. **Init selfbot** — Log in the user account (`USER_TOKEN`)
4. **Init bot** — Log in the bot account (`BOT_TOKEN`), register slash commands on `ready`
5. **Register commands** — If definitions changed: PUT global + all guilds. If unchanged: only register to new guilds.

Expected logs:

```
[INFO] [Main] DiscordFrankenstein starting...
[INFO] [Encoder] Benchmark: 1280x720@30fps preset=medium -> speed=15.80x
[INFO] [Encoder] Auto-tune result: 1280x720@30fps preset=medium (speed: 15.80x)
[INFO] [StreamerClient] Selfbot logged in as YourUserAccount
[INFO] [Bot] Bot logged in as Dr. Frankenstein#4056
[INFO] [Commands] Command definitions changed — registering globally and to all guilds
[INFO] [Commands] Global commands registered
[INFO] [Commands] Registered 11 commands in Your Server
[INFO] [Commands] Command registration complete
[INFO] [Bot] Bot ready
```

### Stopping

`Ctrl+C` or `SIGTERM` → stops active stream → kills FFmpeg → disconnects selfbot → destroys both clients → exits.

---

## Commands

All commands are ephemeral (only visible to the invoker). Streaming commands require the user to be in a voice channel.

### Streaming

| Command | Parameters | Description |
|---------|-----------|-------------|
| `/movie` | `title` (required) | Search and stream a movie |
| `/series` | `title` (required), `season` (optional), `episode` (optional) | Stream a TV episode. Random episode if season/episode omitted. |
| `/live` | `team` (required) | Stream a live sports game. Fuzzy-matches team names and abbreviations. |

### Playback Controls

| Command | Parameters | Description |
|---------|-----------|-------------|
| `/pause` | — | Pause stream. Saves timestamp, kills FFmpeg, leaves voice. Not for live. |
| `/play` | — | Resume from pause. Restarts FFmpeg with `-ss` seek. |
| `/skip` | `seconds` (required, negative to rewind) | Jump forward/backward. Atomic FFmpeg restart. Not for live. |
| `/seek` | `hours`, `minutes`, `seconds` (all optional) | Jump to exact timestamp. Not for live. |
| `/np` | — | Show current title and elapsed time. Works while playing or paused. |
| `/next` | — | Play next episode. Series only. |
| `/autoplay` | — | Toggle auto next-episode. Series only. |
| `/stop` | — | Stop everything. Clears paused state, disables autoplay. |

---

## Architecture

```
                    Discord Server
                    ┌─────────────────────────────────┐
                    │                                 │
User ──slash cmd──> │  Dr. Frankenstein (Bot Client)   │ ← discord.js v14
                    │  Slash commands, interactions,   │   BOT_TOKEN
                    │  UI (pickers, buttons)           │
                    │                                 │
                    │  Selfbot (Streamer Client)       │ ← discord.js-selfbot-v13
                    │  Joins voice, Go Lives,          │   USER_TOKEN
                    │  Streams video + audio           │   + @dank074/discord-video-stream
                    └──────────────┬──────────────────┘
                                   │
                         ┌─────────┴──────────┐
                         │      FFmpeg         │
                         │  H.264 Baseline 3.1 │
                         │  Opus 128kbps       │
                         │  → NUT pipe →       │
                         │  Discord RTP/DAVE   │
                         └────────────────────┘
```

### Dual-Client Model

- **Bot Client** (`discord.js` v14, `BOT_TOKEN`) — Registers slash commands, handles user interactions, builds picker UIs. Cannot Go Live.
- **Selfbot Client** (`discord.js-selfbot-v13`, `USER_TOKEN`) — Joins voice channels and broadcasts video via Go Live. The `@dank074/discord-video-stream` library manages WebRTC/RTP/DAVE.

### Voice Resolution Fallback

When a global command is used in a guild the bot isn't in (but the selfbot is), `interaction.member.voice` is empty (bot has no gateway cache). The `resolveVoiceChannel()` helper (`src/bot/commands/voice.ts`) falls back to the selfbot's gateway cache:

1. **Primary**: `(interaction.member as GuildMember).voice.channelId` (bot cache)
2. **Fallback**: `getSelfbotClient().guilds.cache.get(guildId).voiceStates.cache.get(userId).channelId` (selfbot cache)

---

## Streaming Pipeline

### Movie/Series Flow

```
/movie "Fight Club"
    │
    ▼
1. Search Cinemeta ──→ GET /catalog/movie/top/search=Fight%20Club.json
    │                  Returns: { id: "tt0137523", name: "Fight Club", year: "1999" }
    ▼
2. Fetch Streams ────→ GET /stream/movie/tt0137523.json (via Torrentio + RealDebrid)
    │                  Returns: Array of stream objects with URLs, seeders, resolution
    ▼
3. Rank & Filter ────→ Sort: seeders DESC → resolution DESC → h264 bonus → size DESC
    │                  Filter to MAX_RESOLUTION, take top 5
    ▼
4. User Picks ───────→ Discord button UI (30s timeout, auto-selects if only 1)
    │
    ▼
5. Probe Stream ─────→ ffprobe: codec, resolution, FPS, audio tracks, B-frames, VFR
    │
    ▼
6. Audio/Sub Pick ───→ User selects audio track and subtitle language via buttons
    │
    ▼
7. Start Stream ─────→ selfbot.joinVoice() → FFmpeg encodes → playStream(Go Live)
```

### Live Sports Flow

```
/live "Lakers"
    │
    ▼
1. Fetch Events ─────→ Scrape sportsurge.ws for live game links
    │
    ▼
2. Fuzzy Match ──────→ Token scoring + alias expansion ("Lakers" → ["lakers","los","angeles"])
    │
    ▼
3. User Picks ───────→ Button UI if multiple matches
    │
    ▼
4. Resolve URL ──────→ Event page → embed ID → base64 decode → HLS URL + auth headers
    │
    ▼
5. Probe & Stream ───→ ffprobe (with headers) → FFmpeg → Go Live
```

### Stream Lifecycle

```
START ─→ acquireLock ─→ teardown existing ─→ probe ─→ autoTune ─→ buildOptions
         ─→ joinVoice ─→ prepareStream (FFmpeg) ─→ startSyncMonitor ─→ playStream
         ─→ startWatchdog ─→ releaseLock

PAUSE ─→ acquireLock ─→ calcElapsed ─→ savePausedState ─→ teardown ─→ releaseLock

PLAY ──→ acquireLock ─→ readPausedState ─→ offsetSubtitles ─→ startStream(seekSec)
         ─→ clearPausedState ─→ releaseLock

SEEK ──→ acquireLock ─→ captureContext ─→ teardown ─→ wait 1s ─→ zombieCheck
         ─→ startStream(newSeekSec) ─→ releaseLock

STOP ──→ acquireLock ─→ teardown ─→ clearPaused ─→ disableAutoplay ─→ releaseLock

END ───→ acquireLock ─→ teardown ─→ if autoplay: wait 1s → zombieCheck → callback()
```

---

## Content Sources

### Cinemeta — Movie/Series Metadata

| Endpoint | Purpose |
|----------|---------|
| `GET /catalog/{movie\|series}/top/search={query}.json` | Search by title → IMDB IDs |
| `GET /meta/series/{imdbId}.json` | Full series metadata with all episodes |

- **Base**: `https://v3-cinemeta.strem.io`
- **Timeout**: 15s
- **Key functions**: `searchContent()`, `resolveEpisode()`, `getNextEpisode()`
- **File**: `src/services/cinemeta.ts`

### Torrentio — Stream URLs

| Endpoint | Purpose |
|----------|---------|
| `GET /stream/movie/{imdbId}.json` | Movie streams |
| `GET /stream/series/{imdbId}:{season}:{episode}.json` | Episode streams |

- **Base**: `STREMIO_ADDON_URL` (user-configured with RealDebrid)
- **Timeout**: 15s
- **Ranking**: Parses title metadata (resolution, codec, seeders, size, language), scores and sorts
- **Key functions**: `fetchStreams()`, `getTopStreams()`, `rankStreams()`
- **File**: `src/services/torrentio.ts`

### OpenSubtitles — Subtitles

| Endpoint | Purpose |
|----------|---------|
| `GET /subtitles/{movie\|series}/{videoId}.json` | Available subtitle tracks |

- **Base**: `https://opensubtitles-v3.strem.io`
- **Timeout**: 10s fetch, 15s download
- **Downloads SRT to temp dir**, offsets timestamps when seeking (`-ss` resets PTS)
- **Key functions**: `fetchSubtitles()`, `downloadSubtitle()`, `offsetSubtitleFile()`
- **File**: `src/services/opensubtitles.ts`

### Sportsurge — Live Sports

- **Main**: `https://sportsurge.ws` (HTML scraping)
- **Embed**: `https://gooz.aapmains.net` (HLS resolution)
- **Timeout**: 10s
- **Flow**: Scrape event links → fuzzy match team query → fetch embed ID → base64 decode HLS URL → return with auth headers
- **Key functions**: `fetchEvents()`, `fetchStreamEmbedId()`, `resolveStreamUrl()`
- **Files**: `src/services/sportsurge.ts`, `src/services/livematch.ts`

### LiveMatch — Fuzzy Team Matching

- **80+ team aliases** across NHL, NBA, NFL, MLB, EPL, UCL, UFC
- **Token-based scoring**: exact match = 3 points, substring = 1 point
- **Alias expansion**: "avs" → `["avalanche", "colorado"]`, "yanks" → `["yankees", "new", "york"]`
- **Key function**: `matchAllEvents(events, query)`
- **File**: `src/services/livematch.ts`

---

## Encoding Pipeline

### FFmpeg Settings

| Setting | Value | Reason |
|---------|-------|--------|
| Video codec | H.264 Baseline, Level 3.1 | Maximum Discord compatibility |
| Audio codec | Opus | Required by Discord voice |
| Audio bitrate | 128 kbps | Good quality, low bandwidth |
| Video bitrate | Configurable (default 1500 kbps) | Balance quality/bandwidth |
| Max bitrate | 1.4× video bitrate | VBR ceiling |
| Buffer size | Equal to video bitrate | Single-second buffer |
| Keyframe interval | 2× FPS | Every 2 seconds |

### FFmpeg Flags

```
-max_delay 0              Low-latency output
-flush_packets 1          Flush every packet immediately
-bufsize:v {bitrate}k     Video buffer size
-profile:v baseline       H.264 Baseline profile
-level:v 3.1              H.264 Level 3.1
-af aresample=async=4:first_pts=0,volume=1.0   Audio resampling for sync
-ss {seconds}             Input option for keyframe-based fast seeking
```

### Hardware Acceleration

On startup with `HARDWARE_ACCEL=auto`:

1. Runs `ffmpeg -hide_banner -hwaccels`
2. Detects `cuda`/`nvenc` (NVIDIA) or `vaapi` (Intel/AMD Linux)
3. Falls back to software if neither found

### Auto-Tuning

Benchmarks FFmpeg at startup to find the best settings:

1. Tests resolution/FPS/preset combos in quality-descending order
2. 5-second synthetic encode per combo
3. Selects first combo achieving ≥ 2.0× realtime speed
4. Fallback: 854×480 @ 24fps ultrafast

| Hardware | Encoder | Presets |
|----------|---------|---------|
| NVIDIA | `h264_nvenc` | p1–p7 (mapped from x264) |
| VAAPI | `h264_vaapi` | N/A |
| Software | `libx264` | ultrafast – slow (auto-tuned) |

---

## State Management

All state lives in `src/streamer/stream.ts` as module-level variables, protected by a single async mutex lock (`streamLock`).

| Variable | Type | Purpose |
|----------|------|---------|
| `activeStream` | `ActiveStream \| null` | Current FFmpeg process, timers, metadata, abort controller |
| `pausedState` | `PausedState \| null` | Saved context from `/pause` (URL, elapsed time, audio track, subtitles, series info) |
| `autoplayEnabled` | `boolean` | Whether autoplay is on |
| `autoplayCallback` | `(() => Promise<void>) \| null` | Function to start next episode |
| `lastKnownGuildId` | `string \| null` | Guild for autoplay to rejoin |
| `lastKnownChannelId` | `string \| null` | Channel for autoplay to rejoin |
| `streamLock` | `Promise<void>` | Async mutex preventing concurrent state modifications |

Every public function that modifies state acquires the lock first: `startVideoStream`, `pauseStream`, `restartAtPosition`, `stopVideoStream`, `handleStreamEnd`.

---

## Key Design Patterns

### Async Mutex Lock
All stream state transitions serialize through a single lock. This prevents race conditions between user commands (`/skip` while `/pause` is processing) and stream-end events (watchdog firing during `/seek`).

### Verified FFmpeg Kill
Multi-stage process termination:
1. `command.kill("SIGKILL")` — direct kill
2. OS-level kill (`taskkill` on Windows, `pkill` on Linux)
3. Poll 3 times (500ms apart) to verify dead
4. CRITICAL log if still alive

### Atomic Restart (Seek/Skip)
Hold the lock for the entire teardown → wait → zombie check → relaunch cycle. No interleaving possible.

### Hash-Based Command Registration
SHA256 hash of command definitions stored in `.command-hash` file:
```json
{ "global": "sha256hex", "guilds": { "guildId": "sha256hex" } }
```
- **Commands changed**: PUT global once + PUT every guild
- **Commands unchanged**: Only PUT to new guilds missing from hash file
- **`guildCreate` listener**: Registers commands to guilds joined at runtime

### Watchdog Timer
Every 5 seconds, checks `Date.now() - lastFrameTime > 15000`. If no frame data for 15 seconds, declares stream ended and triggers teardown + autoplay.

### Subtitle Time Offset
FFmpeg's `-ss` input option resets PTS to 0. When resuming at a seek position, all SRT timestamps must be shifted backward by the seek offset. Entries ending before the seek point are dropped.

---

## File Reference

```
DiscordFrankenstein/
├── .env                          # Environment variables (create this)
├── .command-hash                 # Command registration hash cache (auto-generated)
├── package.json                  # Dependencies, scripts, pnpm config
├── tsconfig.json                 # TypeScript strict mode, ESM, Node22
├── patches/
│   └── @dank074__discord-video-stream.patch
├── src/
│   ├── index.ts                  # Entry point: startup sequence, graceful shutdown
│   ├── bot/
│   │   ├── client.ts             # Bot client init, ready event, guildCreate listener
│   │   ├── interactions.ts       # Slash command dispatcher (defers replies, routes to handlers)
│   │   └── commands/
│   │       ├── register.ts       # Command registration (REST API, hash dedup, rate limit retry)
│   │       ├── voice.ts          # Voice channel resolution (bot cache → selfbot fallback)
│   │       ├── movie.ts          # /movie handler
│   │       ├── series.ts         # /series handler
│   │       ├── live.ts           # /live handler
│   │       ├── playback.ts       # /pause /play /skip /seek /np /next /autoplay + autoplay system
│   │       ├── stop.ts           # /stop handler
│   │       ├── picker.ts         # Stream selection button UI (30s timeout)
│   │       └── options.ts        # Audio track + subtitle language selection UI
│   ├── streamer/
│   │   ├── client.ts             # Selfbot client init (discord.js-selfbot-v13 + Streamer)
│   │   ├── stream.ts             # Core engine: FFmpeg lifecycle, state, mutex, watchdog, autoplay
│   │   └── encoder.ts            # FFmpeg option builder, hardware detection, auto-tune benchmark
│   ├── services/
│   │   ├── cinemeta.ts           # Movie/series search, episode resolution, next episode
│   │   ├── torrentio.ts          # Stream fetching, metadata parsing, ranking
│   │   ├── opensubtitles.ts      # Subtitle fetch, download, SRT time offset
│   │   ├── ffprobe.ts            # Stream probing (codec, resolution, FPS, audio tracks)
│   │   ├── sportsurge.ts         # Live sports scraping, embed resolution, HLS URL decode
│   │   └── livematch.ts          # Fuzzy team matching with 80+ aliases
│   └── utils/
│       ├── config.ts             # Env var loading + validation (exits on missing required vars)
│       ├── logger.ts             # Structured logging: [timestamp] [LEVEL] [Component] message
│       └── sync.ts               # A/V sync monitor (parses FFmpeg stderr speed readings)
└── dist/                         # Compiled JS output (pnpm build)
```

<details>
<summary><strong>Key Files Explained</strong></summary>

| File | Role |
|------|------|
| `stream.ts` | **Heart of the system.** Manages FFmpeg lifecycle, voice connections, active/paused state, the mutex lock, watchdog timer, stream-end handler, and autoplay callbacks. Every streaming operation flows through here. ~615 lines. |
| `encoder.ts` | Builds FFmpeg command options. Detects hardware acceleration, benchmarks encoding speed at startup, selects optimal settings. Constructs codec, bitrate, resolution, FPS, seeking, header, and audio filter options. |
| `register.ts` | Registers all 11 slash commands via Discord REST API. Hash-based dedup (`SHA256` of command definitions). Handles 429 rate limits with single retry. Exports `registerCommandsToNewGuild()` for runtime guild joins. |
| `interactions.ts` | Central dispatcher. Defers replies immediately (Discord's 3-second deadline), then routes to the appropriate handler via switch statement. |
| `playback.ts` | All playback controls + autoplay system. Skip/seek use `restartAtPosition()` for atomic FFmpeg restart. `playNextEpisode()` shared between `/next` and autoplay callback. |
| `voice.ts` | Resolves user's voice channel with dual-source fallback (bot gateway cache → selfbot gateway cache). Enables global commands in guilds without bot presence. |
| `torrentio.ts` | Fetches streams, parses title metadata (resolution, codec, seeders, size, language via emoji/text), scores and ranks. Returns top 5 for picker UI. |
| `cinemeta.ts` | Searches movies/series by title, resolves specific or random episodes, finds next episode for autoplay. |
| `livematch.ts` | Fuzzy team matching. Tokenizes query, expands aliases (80+ teams), scores events, sorts by relevance. |

</details>

<details>
<summary><strong>Library Patch Details</strong></summary>

`patches/@dank074__discord-video-stream.patch` modifies `@dank074/discord-video-stream` to:

1. **Reduce playout delay** — Audio 0ms (from 1ms), video 0ms (from 10ms)
2. **Increase sync tolerance** — 50ms (from 20ms) to reduce unnecessary corrections
3. **Precision sleep** — Custom sleep function for accurate frame timing
4. **Drift correction** — Diagnostic logging every 300 frames with sync stats
5. **HLS handling** — `-extension_picky 0` for non-standard segment extensions
6. **Audio/subtitle passthrough** — FFmpeg options for stream selection (partially disabled)

Applied automatically by `pnpm install`.

</details>

---

## Deployment

### Linux Server (systemd)

```ini
# /etc/systemd/system/frankenstein.service
[Unit]
Description=DiscordFrankenstein Streaming Bot
After=network.target

[Service]
Type=simple
User=frankenstein
WorkingDirectory=/home/frankenstein/bot
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/frankenstein/bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable frankenstein
sudo systemctl start frankenstein
journalctl -u frankenstein -f    # View logs
```

### FFmpeg 7.1+ on Ubuntu

The Ubuntu apt package ships FFmpeg 6.1 which lacks `-extension_picky`. Install 7.1+ via static builds:

```bash
cd /tmp
wget https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz
tar xf ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz
sudo cp ffmpeg-n7.1-latest-linux64-gpl-7.1/bin/{ffmpeg,ffprobe} /usr/local/bin/
sudo chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
hash -r    # Clear shell path cache
ffmpeg -version    # Should show 7.1.x
```

`/usr/local/bin` takes PATH priority over `/usr/bin`. To revert: `sudo rm /usr/local/bin/ffmpeg /usr/local/bin/ffprobe`.

---

## Development

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run TypeScript directly via `tsx` (development) |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled JavaScript (production) |

### Type Checking

```bash
npx tsc --noEmit
```

### Project Conventions

- **Strict TypeScript** — `strict: true`, zero `any`, union types over loose typing
- **ESM modules** — `"type": "module"` in package.json, `.js` extensions in imports
- **Component logging** — `createLogger("ComponentName")` for tagged log output
- **Error handling** — Non-critical failures (audio/subtitle selection) log warnings but don't break the main flow. Critical failures throw and are caught at command handler level.
- **No external database** — All state is in-memory module-level variables

---

## Troubleshooting

<details>
<summary><strong>Bot doesn't respond to commands</strong></summary>

- Check logs for `Registered 11 commands in <your server>`
- If commands changed, first boot registers globally + per-guild (logs `Command definitions changed`)
- Second boot with same commands should log `Commands unchanged ... skipping`
- Global commands use Discord's read-repair mechanism (may take a few minutes initially)

</details>

<details>
<summary><strong>"Unknown interaction" errors</strong></summary>

Discord's 3-second interaction deadline expired. The bot defers replies immediately, but network latency can cause this. These are transient — the bot logs a warning and continues.

</details>

<details>
<summary><strong>Stream starts but no video/audio</strong></summary>

- Check auto-tune log — speed must be ≥ 2.0×
- Try `HARDWARE_ACCEL=none` to force software encoding
- Lower `MAX_RESOLUTION=480` and `VIDEO_BITRATE=1000`
- Verify FFmpeg version: `ffmpeg -version` (need ≥ 7.1)

</details>

<details>
<summary><strong>ffprobe fails on live streams</strong></summary>

- Ensure FFmpeg ≥ 7.1 (Ubuntu apt ships 6.1 which lacks `-extension_picky`)
- See [Deployment > FFmpeg 7.1+ on Ubuntu](#ffmpeg-71-on-ubuntu) for upgrade instructions

</details>

<details>
<summary><strong>FFmpeg zombie processes</strong></summary>

The bot has multi-stage kill verification. If zombies persist:
```bash
# Linux
pkill -9 ffmpeg

# Windows
taskkill /F /IM ffmpeg.exe
```

</details>

<details>
<summary><strong>"Could not determine your voice channel"</strong></summary>

- You must be in a voice channel before running a streaming command
- If the bot isn't in the guild, the selfbot must be (voice resolution falls back to selfbot cache)
- If neither client is in the guild, voice channel cannot be resolved

</details>

---

## Known Limitations

1. **Subtitle burning disabled** — Creates extra NUT streams that break Go Live
2. **Audio stream selection disabled** — Library limitation prevents applying selected track
3. **No live stream reconnection** — HLS URL expiry ends the stream
4. **Single stream at a time** — Selfbot can only be in one voice channel across all guilds
5. **User token required** — Selfbots are gray-area per Discord ToS
6. **No persistent state** — Restart loses all playback/autoplay state
7. **Platform process management** — Uses `taskkill`/`tasklist` on Windows, `pkill`/`pgrep` on Linux

---

## License

[MIT](LICENSE)
