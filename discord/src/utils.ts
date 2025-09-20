import type { Part } from "@opencode-ai/sdk";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";

function truncate(text: string, max = 1800): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function formatAsCode(jsonLike: unknown, max = 1800): string {
  let body: string;
  try {
    body = JSON.stringify(jsonLike, null, 2);
  } catch {
    body = String(jsonLike);
  }
  body = truncate(body, max);
  return "```json\n" + body + "\n```";
}

function renderTextPart(embed: EmbedBuilder, part: Part) {
  if (part.type === "text") {
    embed.setColor("Purple");
    embed.setDescription(truncate(part.text));
  }
}

function renderReasoningPart(embed: EmbedBuilder, part: Part) {
  if (part.type === "reasoning") {
    embed.setColor("Grey");
    embed.setTitle("Reasoning");
    embed.setDescription(truncate(part.text));
  }
}

function renderToolPart(embed: EmbedBuilder, part: Part) {
  if (part.type === "tool") {
    embed.setColor("Orange");
    embed.setTitle(truncate(`Tool: ${part.tool}`, 256));
    
    if (part.state.status === "pending") {
      embed.setDescription("Pending...");
    } else if (part.state.status === "running") {
      embed.setDescription(part.state.title || "Running...");
      if (part.state.input) {
        embed.addFields({ name: "Input", value: formatAsCode(part.state.input, 1000) });
      }
    } else if (part.state.status === "completed") {
      embed.setDescription(part.state.title || "Completed");
      if (part.state.input) {
        embed.addFields({ name: "Input", value: formatAsCode(part.state.input, 1000) });
      }
      if (part.state.output) {
        embed.addFields({ name: "Output", value: truncate(part.state.output, 1000) });
      }
    } else if (part.state.status === "error") {
      embed.setColor("Red");
      embed.setDescription("Error");
      if (part.state.error) {
        embed.addFields({ name: "Error", value: truncate(part.state.error, 1000) });
      }
    }
  }
}

function renderFilePart(embed: EmbedBuilder, part: Part) {
  if (part.type === "file") {
    embed.setColor("Blue");
    embed.setTitle(part.filename || "File");
    embed.setDescription(`Type: ${part.mime}`);
    if (part.url) {
      embed.setURL(part.url);
    }
  }
}

export function messageToEmbed(parts: Part[]): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];

  for (const part of parts) {
    const embed = new EmbedBuilder();
    
    switch (part.type) {
      case "text":
        renderTextPart(embed, part);
        embeds.push(embed);
        break;
      case "reasoning":
        renderReasoningPart(embed, part);
        embeds.push(embed);
        break;
      case "tool":
        renderToolPart(embed, part);
        embeds.push(embed);
        break;
      case "file":
        renderFilePart(embed, part);
        embeds.push(embed);
        break;
      // Skip other part types we don't need to render
      case "snapshot":
      case "patch":
      case "agent":
      case "step-start":
      case "step-finish":
        break;
    }
  }
  
  return embeds;
}

type DiscordPayload = { embeds: EmbedBuilder[]; files: AttachmentBuilder[] };

export function userContentToDiscord(
  content: string | Part[]
): DiscordPayload {
  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];

  if (typeof content === "string") {
    const e = new EmbedBuilder();
    e.setColor("Blue");
    e.setDescription(truncate(content));
    embeds.push(e);
    return { embeds, files };
  }

  // If it's an array of parts, use messageToEmbed
  if (Array.isArray(content)) {
    const partsEmbeds = messageToEmbed(content);
    embeds.push(...partsEmbeds);
  }

  return { embeds, files };
}
