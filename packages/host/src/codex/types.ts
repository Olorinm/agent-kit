import type { JsonValue } from "../types.js";

export type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
};

export type RpcResponse = {
  id: number | string;
  result?: JsonValue;
  error?: {
    code?: number;
    message: string;
    data?: JsonValue;
  };
};

export type RpcMessage = RpcRequest | RpcResponse;

export type CodexDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

export type CodexDynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: JsonValue;
};

export type CodexDynamicToolCallResponse = {
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
};

export type CodexThreadBinding = {
  threadId: string;
  dynamicToolsFingerprint: string;
  runtimeBindingFingerprint?: string;
  model?: string;
  modelProvider?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
};

export type CodexThreadStartResponse = {
  thread?: {
    id?: string;
  };
  model?: string | null;
  modelProvider?: string | null;
};

export type CodexTurnStartResponse = {
  turn?: {
    id?: string;
    status?: string;
  };
};

export type CodexInitializeResponse = {
  userAgent?: string;
  codexHome?: string;
};

export type CodexTurnInputItem =
  | { type: "text"; text: string; text_elements: [] }
  | ({ type: "image"; detail?: "auto" | "low" | "high" | "original" } & (
      | { url: string; fileId?: string }
      | { fileId: string; url?: string }
    ))
  | {
      type: "localImage";
      path: string;
      detail?: "auto" | "low" | "high" | "original";
    }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type ServerRequestHandler = (request: {
  id: number | string;
  method: string;
  params?: JsonValue;
}) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type ServerNotificationHandler = (notification: {
  method: string;
  params?: JsonValue;
}) => void | Promise<void>;

export const MIN_CODEX_APP_SERVER_VERSION = "0.125.0";
