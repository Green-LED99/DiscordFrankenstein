# DiscordFrankenstein

A Discord application that streams movies and TV series to voice channels via Go Live. Uses a bot for slash commands and a selfbot for video streaming with DAVE (E2EE) protocol support.

## Architecture

```
/movie or /series slash command
        |
  [Discord Bot] (discord.js)
   - Searches TMDB for content
   - Fetches stream from Torrentio + RealDebrid
   - Tells the streamer to play
        |
  [Selfbot Streamer] (discord.js-selfbot-v13 + discord-video-stream)
   - Joins the user's voice channel
   - Streams via Go Live with FFmpeg
   - Handles DAVE protocol encryption
```

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/movie <title>` | Stream a movie | `/movie F1` |
| `/series <title> [season] [episode]` | Stream a TV episode | `/series Family Guy season 2 episode 5` |
| `/stop` | Stop the current stream | `/stop` |

If season/episode are omitted for `/series`, a random one is selected.

## Prerequisites

- **Node.js** >= 18
- **pnpm** package manager
- **FFmpeg** with libzmq support (bundled via node-av for basic use)
- A Discord **bot** token with application commands scope
- A Discord **user** token for the selfbot streamer
- A **TMDB** API key
- A **Stremio/Torrentio** addon URL with RealDebrid configured

## Setup

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd DiscordFrankenstein
   ```

2. Install dependencies:
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

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Discord bot token |
| `USER_TOKEN` | Yes | Discord user token for streaming |
| `TMDB_API_KEY` | Yes | TMDB API key |
| `STREMIO_ADDON_URL` | Yes | Full Torrentio addon URL with RealDebrid |
| `MAX_RESOLUTION` | No | Max output resolution: `720` (default) or `480` |
| `MAX_FPS` | No | Max framerate: `30` (default) or `24` |
| `VIDEO_BITRATE` | No | Target bitrate in kbps (default: `2500`) |
| `HARDWARE_ACCEL` | No | `auto` (default), `nvidia`, `vaapi`, or `none` |

## Auto-Tuning

On startup, the application benchmarks FFmpeg encoding to find optimal settings for your hardware. It tests presets from `medium` to `ultrafast`, and if needed, reduces resolution/fps to maintain real-time encoding speed. Results are cached for the session.

Hardware acceleration (NVIDIA NVENC, Intel/AMD VAAPI) is auto-detected when `HARDWARE_ACCEL=auto`.

## Copy Mode

When the source video is already H.264 at <=720p and <=30fps, FFmpeg runs in copy mode (no transcoding), saving CPU and preserving quality.

## AMP Deployment

DiscordFrankenstein includes a CubeCoders AMP Generic Module template for easy deployment via AMP's web panel.

1. Copy the files from `amp/` to your AMP templates directory:
   - `discordfrankenstein.kvp`
   - `discordfrankensteinconfig.json`
   - `discordfrankensteinmetaconfig.json`

2. In AMP, create a new **Generic** instance using the DiscordFrankenstein template

3. Clone this repo into the instance's root directory

4. Click **Update** to install dependencies and build

5. Configure tokens in the **Settings** tab

6. Click **Start**

AMP will manage the process lifecycle, monitor FFmpeg child processes, and provide a web UI for configuration.

## Project Structure

```
src/
  index.ts              Entry point with graceful shutdown
  bot/
    client.ts           Discord.js bot setup
    interactions.ts     Interaction router
    commands/
      register.ts       Slash command registration
      movie.ts          /movie handler
      series.ts         /series handler
      stop.ts           /stop handler
  streamer/
    client.ts           Selfbot + Streamer setup
    stream.ts           Go Live streaming logic
    encoder.ts          FFmpeg settings + auto-tuner
  services/
    tmdb.ts             TMDB API client
    torrentio.ts        Torrentio stream fetcher
    ffprobe.ts          Stream metadata probing
  utils/
    config.ts           Environment config loader
    logger.ts           Structured logging
    sync.ts             A/V sync monitoring
amp/
  *.kvp, *.json         AMP template files
```

## Tech Stack

- **TypeScript** / Node.js
- **discord.js** v14 (bot)
- **discord.js-selfbot-v13** (selfbot)
- **@dank074/discord-video-stream** (Go Live + DAVE protocol)
- **FFmpeg** (transcoding / copy mode)
- **TMDB API** (content search)
- **Torrentio** + RealDebrid (stream sourcing)
