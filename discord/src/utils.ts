import type {
  Message,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolUseBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  // Param-side types for user messages
  ContentBlockParam,
  TextBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
  SearchResultBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
  ServerToolUseBlockParam,
  WebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
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
  // Discord embed field limits are 1024 characters; the code fence adds 7 chars
  // Reserve some room for formatting and ensure we don't exceed 1024 when used in fields
  body = truncate(body, max);
  return "```json\n" + body + "\n```";
}

function renderTextBlock(embed: EmbedBuilder, block: TextBlock) {
  embed.setColor("Purple");
  embed.setDescription(truncate(block.text));
  if (block.citations && block.citations.length > 0) {
    const citations = block.citations
      .slice(0, 5)
      .map((c) => ("cited_text" in c ? c.cited_text : "(citation)"))
      .filter(Boolean);
    if (citations.length > 0) {
      embed.addFields({
        name: "Citations",
        value: truncate(citations.map((c) => `• ${c}`).join("\n"), 1000),
      });
    }
  }
}

function renderThinkingBlock(embed: EmbedBuilder, block: ThinkingBlock) {
  embed.setColor("Grey");
  embed.setTitle("Thinking");
  embed.setDescription(truncate(block.thinking));
}

function renderRedactedThinkingBlock(
  embed: EmbedBuilder,
  block: RedactedThinkingBlock
) {
  embed.setColor("DarkButNotBlack");
  embed.setTitle("Thinking (redacted)");
  embed.setDescription(truncate(block.data));
}

function renderToolUseBlock(embed: EmbedBuilder, block: ToolUseBlock) {
  embed.setColor("Orange");
  embed.setTitle(truncate(`Tool use: ${block.name}`, 256));
  embed.addFields({ name: "Input", value: formatAsCode(block.input, 1000) });
}

function renderServerToolUseBlock(
  embed: EmbedBuilder,
  block: ServerToolUseBlock
) {
  embed.setColor("Blue");
  embed.setTitle(truncate(`Server tool: ${block.name}`, 256));
  embed.addFields({ name: "Input", value: formatAsCode(block.input, 1000) });
}

function renderWebSearchToolResultBlock(
  embed: EmbedBuilder,
  block: WebSearchToolResultBlock
) {
  embed.setColor("Blurple");
  embed.setTitle("Web search results");

  const content = block.content;
  if (Array.isArray(content)) {
    const results = content;
    const fields = results.slice(0, 5).map((r, idx) => ({
      name: `Result ${idx + 1}`,
      value: truncate(
        `[${r.title}](${r.url})` + (r.page_age ? `\nAge: ${r.page_age}` : ""),
        1000
      ),
    }));
    if (fields.length > 0) embed.addFields(fields);
    embed.setFooter({ text: `${results.length} result(s)` });
  } else if (
    content &&
    typeof content === "object" &&
    content.type === "web_search_tool_result_error"
  ) {
    embed.setColor("Red");
    embed.addFields({
      name: "Error",
      value: `
• Code: ${content.error_code}
`,
    });
  } else {
    embed.addFields({ name: "Content", value: formatAsCode(content, 1000) });
  }
}

export function messageToEmbed(message: Message): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];

  for (const block of message.content as ContentBlock[]) {
    const embed = new EmbedBuilder();
    switch (block.type) {
      case "text":
        renderTextBlock(embed, block);
        break;
      case "thinking":
        renderThinkingBlock(embed, block);
        break;
      case "redacted_thinking":
        renderRedactedThinkingBlock(embed, block);
        break;
      case "tool_use":
        renderToolUseBlock(embed, block);
        break;
      case "server_tool_use":
        renderServerToolUseBlock(embed, block);
        break;
      case "web_search_tool_result":
        renderWebSearchToolResultBlock(embed, block);
        break;
    }
    embeds.push(embed);
  }
  return embeds;
}

function extractBase64Data(data: string): string {
  const commaIndex = data.indexOf(",");
  if (commaIndex !== -1) return data.slice(commaIndex + 1);
  return data;
}

function imageExtensionFromMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpeg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

type DiscordPayload = { embeds: EmbedBuilder[]; files: AttachmentBuilder[] };

function renderTextParam(embed: EmbedBuilder, block: TextBlockParam) {
  embed.setColor("Blue");
  embed.setDescription(truncate(block.text));
}

function renderImageParam(
  embeds: EmbedBuilder[],
  files: AttachmentBuilder[],
  block: ImageBlockParam,
  counters: { image: number }
) {
  const embed = new EmbedBuilder();
  embed.setColor("Blue");
  switch (block.source.type) {
    case "base64": {
      const ext = imageExtensionFromMime(block.source.media_type);
      counters.image += 1;
      const filename = `image-${counters.image}.${ext}`;
      const b64 = extractBase64Data(block.source.data);
      const buf = Buffer.from(b64, "base64");
      const file = new AttachmentBuilder(buf, { name: filename });
      files.push(file);
      embed.setImage(`attachment://${filename}`);
      break;
    }
    case "url": {
      embed.setImage(block.source.url);
      break;
    }
  }
  embeds.push(embed);
}

