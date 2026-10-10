import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { RequestError } from "./errors.js";
import type { ImageSource } from "./images.js";

/** A local WAV or MP3 path, raw WAV or MP3 bytes, or a `data:audio/...;base64,` URL. */
export type AudioSource = string | Uint8Array;

/** A local MP4 or WebM path, raw MP4 or WebM bytes, or a `data:video/...;base64,` URL. */
export type VideoSource = string | Uint8Array;

export type AudioContentType = "audio/wav" | "audio/mpeg";
export type VideoContentType = "video/mp4" | "video/webm";

/** Documented Clef-omni limits. https://developers.cloudflare.com/workers-ai/models/clef-omni/ */
export const CLEF_OMNI_MAX_AUDIO = 4;
export const CLEF_OMNI_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const CLEF_OMNI_MAX_AUDIO_SECONDS = 300;
export const CLEF_OMNI_MAX_VIDEOS = 2;
export const CLEF_OMNI_MAX_VIDEO_BYTES = 16 * 1024 * 1024;
export const CLEF_OMNI_MAX_VIDEO_SECONDS = 60;
/** Audio and video clips together: the bytes their data URLs decode to. */
export const CLEF_OMNI_MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * Media attached to one request. Only the Cloudflare provider accepts any of
 * it: images on every Clef model, audio and videos on clef-omni alone.
 */
export interface MediaInputs {
  /** Local images: a path, PNG/JPEG/WebP bytes, or a base64 data URL. */
  images?: readonly ImageSource[];
  /** WAV or MP3 clips for clef-omni. */
  audio?: readonly AudioSource[];
  /** MP4 or WebM clips for clef-omni. */
  videos?: readonly VideoSource[];
}

/**
 * Keeps only the media arrays that have something in them, so a request
 * without media is built exactly as it was before media existed.
 */
export function presentMedia(inputs: {
  images?: readonly ImageSource[] | undefined;
  audio?: readonly AudioSource[] | undefined;
  videos?: readonly VideoSource[] | undefined;
}): MediaInputs {
  const media: MediaInputs = {};
  if (inputs.images != null && inputs.images.length > 0) media.images = inputs.images;
  if (inputs.audio != null && inputs.audio.length > 0) media.audio = inputs.audio;
  if (inputs.videos != null && inputs.videos.length > 0) media.videos = inputs.videos;
  return media;
}

/** The Clef-omni `audio` and `videos` arrays: base64 data URLs. A key is absent when there is nothing to send. */
export interface ClefWireMedia {
  audio?: string[];
  videos?: string[];
}

const WAV = "audio/wav";
const MP3 = "audio/mpeg";
const MP4 = "video/mp4";
const WEBM = "video/webm";

interface MediaKind<T extends string> {
  noun: "audio" | "video";
  /** For the count message: "audio clips", "videos". */
  plural: string;
  /** For the format messages: "WAV or MP3". */
  formats: string;
  /** With an article: "a WAV or MP3 file". */
  file: string;
  /** For the data URL message. */
  example: string;
  /** Lower-case extension to the content type it promises. */
  extensions: Readonly<Record<string, T>>;
  /** Media types a data URL may declare, mapped to the canonical content type. */
  dataUrlTypes: Readonly<Record<string, T>>;
  /** Content type to the format name used in messages. */
  names: Readonly<Record<T, string>>;
  maxBytes: number;
  perItemLimit: string;
  maxSeconds: number;
  sniff: (bytes: Uint8Array) => T | null;
  duration: (bytes: Uint8Array, contentType: T) => number | null;
}

const AUDIO: MediaKind<AudioContentType> = {
  noun: "audio",
  plural: "audio clips",
  formats: "WAV or MP3",
  file: "a WAV or MP3 file",
  example: "data:audio/wav;base64,...",
  extensions: { ".wav": WAV, ".mp3": MP3 },
  dataUrlTypes: {
    "audio/wav": WAV,
    "audio/x-wav": WAV,
    "audio/wave": WAV,
    "audio/vnd.wave": WAV,
    "audio/mpeg": MP3,
    "audio/mp3": MP3,
  },
  names: { [WAV]: "WAV", [MP3]: "MP3" },
  maxBytes: CLEF_OMNI_MAX_AUDIO_BYTES,
  perItemLimit: "8 MiB per-clip limit",
  maxSeconds: CLEF_OMNI_MAX_AUDIO_SECONDS,
  sniff: sniffAudio,
  // MP3 has no header that says how long it is; the server checks that.
  duration: (bytes, contentType) => (contentType === WAV ? wavDuration(bytes) : null),
};

