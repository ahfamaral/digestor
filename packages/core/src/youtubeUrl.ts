export class InvalidYouTubeUrlError extends Error {
  constructor(message = "Paste a link to a single YouTube video.") {
    super(message);
    this.name = "InvalidYouTubeUrlError";
  }
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

export function parseYouTubeUrl(input: string): { videoId: string; url: string } {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new InvalidYouTubeUrlError();
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new InvalidYouTubeUrlError();
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (host === "youtu.be") {
    id = parts[0] ?? null;
  } else if (HOSTS.has(host)) {
    if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (parts[0] === "shorts" || parts[0] === "live") id = parts[1] ?? null;
  }
  if (!id || !ID_RE.test(id)) throw new InvalidYouTubeUrlError();
  return { videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
}
