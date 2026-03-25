import { createLogger } from "./logger.js";

const log = createLogger("Sync");

interface SyncState {
  lastSpeedUpdate: number;
  speeds: number[];
  warnings: number;
  onDrift?: () => void;
  listener: (chunk: Buffer) => void;
  stream: NodeJS.ReadableStream;
}

let activeSyncState: SyncState | null = null;

export function startSyncMonitor(
  ffmpegStderr: NodeJS.ReadableStream,
  onDrift?: () => void
): void {
  stopSyncMonitor();

  let buffer = "";

  const listener = (chunk: Buffer) => {
    buffer += chunk.toString();

    // Parse FFmpeg progress lines for speed
    const speedMatches = buffer.match(/speed=\s*([\d.]+)x/g);
    if (speedMatches) {
      for (const match of speedMatches) {
        const value = parseFloat(match.match(/[\d.]+/)![0]);
        state.speeds.push(value);
        state.lastSpeedUpdate = Date.now();

        // Keep only last 10 readings
        if (state.speeds.length > 10) state.speeds.shift();
      }

      // Check average speed
      if (state.speeds.length >= 3) {
        const avgSpeed =
          state.speeds.reduce((a, b) => a + b, 0) / state.speeds.length;

        if (avgSpeed < 1.5) {
          state.warnings++;
          log.warn(
            `Encoding speed low: ${avgSpeed.toFixed(2)}x (warning ${state.warnings})`
          );

          if (state.warnings >= 5 && onDrift) {
            log.error(
              "Persistent low encoding speed detected, triggering drift callback"
            );
            onDrift();
            state.warnings = 0;
          }
        } else if (avgSpeed >= 2.0) {
          // Reset warnings when speed is good
          state.warnings = Math.max(0, state.warnings - 1);
        }
      }

      // Clear processed data from buffer, keep the last incomplete line
      const lastNewline = buffer.lastIndexOf("\r");
      if (lastNewline !== -1) {
        buffer = buffer.slice(lastNewline + 1);
      }
    }

    // Trim buffer if too long
    if (buffer.length > 4096) {
      buffer = buffer.slice(-2048);
    }
  };

  ffmpegStderr.on("data", listener);

  const state: SyncState = {
    lastSpeedUpdate: Date.now(),
    speeds: [],
    warnings: 0,
    onDrift,
    listener,
    stream: ffmpegStderr,
  };
  activeSyncState = state;
}

export function stopSyncMonitor(): void {
  if (activeSyncState) {
    activeSyncState.stream.removeListener("data", activeSyncState.listener);
    activeSyncState = null;
  }
}

export function getSyncStatus(): {
  avgSpeed: number;
  warnings: number;
} | null {
  if (!activeSyncState || activeSyncState.speeds.length === 0) return null;

  const avgSpeed =
    activeSyncState.speeds.reduce((a, b) => a + b, 0) /
    activeSyncState.speeds.length;

  return {
    avgSpeed,
    warnings: activeSyncState.warnings,
  };
}
