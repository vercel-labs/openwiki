export function formatIndexedAt(value: string | Date, now: number): string {
  const date = new Date(value);
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1_000));

  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  }).format(date);
}
