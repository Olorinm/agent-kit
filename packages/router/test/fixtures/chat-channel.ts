import { bindAccount, type ChannelAdapter, type ChannelContext, type ReplyRoute } from "../../src/channels/api.js";
import type { ServiceExtension } from "../../src/service/managed.js";

/**
 * A stand-in for an owner's external chat channel (a provider such as Feishu or Telegram) in service-level tests:
 * messages are delivered to it with `extension.communication.receive(CHAT, …)`, and every send is accepted and recorded.
 */
export const CHAT = "chat";
export class ChatChannel implements ChannelAdapter {
  readonly kind = "chat";
  readonly retrySafe = true;
  sent: Array<{ route: ReplyRoute; text: string; key: string }> = [];
  async start(context: ChannelContext) { bindAccount(context, "chat-bot"); }
  async stop() {}
  async send(route: ReplyRoute, text: string, key: string) { this.sent.push({ route, text, key }); return { externalId: `sent-${key}` }; }
}
/** Register the chat connection on a channel runtime that has not started yet; `ownerAddresses` are the owner's sender ids on it. */
export function withChat(extension: ServiceExtension, ownerAddresses: string[], channel = new ChatChannel()): ServiceExtension {
  extension.communication!.register({ id: CHAT, ownerAddresses }, channel);
  return extension;
}
