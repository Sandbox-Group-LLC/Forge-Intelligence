// Shared relative-time formatter. Extracted from AdminPage so both the
// AlertsBell and the Admin Mission Control panel can use it.
export function timeAgo(ts: string | number | Date): string {
  const d = new Date(ts as never);
  const diff = Date.now() - d.getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
