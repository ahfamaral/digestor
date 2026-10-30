/** Upload rules shared by the upload route and the UI copy, so they can't drift. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm"] as const;
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "wav"] as const;

export const UPLOAD_UNSUPPORTED = "Unsupported file type. Use MP4, MOV, MKV, WebM, MP3, M4A or WAV.";
export const AUDIO_ONLY_WARNING = "This file has no video. Clips will show a waveform instead of a picture.";
export const AUDIO_ONLY_CHECKBOX = "I understand clips from this file will have no video picture.";

export const isAudioExtension = (ext: string): boolean => (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
export const isUploadExtension = (ext: string): boolean => isAudioExtension(ext) || (VIDEO_EXTENSIONS as readonly string[]).includes(ext);

/** Shown wherever a clip would need the source video after retention removed it (API 409s, disabled Play). */
export const VIDEO_REMOVED = "The video was removed after 14 days. Re-upload it to make new clips.";
