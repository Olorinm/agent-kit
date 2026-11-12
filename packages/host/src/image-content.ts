import type { ProductToolResult } from "./agent.js";
/** Decode native inline image content without fetching a product-supplied URL. */
export function inlineImage(
  url: string,
): { data: string; mimeType: string } | undefined {
  if (!url.startsWith("data:")) return undefined;
  const separator = url.indexOf(",");
  if (separator < 0 || separator > 120) throw new Error("invalid_inline_image");
  const header = /^data:(image\/[a-zA-Z0-9.+-]+);base64$/.exec(
    url.slice(0, separator),
  );
  if (!header) throw new Error("invalid_inline_image");
  const data = url.slice(separator + 1);
  if (data.length > 42_000_000) throw new Error("inline_image_too_large");
  if (!data.length || data.length % 4 || /[^A-Za-z0-9+/=]/.test(data))
    throw new Error("invalid_inline_image");
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data)
    throw new Error("invalid_inline_image");
  if (bytes.length > 30 * 1024 * 1024)
    throw new Error("inline_image_too_large");
  return { data, mimeType: header[1]! };
}
export function mcpImage(url: string) {
  const image = inlineImage(url);
  return image
    ? { type: "image" as const, ...image }
    : { type: "resource_link" as const, uri: url, name: "image" };
}

/** Keep the public tool outcome consistent with what can be delivered to MCP. */
export function mcpToolResult(result: ProductToolResult) {
  try {
    return {
      result,
      content: result.contentItems.map((item) =>
        item.type === "inputText"
          ? { type: "text" as const, text: item.text }
          : mcpImage(item.imageUrl),
      ),
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return {
      result: {
        success: false,
        contentItems: [{ type: "inputText" as const, text }],
      },
      content: [{ type: "text" as const, text }],
    };
  }
}
