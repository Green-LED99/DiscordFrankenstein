import type { ChildProcess } from "node:child_process";
import { createLogger } from "./logger.js";

const log = createLogger("Sync");

interface SyncState {
  lastSpeedUpdate: number;
  speeds: number[];
  warnings: number;
  onDrift?: () => void;
}

let activeSyncState: SyncState | null = null;

export function startSyncMonitor(
  ffmpegStderr: NodeJS.ReadableStream,
  onDrift?: () => void
): void {
  stopSyncMonitor();

  const state: SyncState = {
    lastSpeedUpdate: Date.now(),
    speeds: [],
    warnings: 0,
    onDrift,
  };
  activeSyncState = state;

  let buffer = "";

  ffmpegStderr.on("data", (chunk: Buffer) => {
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

        if (avgSpeed < 0.95) {
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
        } else if (avgSpeed >= 0.98) {
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
  });
}

export function stopSyncMonitor(): void {
  activeSyncState = null;
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
