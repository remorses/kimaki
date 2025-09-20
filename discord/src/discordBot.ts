import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { runOpencode, stopOpencode } from "./opencode";
import { messageToEmbed, userContentToDiscord } from "./utils";

type StartOptions = {
  token: string;
  channelId: string;
};

async function opencodeToDiscord(
  prompt: string,
  thinkingMessage: Message | undefined,
  thread: ThreadChannel,
  threadToSession: Map<string, string>
) {
  const existing = threadToSession.get(thread.id);
  let lastMessage: Message | undefined;
  let accumulatedParts: any[] = [];
  
  await runOpencode({
    prompt,
    sessionID: existing,
    async onMessage(message) {
      threadToSession.set(thread.id, message.sessionID);
      if (thinkingMessage) {
        thinkingMessage.delete();
        thinkingMessage = undefined;
      }
      
      let embeds: EmbedBuilder[] = [];
      let files: AttachmentBuilder[] = [];
      let shouldCreateNewMessage = false;
      
      switch (message.type) {
        case "system":
          shouldCreateNewMessage = true;
          const embed = new EmbedBuilder();
          embed.setColor("Grey");
          embed.setAuthor({ name: "System" });
          embed.setFooter({
            text: `Model: ${message.model}\nTools: ${message.tools?.join(", ") || ""}`,
          });
          embeds.push(embed);
          break;
        case "assistant":
          // Accumulate assistant parts and update the same message
          if (message.parts) {
            accumulatedParts = message.parts;
            const assistantEmbeds = messageToEmbed(accumulatedParts);
            embeds.push(...assistantEmbeds);
          }
          break;
        case "user":
          shouldCreateNewMessage = true;
          accumulatedParts = [];
          const payload = userContentToDiscord(message.content || message.parts || []);
          embeds.push(...payload.embeds);
          files.push(...payload.files);
          break;
        case "result":
          shouldCreateNewMessage = true;
          accumulatedParts = [];
          const resultEmbed = new EmbedBuilder();
          resultEmbed.setColor("Green");
          resultEmbed.setDescription(message.content || "Complete");
          embeds.push(resultEmbed);
          break;
        case "error":
          shouldCreateNewMessage = true;
          accumulatedParts = [];
          const errorEmbed = new EmbedBuilder();
          errorEmbed.setColor("Red");
          errorEmbed.setDescription(`Error: ${message.error}`);
          embeds.push(errorEmbed);
          break;
      }
      
      if (embeds.length > 0) {
        try {
          if (shouldCreateNewMessage || !lastMessage) {
            // Send a new message for system, user, result, error, or first assistant message
            lastMessage = await thread.send({
              embeds,
              files: files.length ? files : undefined,
            });
          } else if (lastMessage && message.type === "assistant") {
            // Update the existing message for assistant streaming
            await lastMessage.edit({
              embeds,
              files: files.length ? files : undefined,
            });
          }
        } catch (error) {
          const errorEmbed = new EmbedBuilder();
          errorEmbed.setColor("Red");
          errorEmbed.setDescription(
            "Error formatting message: \n\n" + JSON.stringify(message, null, 2)
          );
          console.error("Error sending message:", error);
          await thread.send({ embeds: [errorEmbed] });
        }
      }
    },
  });
}

export async function startDiscordBot({ token, channelId }: StartOptions) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
  });

  // threadId -> opencode session id
  const threadToSession = new Map<string, string>();

  client.once(Events.ClientReady, (c) => {
    console.log(`Discord bot logged in as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      // console.log(message)
      if (message.author?.bot) return;
      if (message.partial) {
        try {
          await message.fetch();
        } catch {
          return;
        }
      }

      // New message in the configured channel => create a thread + start a Claude session
      if (message.channelId === channelId) {
        const baseName = message.content.replace(/\s+/g, " ").trim();
        const name = (baseName || "Claude Thread").slice(0, 80);

        const thread = await message.startThread({
          name: name.length > 0 ? name : "Claude Thread",
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: "Start Claude session",
        });

        await thread.send("Starting OpenCode session…");

        await opencodeToDiscord(
          message.content || "",
          undefined,
          thread,
          threadToSession
        );

        return;
      }

      // Message inside a thread that has a session => continue that Claude session
      const channel = message.channel;
      const isThreadChannel =
        ("isThread" in channel &&
          typeof channel.isThread === "function" &&
          channel.isThread()) ||
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.AnnouncementThread;

      if (isThreadChannel) {
        const thread = channel;
        const existing = threadToSession.get(thread.id);
        if (!existing) return; // Not a managed thread

        const thinkingMessage = await thread.send("Thinking…");
        await opencodeToDiscord(
          message.content || "",
          thinkingMessage,
          thread,
          threadToSession
        );
      }
    } catch (error) {
      console.error("Discord handler error:", error);
      try {
        const where =
          message.channel && "send" in message.channel
            ? (message.channel as any)
            : undefined;
        const errMsg = error instanceof Error ? error.message : String(error);
        if (where?.send) {
          await where.send(`Error: ${errMsg}`);
        } else {
          console.error("Discord handler error:", error);
        }
      } catch {
        console.error("Discord handler error (fallback):", error);
      }
    }
  });

  await client.login(token);

  // Cleanup on shutdown
  process.on("SIGINT", () => {
    stopOpencode();
    client.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopOpencode();
    client.destroy();
    process.exit(0);
  });
}
