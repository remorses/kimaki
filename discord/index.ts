import { startDiscordBot } from "./src/discordBot";

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  if (!channelId) throw new Error("DISCORD_CHANNEL_ID is not set");
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  await startDiscordBot({ token, channelId });
}

await main();
