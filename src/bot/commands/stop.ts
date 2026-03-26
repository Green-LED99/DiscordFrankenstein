import type { ChatInputCommandInteraction } from "discord.js";
import { stopVideoStream, isStreaming, getPausedState } from "../../streamer/stream.js";
import { createLogger, errStr } from "../../utils/logger.js";

const log = createLogger("StopCmd");

export async function handleStop(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isStreaming() && !getPausedState()) {
    await interaction.editReply("Nothing is currently streaming or paused.");
    return;
  }

  try {
    await stopVideoStream();
    await interaction.editReply("Stream stopped.");
    log.info("Stream stopped by user command");
  } catch (err) {
    log.error(`Stop failed: ${errStr(err)}`);
    await interaction.editReply(
      `Failed to stop stream: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