function renderDocumentParam(
  embeds: EmbedBuilder[],
  files: AttachmentBuilder[],
  block: DocumentBlockParam,
  counters: { document: number; image: number }
) {
  const embed = new EmbedBuilder();
  embed.setColor("Blue");
  embed.setTitle(truncate(block.title ?? "Document", 256));
  switch (block.source.type) {
    case "base64": {
      counters.document += 1;
      const filename = `document-${counters.document}.pdf`;
      const b64 = extractBase64Data(block.source.data);
      const buf = Buffer.from(b64, "base64");
      const file = new AttachmentBuilder(buf, { name: filename });
      files.push(file);
      embed.setDescription("Attached PDF document");
      break;
    }
    case "url": {
      embed.setURL(block.source.url);
      embed.setDescription("PDF document");
      break;
    }
    case "text": {
      embed.setDescription(truncate(block.source.data));
      break;
    }
    case "content": {
      const content = block.source.content;
      if (typeof content === "string") {
        embed.setDescription(truncate(content));
      } else if (Array.isArray(content)) {
        // Render nested content blocks (text/image)
        embeds.push(embed);
        for (const nested of content) {
          if (nested.type === "text") {
            const nestedEmbed = new EmbedBuilder();
            renderTextParam(nestedEmbed, nested);
            embeds.push(nestedEmbed);
          } else if (nested.type === "image") {
            renderImageParam(embeds, files, nested, counters);
          }
        }
        return;
      }
      break;
    }
  }
  embeds.push(embed);
}

function renderSearchResultParam(
  embed: EmbedBuilder,
  block: SearchResultBlockParam
) {
  embed.setColor("Green");
  embed.setTitle(truncate(block.title, 256));
  embed.addFields({ name: "Source", value: truncate(block.source, 1000) });
  const text = block.content?.map((c) => c.text).join("\n\n");
  if (text) embed.setDescription(truncate(text));
}

function renderToolUseParam(embed: EmbedBuilder, block: ToolUseBlockParam) {
  renderToolUseBlock(
    embed as unknown as EmbedBuilder,
    block as unknown as ToolUseBlock
  );
}

function renderServerToolUseParam(
  embed: EmbedBuilder,
  block: ServerToolUseBlockParam
) {
  renderServerToolUseBlock(
    embed as unknown as EmbedBuilder,
    block as unknown as ServerToolUseBlock
  );
}

function renderThinkingParam(embed: EmbedBuilder, block: ThinkingBlock) {
  renderThinkingBlock(embed, block);
}

function renderRedactedThinkingParam(
  embed: EmbedBuilder,
  block: RedactedThinkingBlock
) {
  renderRedactedThinkingBlock(embed, block);
}

function renderWebSearchToolResultParam(
  embed: EmbedBuilder,
  block: WebSearchToolResultBlockParam
) {
  renderWebSearchToolResultBlock(
    embed as unknown as EmbedBuilder,
    block as unknown as WebSearchToolResultBlock
  );
}

function renderToolResultParam(
  embeds: EmbedBuilder[],
  files: AttachmentBuilder[],
  block: ToolResultBlockParam,
  counters: { image: number; document: number }
) {
  const embed = new EmbedBuilder();
  embed.setColor(block.is_error ? "Red" : "Orange");
  embed.setTitle(block.is_error ? "Tool result (error)" : "Tool result");

  const content = block.content;
  if (typeof content === "string" && content) {
    embed.addFields({ name: "Content", value: formatAsCode(content, 1000) });
    embeds.push(embed);
    return;
  }

  embeds.push(embed);
  if (Array.isArray(content)) {
    for (const part of content) {
      switch (part.type) {
        case "text": {
          const e = new EmbedBuilder();
          renderTextParam(e, part);
          embeds.push(e);
          break;
        }
        case "image": {
          renderImageParam(embeds, files, part, counters);
          break;
        }
        case "search_result": {
          const e = new EmbedBuilder();
          renderSearchResultParam(e, part);
          embeds.push(e);
          break;
        }
      }
    }
  }
}

export function userContentToDiscord(
  content: string | Array<ContentBlockParam>
): DiscordPayload {
  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];
  const counters = { image: 0, document: 0 };

  if (typeof content === "string") {
    const e = new EmbedBuilder();
    e.setColor("Blue");
    e.setDescription(truncate(content));
    embeds.push(e);
    return { embeds, files };
  }

  for (const block of content) {
    switch (block.type) {
      case "text": {
        const e = new EmbedBuilder();
        renderTextParam(e, block);
        embeds.push(e);
        break;
      }
      case "image": {
        renderImageParam(embeds, files, block, counters);
        break;
      }
      case "document": {
        renderDocumentParam(embeds, files, block, counters);
        break;
      }
      case "search_result": {
        const e = new EmbedBuilder();
        renderSearchResultParam(e, block);
        embeds.push(e);
        break;
      }
      case "thinking": {
        const e = new EmbedBuilder();
        renderThinkingParam(e, block as unknown as ThinkingBlock);
        embeds.push(e);
        break;
      }
      case "redacted_thinking": {
        const e = new EmbedBuilder();
        renderRedactedThinkingParam(
          e,
          block as unknown as RedactedThinkingBlock
        );
        embeds.push(e);
        break;
      }
      case "tool_use": {
        const e = new EmbedBuilder();
        renderToolUseParam(e, block as ToolUseBlockParam);
        embeds.push(e);
        break;
      }
      case "tool_result": {
        renderToolResultParam(embeds, files, block, counters);
        break;
      }
      case "server_tool_use": {
        const e = new EmbedBuilder();
        renderServerToolUseParam(e, block as ServerToolUseBlockParam);
        embeds.push(e);
        break;
      }
      case "web_search_tool_result": {
        const e = new EmbedBuilder();
        renderWebSearchToolResultParam(
          e,
          block as WebSearchToolResultBlockParam
        );
        embeds.push(e);
        break;
      }
    }
  }

  return { embeds, files };
}