const VIDEO: MediaKind<VideoContentType> = {
  noun: "video",
  plural: "videos",
  formats: "MP4 or WebM",
  file: "an MP4 or WebM file",
  example: "data:video/mp4;base64,...",
  extensions: { ".mp4": MP4, ".webm": WEBM },
  dataUrlTypes: { "video/mp4": MP4, "video/webm": WEBM },
  names: { [MP4]: "MP4", [WEBM]: "WebM" },
  maxBytes: CLEF_OMNI_MAX_VIDEO_BYTES,
  perItemLimit: "16 MiB per-video limit",
  maxSeconds: CLEF_OMNI_MAX_VIDEO_SECONDS,
  sniff: sniffVideo,
  // WebM keeps its duration deep inside the Segment info; the server checks that.
  duration: (bytes, contentType) => (contentType === MP4 ? mp4Duration(bytes) : null),
};

/**
 * Turns local audio and video into the Clef-omni `audio` and `videos`
 * arrays of `data:<type>;base64,...` strings. Remote URLs are rejected. The
 * limits are the documented ones: 4 clips of 8 MiB and 300 seconds, 2 videos
 * of 16 MiB and 60 seconds, 16 MiB of audio and video bytes together. WAV and
 * MP4 durations are read from their headers; MP3 and WebM leave that to the
 * server.
 */
export function encodeClefMedia(args: {
  audio?: readonly AudioSource[] | undefined;
  videos?: readonly VideoSource[] | undefined;
}): ClefWireMedia {
  const audio = args.audio ?? [];
  const videos = args.videos ?? [];
  if (audio.length > CLEF_OMNI_MAX_AUDIO) {
    throw new RequestError(`at most ${CLEF_OMNI_MAX_AUDIO} audio clips are accepted, got ${audio.length}`);
  }
  if (videos.length > CLEF_OMNI_MAX_VIDEOS) {
    throw new RequestError(`at most ${CLEF_OMNI_MAX_VIDEOS} videos are accepted, got ${videos.length}`);
  }

  const wire: ClefWireMedia = {};
  let decoded = 0;
  const count = (bytes: Uint8Array): void => {
    decoded += bytes.length;
    if (decoded > CLEF_OMNI_MAX_MEDIA_BYTES) {
      throw new RequestError(
        `audio and video clips are ${decoded} bytes combined, over the 16 MiB total decoded limit`
      );
    }
  };
  if (audio.length > 0) wire.audio = audio.map((source, index) => encodeOne(source, index, AUDIO, count));
  if (videos.length > 0) wire.videos = videos.map((source, index) => encodeOne(source, index, VIDEO, count));
  return wire;
}

function encodeOne<T extends string>(
  source: string | Uint8Array,
  index: number,
  kind: MediaKind<T>,
  count: (bytes: Uint8Array) => void
): string {
  const { bytes, label, extension } = loadMedia(source, index, kind);
  if (bytes.length > kind.maxBytes) {
    throw new RequestError(`${label} is ${bytes.length} bytes, over the ${kind.perItemLimit}`);
  }
  const { contentType, durationSeconds } = inspect(bytes, label, kind);
  const promised = extension === null ? undefined : kind.extensions[extension];
  if (promised !== undefined && promised !== contentType) {
    throw new RequestError(
      `${label} has a ${extension} extension but the bytes are ${kind.names[contentType]}`
    );
  }
  if (durationSeconds !== null && durationSeconds > kind.maxSeconds) {
    throw new RequestError(
      `${label} is ${formatSeconds(durationSeconds)} seconds long, over the ${kind.maxSeconds} second limit`
    );
  }
  count(bytes);
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface MediaInfo<T extends string> {
  contentType: T;
  /** Read from the container header when it is cheap to; null when it is not (MP3, WebM). */
  durationSeconds: number | null;
}

/** The content type and, for WAV, the duration of audio bytes. Throws RequestError for anything but WAV or MP3. */
export function inspectAudio(bytes: Uint8Array, label = "audio"): MediaInfo<AudioContentType> {
  return inspect(bytes, label, AUDIO);
}

/** The content type and, for MP4, the duration of video bytes. Throws RequestError for anything but MP4 or WebM. */
export function inspectVideo(bytes: Uint8Array, label = "video"): MediaInfo<VideoContentType> {
  return inspect(bytes, label, VIDEO);
}

function inspect<T extends string>(bytes: Uint8Array, label: string, kind: MediaKind<T>): MediaInfo<T> {
  const contentType = kind.sniff(bytes);
  if (contentType === null) {
    throw new RequestError(`${label} must be ${kind.file}`);
  }
  return { contentType, durationSeconds: kind.duration(bytes, contentType) };
}

function loadMedia<T extends string>(
  source: string | Uint8Array,
  index: number,
  kind: MediaKind<T>
): { bytes: Uint8Array; label: string; extension: string | null } {
  const numbered = `${kind.noun} ${index + 1}`;
  if (typeof source !== "string") {
    return { bytes: source, label: numbered, extension: null };
  }

  const trimmed = source.trim();
  if (trimmed.toLowerCase().startsWith("data:")) {
    return { bytes: bytesFromDataUrl(trimmed, numbered, kind), label: numbered, extension: null };
  }
  if (isRemoteUrl(trimmed)) {
    throw new RequestError(`${numbered}: remote URLs are not accepted; pass a local ${kind.formats} file`);
  }

  const label = `${kind.noun} ${JSON.stringify(source)}`;
  const extension = extname(source).toLowerCase();
  try {
    return { bytes: readFileSync(source), label, extension: extension === "" ? null : extension };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RequestError(`${label}: could not read file: ${message}`);
  }
}

function isRemoteUrl(value: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (match === null) return false;
  // A single letter is a Windows drive (`C:\clip.wav`), not a URL scheme.
  return match[1]!.length > 1;
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$/i;

function bytesFromDataUrl<T extends string>(value: string, label: string, kind: MediaKind<T>): Uint8Array {
  const match = DATA_URL.exec(value);
  const declared = match === null ? undefined : kind.dataUrlTypes[match[1]!.toLowerCase()];
  if (match === null || declared === undefined) {
    throw new RequestError(`${label}: data URLs must be base64 ${kind.formats} (${kind.example})`);
  }
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ""), "base64");
  const actual = kind.sniff(bytes);
  if (actual === null) {
    throw new RequestError(`${label}: data URL is not ${kind.file}`);
  }
  if (actual !== declared) {
    throw new RequestError(`${label}: data URL says ${declared} but the bytes are ${actual}`);
  }
  return bytes;
}

