import { startDiscordBot } from "./src/discordBot";

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");

  await startDiscordBot({ token });
}

await main();
