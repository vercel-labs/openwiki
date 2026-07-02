import {
  reserveChatMessageAttempt,
  type ChatRateLimitConfig,
  type ChatRateLimitScope,
} from "@/lib/storage";
import { getClientKeyHash } from "@/lib/request-client-key";

export const chatRateLimitedCode = "chat_rate_limited";

const defaultClientHourlyLimit = 40;
const defaultClientDailyLimit = 200;
const defaultGlobalHourlyLimit = 600;

export class ChatRateLimitError extends Error {
  limit: number;
  resetAt: string;
  retryAfterSeconds: number;
  scope: ChatRateLimitScope;

  constructor(input: {
    limit: number;
    message: string;
    resetAt: string;
    retryAfterSeconds: number;
    scope: ChatRateLimitScope;
  }) {
    super(input.message);
    this.name = "ChatRateLimitError";
    this.limit = input.limit;
    this.resetAt = input.resetAt;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.scope = input.scope;
  }
}

export async function enforceChatRateLimit(input: {
  repoFullName: string;
  request: Request;
}): Promise<void> {
  if (!isChatRateLimitEnabled()) return;

  const config = getChatRateLimitConfig();
  if (
    config.clientDailyLimit === 0 &&
    config.clientHourlyLimit === 0 &&
    config.globalHourlyLimit === 0
  ) {
    return;
  }

  const reservation = await reserveChatMessageAttempt({
    clientKeyHash: getClientKeyHash(input.request),
    config,
    repoFullName: input.repoFullName,
  });

  if (reservation.allowed) return;

  throw new ChatRateLimitError({
    limit: reservation.limit,
    message: getRateLimitMessage(reservation.scope, reservation.retryAfterSeconds),
    resetAt: reservation.resetAt,
    retryAfterSeconds: reservation.retryAfterSeconds,
    scope: reservation.scope,
  });
}

function isChatRateLimitEnabled(): boolean {
  const value = process.env.OPENWIKI_CHAT_RATE_LIMIT_ENABLED;
  if (value === undefined || value.trim().length === 0) return true;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function getChatRateLimitConfig(): ChatRateLimitConfig {
  return {
    clientDailyLimit: readNonNegativeInteger(
      process.env.OPENWIKI_CHAT_RATE_LIMIT_CLIENT_DAILY,
      defaultClientDailyLimit,
    ),
    clientHourlyLimit: readNonNegativeInteger(
      process.env.OPENWIKI_CHAT_RATE_LIMIT_CLIENT_HOURLY,
      defaultClientHourlyLimit,
    ),
    globalHourlyLimit: readNonNegativeInteger(
      process.env.OPENWIKI_CHAT_RATE_LIMIT_GLOBAL_HOURLY,
      defaultGlobalHourlyLimit,
    ),
  };
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function getRateLimitMessage(scope: ChatRateLimitScope, retryAfterSeconds: number): string {
  const wait = formatWaitTime(retryAfterSeconds);

  if (scope === "global_hour") {
    return `This OpenWiki instance is busy answering questions. Try again in ${wait}.`;
  }

  if (scope === "client_day") {
    return `You have reached today's chat limit. Try again in ${wait}.`;
  }

  return `You have sent several chat messages recently. Try again in ${wait}.`;
}

function formatWaitTime(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