function sniffAudio(bytes: Uint8Array): AudioContentType | null {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return WAV;
  // An ID3v2 tag, or an MPEG audio frame: 11 sync bits, then a version and a
  // layer that are not the reserved values.
  if (bytes.length >= 3 && ascii(bytes, 0, 3) === "ID3") return MP3;
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    (bytes[1]! & 0xe0) === 0xe0 &&
    (bytes[1]! & 0x18) !== 0x08 &&
    (bytes[1]! & 0x06) !== 0x00
  ) {
    return MP3;
  }
  return null;
}

function sniffVideo(bytes: Uint8Array): VideoContentType | null {
  // ISO base media: the first box is `ftyp`, its size in the four bytes before it.
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") return MP4;
  // EBML header, shared with Matroska; the server tells a .mkv from a .webm.
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return WEBM;
  }
  return null;
}

/**
 * Seconds of audio in a WAV: the `data` chunk size over the `fmt ` chunk's
 * byte rate. Null when either chunk is missing or the byte rate is zero.
 */
function wavDuration(bytes: Uint8Array): number | null {
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = ascii(bytes, offset, 4);
    const size = u32le(bytes, offset + 4);
    const data = offset + 8;
    if (tag === "fmt " && size >= 16 && data + 16 <= bytes.length) {
      byteRate = u32le(bytes, data + 8);
    } else if (tag === "data") {
      // A size of zero or past the end is a writer that never patched the
      // header; the bytes that are there are the audio.
      const remaining = bytes.length - data;
      dataBytes = size === 0 || size > remaining ? remaining : size;
    }
    if (byteRate !== null && dataBytes !== null) break;
    offset = data + size + (size & 1);
  }
  if (byteRate === null || byteRate === 0 || dataBytes === null) return null;
  return dataBytes / byteRate;
}

/**
 * Seconds of video in an MP4: `duration / timescale` from the `mvhd` box
 * inside `moov`. Null when the box is missing or the duration is zero or
 * unknown, as in a fragmented file.
 */
function mp4Duration(bytes: Uint8Array): number | null {
  const moov = findBox(bytes, 0, bytes.length, "moov");
  if (moov === null) return null;
  const mvhd = findBox(bytes, moov.start, moov.end, "mvhd");
  if (mvhd === null) return null;

  const version = bytes[mvhd.start];
  let timescale: number;
  let duration: number;
  if (version === 0 && mvhd.end - mvhd.start >= 20) {
    timescale = u32be(bytes, mvhd.start + 12);
    duration = u32be(bytes, mvhd.start + 16);
    if (duration === 0xffffffff) return null;
  } else if (version === 1 && mvhd.end - mvhd.start >= 32) {
    timescale = u32be(bytes, mvhd.start + 20);
    duration = u64be(bytes, mvhd.start + 24);
    if (duration >= 2 ** 64 - 1) return null;
  } else {
    return null;
  }
  if (timescale === 0 || duration === 0) return null;
  return duration / timescale;
}

/** The payload bounds of the first box of `type` between `from` and `to`, or null. */
function findBox(bytes: Uint8Array, from: number, to: number, type: string): { start: number; end: number } | null {
  let offset = from;
  while (offset + 8 <= to) {
    let size = u32be(bytes, offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return null;
      size = u64be(bytes, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header) return null;
    const end = Math.min(offset + size, to);
    if (ascii(bytes, offset + 4, 4) === type) return { start: offset + header, end };
    offset += size;
  }
  return null;
}

function formatSeconds(seconds: number): string {
  return String(Math.round(seconds * 10) / 10);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i]!);
  return text;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>>
    0
  );
}

function u64be(bytes: Uint8Array, offset: number): number {
  return u32be(bytes, offset) * 2 ** 32 + u32be(bytes, offset + 4);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
  );
}
