import { startDiscordBot } from "./src/discordBot";

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  if (!channelId) throw new Error("DISCORD_CHANNEL_ID is not set");

  await startDiscordBot({ token, channelId });
}

await main();
