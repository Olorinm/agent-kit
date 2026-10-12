/** Decode native inline image content without fetching a product-supplied URL. */
export function inlineImage(url: string): { data: string; mimeType: string } | undefined {
  const separator = url.indexOf(",");
  if (separator < 0 || separator > 120) return undefined;
  const header = /^data:(image\/[a-zA-Z0-9.+-]+);base64$/.exec(url.slice(0, separator));
  if (!header) return undefined;
  return { data: url.slice(separator + 1), mimeType: header[1]! };
}
export function mcpImage(url: string) {
  const image = inlineImage(url);
  return image ? { type: "image" as const, ...image } : { type: "resource_link" as const, uri: url, name: "image" };
}
