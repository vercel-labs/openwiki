import {
  reserveRepositoryGenerationAttempt,
  type RepositoryGenerationRateLimitConfig,
  type RepositoryGenerationRateLimitScope,
} from "@/lib/storage";
import { getClientKeyHash } from "@/lib/request-client-key";

export const repositoryGenerationRateLimitedCode = "repository_generation_rate_limited";

const defaultClientHourlyLimit = 10;
const defaultClientDailyLimit = 50;
const defaultGlobalHourlyLimit = 120;
const defaultRepoCooldownMinutes = 10;

export class RepositoryGenerationRateLimitError extends Error {
  limit: number;
  resetAt: string;
  retryAfterSeconds: number;
  scope: RepositoryGenerationRateLimitScope;

  constructor(input: {
    limit: number;
    message: string;
    resetAt: string;
    retryAfterSeconds: number;
    scope: RepositoryGenerationRateLimitScope;
  }) {
    super(input.message);
    this.name = "RepositoryGenerationRateLimitError";
    this.limit = input.limit;
    this.resetAt = input.resetAt;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.scope = input.scope;
  }
}

export async function enforceRepositoryGenerationRateLimit(input: {
  repoFullName: string;
  request: Request;
}): Promise<void> {
  if (!isRepositoryGenerationRateLimitEnabled()) return;

  const config = getRepositoryGenerationRateLimitConfig();
  if (
    config.clientDailyLimit === 0 &&
    config.clientHourlyLimit === 0 &&
    config.globalHourlyLimit === 0 &&
    config.repoCooldownMs === 0
  ) {
    return;
  }

  const reservation = await reserveRepositoryGenerationAttempt({
    clientKeyHash: getClientKeyHash(input.request),
    config,
    repoFullName: input.repoFullName,
  });

  if (reservation.allowed) return;

  throw new RepositoryGenerationRateLimitError({
    limit: reservation.limit,
    message: getRateLimitMessage(reservation.scope, reservation.retryAfterSeconds),
    resetAt: reservation.resetAt,
    retryAfterSeconds: reservation.retryAfterSeconds,
    scope: reservation.scope,
  });
}

function isRepositoryGenerationRateLimitEnabled(): boolean {
  const value = process.env.OPENWIKI_GENERATION_RATE_LIMIT_ENABLED;
  if (value === undefined || value.trim().length === 0) return true;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function getRepositoryGenerationRateLimitConfig(): RepositoryGenerationRateLimitConfig {
  return {
    clientDailyLimit: readNonNegativeInteger(
      process.env.OPENWIKI_GENERATION_RATE_LIMIT_CLIENT_DAILY,
      defaultClientDailyLimit,
    ),
    clientHourlyLimit: readNonNegativeInteger(
      process.env.OPENWIKI_GENERATION_RATE_LIMIT_CLIENT_HOURLY,
      defaultClientHourlyLimit,
    ),
    globalHourlyLimit: readNonNegativeInteger(
      process.env.OPENWIKI_GENERATION_RATE_LIMIT_GLOBAL_HOURLY,
      defaultGlobalHourlyLimit,
    ),
    repoCooldownMs:
      readNonNegativeInteger(
        process.env.OPENWIKI_GENERATION_RATE_LIMIT_REPO_COOLDOWN_MINUTES,
        defaultRepoCooldownMinutes,
      ) *
      60 *
      1_000,
  };
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function getRateLimitMessage(scope: RepositoryGenerationRateLimitScope, retryAfterSeconds: number): string {
  const wait = formatWaitTime(retryAfterSeconds);

  if (scope === "repo_cooldown") {
    return `A wiki generation for this repository started recently. Try again in ${wait}.`;
  }

  if (scope === "global_hour") {
    return `This OpenWiki instance is busy generating wikis. Try again in ${wait}.`;
  }

  if (scope === "client_day") {
    return `You have reached today's wiki generation limit. Try again in ${wait}.`;
  }

  return `You have started several wiki generations recently. Try again in ${wait}.`;
}

function formatWaitTime(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
