import { createHash } from "node:crypto";

export function getClientKeyHash(request: Request): string {
  const clientIp =
    getFirstForwardedAddress(request.headers.get("x-vercel-forwarded-for")) ??
    getFirstForwardedAddress(request.headers.get("x-forwarded-for")) ??
    getFirstForwardedAddress(request.headers.get("x-real-ip")) ??
    getFirstForwardedAddress(request.headers.get("cf-connecting-ip")) ??
    "unknown";
  const userAgent = request.headers.get("user-agent")?.slice(0, 200) ?? "unknown";

  return createHash("sha256")
    .update(`${clientIp}\n${userAgent}`)
    .digest("hex");
}

function getFirstForwardedAddress(value: string | null): string | null {
  const address = value
    ?.split(",")
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  return address ?? null;
}
