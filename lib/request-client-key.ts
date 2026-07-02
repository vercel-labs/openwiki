import { createHash } from "node:crypto";

export function getClientKeyHash(request: Request): string {
  const clientIp = getClientAddress(request);
  const userAgent = request.headers.get("user-agent")?.slice(0, 200) ?? "unknown";

  return createHash("sha256")
    .update(`${clientIp}\n${userAgent}`)
    .digest("hex");
}

function getClientAddress(request: Request): string {
  const vercelForwarded = getFirstForwardedAddress(request.headers.get("x-vercel-forwarded-for"));
  if (process.env.VERCEL === "1") return vercelForwarded ?? "unknown";

  if (!trustProxyHeaders()) return "unknown";

  return (
    getFirstForwardedAddress(request.headers.get("x-forwarded-for")) ??
    getFirstForwardedAddress(request.headers.get("x-real-ip")) ??
    getFirstForwardedAddress(request.headers.get("cf-connecting-ip")) ??
    "unknown"
  );
}

function trustProxyHeaders(): boolean {
  const value = process.env.OPENWIKI_TRUST_PROXY_HEADERS;
  if (value === undefined || value.trim().length === 0) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function getFirstForwardedAddress(value: string | null): string | null {
  const address = value
    ?.split(",")
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  return address ?? null;
}
