const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|ts|mts|3gp|mp3|m4a|aac|wav|flac|ogg|oga|opus|wma)$/i;

/**
 * Whether a stored title reads like a file name rather than a title: it ends in a media extension ("debate.mp4"), or it
 * has no spaces and is lowercase words joined by dashes or underscores ("globo-debate-lula-flavio", "sessao_plenaria_2026").
 */
export function looksLikeFileName(title: string): boolean {
  const s = title.trim();
  if (s === "") return false;
  if (MEDIA_EXT.test(s)) return true;
  return !/\s/.test(s) && /[-_]/.test(s) && s === s.toLowerCase() && /^[\p{Ll}\p{N}]+([-_.][\p{Ll}\p{N}]+)+$/u.test(s);
}

/** The title to show for a session: the context check's title when the stored one is only a file name, else the stored one. */
export function displayTitle(stored: string, contextTitle: string | null | undefined): string {
  const context = contextTitle?.trim();
  return context && looksLikeFileName(stored) ? context : stored;
}
