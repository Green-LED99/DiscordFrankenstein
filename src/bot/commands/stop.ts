import type { ChatInputCommandInteraction } from "discord.js";
import { stopVideoStream, isStreaming } from "../../streamer/stream.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("StopCmd");

export async function handleStop(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isStreaming()) {
    await interaction.editReply("Nothing is currently streaming.");
    return;
  }

  try {
    await stopVideoStream();
    await interaction.editReply("Stream stopped.");
    log.info("Stream stopped by user command");
  } catch (err) {
    log.error(`Stop failed: ${err}`);
    await interaction.editReply(
      `Failed to stop stream: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
