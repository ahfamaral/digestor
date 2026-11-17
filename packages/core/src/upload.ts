/** Upload rules shared by the upload route and the UI copy, so they can't drift. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm"] as const;
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav"] as const;

export const UPLOAD_UNSUPPORTED = "Unsupported file type. Use MP4, MOV, MKV, WebM, MP3, M4A or WAV.";
export const AUDIO_ONLY_WARNING = "This file has no video. Clips will show a waveform instead of a picture.";
export const AUDIO_ONLY_CHECKBOX = "I understand clips from this file will have no video picture.";

export const isAudioExtension = (ext: string): boolean => (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
export const isUploadExtension = (ext: string): boolean => isAudioExtension(ext) || (VIDEO_EXTENSIONS as readonly string[]).includes(ext);

/**
 * Shown wherever a clip would need the source video after retention removed it (API 409s, disabled Play). The copy
 * assumes the default `VIDEO_RETENTION_DAYS` (14); change it with that setting.
 */
export const VIDEO_REMOVED = "The video was removed after 14 days. Re-upload it to make new clips.";

/** Spoken-language overrides offered at upload (AssemblyAI `language_code`); empty = detect automatically. Labels live in the web catalogue. */
export const SPOKEN_LANGUAGE_CODES = ["pt", "en", "es", "fr", "de", "it"] as const;
export type SpokenLanguageCode = (typeof SPOKEN_LANGUAGE_CODES)[number];
export const isSpokenLanguageCode = (v: unknown): v is SpokenLanguageCode => (SPOKEN_LANGUAGE_CODES as readonly unknown[]).includes(v);
export const LANGUAGE_PICK_ERROR = "Pick a language from the list.";
