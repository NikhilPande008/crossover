// Qloo search is fuzzy: a made-up title still returns its nearest entity. A match is
// "close" only if the typed comp and the entity name share a meaningful word.

const STOP = new Set(["the", "and", "for", "with", "from"]);

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));

export function isCloseMatch(query: string, name: string): boolean {
  if (query.trim().toLowerCase() === name.trim().toLowerCase()) return true;
  const n = new Set(words(name));
  return words(query).some((w) => n.has(w));
}
