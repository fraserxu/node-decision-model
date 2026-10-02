import { readFileSync } from "node:fs";
import { RequestError } from "./errors.js";

/** A local image path, raw PNG/JPEG/WebP bytes, or a base64 data URL. */
export type ImageSource = string | Uint8Array;

export interface ClefWireImage {
  content_type: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

/** Documented Clef image limits. https://developers.cloudflare.com/workers-ai/models/clef/ */
export const CLEF_MAX_IMAGES = 4;
export const CLEF_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const CLEF_MAX_PIXELS = 16_000_000;
/** Sum of the image file bytes (the bytes base64 decodes back to), not the pixel buffer. */
export const CLEF_MAX_DECODED_BYTES = 8 * 1024 * 1024;
export const CLEF_MAX_BODY_BYTES = 13 * 1024 * 1024;

const PNG = "image/png";
const JPEG = "image/jpeg";
const WEBP = "image/webp";

type MediaType = ClefWireImage["content_type"];

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]*)$/i;

/**
 * Turns local images into the Clef `images` array: `{ content_type, base64 }`.
 * Remote URLs are rejected. Limits are the documented ones: 4 images, 4 MiB
 * and 16 megapixels each, 8 MiB of image bytes in total.
 */
export function encodeClefImages(sources: readonly ImageSource[]): ClefWireImage[] {
  if (sources.length > CLEF_MAX_IMAGES) {
    throw new RequestError(`at most ${CLEF_MAX_IMAGES} images are accepted, got ${sources.length}`);
  }

  const encoded: ClefWireImage[] = [];
  let decoded = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    const { bytes, label } = loadImage(source, index);
    if (bytes.length > CLEF_MAX_IMAGE_BYTES) {
      throw new RequestError(
        `${label} is ${bytes.length} bytes, over the 4 MiB per-image limit`
      );
    }
    const { contentType, width, height } = inspectImage(bytes, label);
    const pixels = width * height;
    if (pixels > CLEF_MAX_PIXELS) {
      throw new RequestError(
        `${label} is ${width}×${height} (${pixels} pixels), over the 16 megapixel limit`
      );
    }
    decoded += bytes.length;
    if (decoded > CLEF_MAX_DECODED_BYTES) {
      throw new RequestError(
        `images are ${decoded} bytes combined, over the 8 MiB total decoded limit`
      );
    }
    encoded.push({ content_type: contentType, base64: Buffer.from(bytes).toString("base64") });
  }
  return encoded;
}

export interface ImageInfo {
  contentType: MediaType;
  width: number;
  height: number;
}

/**
 * The content type and pixel size of PNG, JPEG, or WebP bytes, read from the
 * headers without decoding the image. Throws RequestError for anything else.
 */
export function inspectImage(bytes: Uint8Array, label = "image"): ImageInfo {
  const contentType = sniff(bytes);
  if (contentType === null) {
    throw new RequestError(`${label} must be a PNG, JPEG, or WebP image`);
  }
  const { width, height } = dimensions(bytes, contentType, label);
  if (width < 1 || height < 1) {
    throw new RequestError(`${label} has invalid dimensions ${width}×${height}`);
  }
  return { contentType, width, height };
}

/** The whole Workers AI request body, images included, must stay within 13 MiB. */
export function assertClefBodySize(body: string): void {
  const bytes = Buffer.byteLength(body);
  if (bytes > CLEF_MAX_BODY_BYTES) {
    throw new RequestError(`request body is ${bytes} bytes, over the 13 MiB limit`);
  }
}

function loadImage(source: ImageSource, index: number): { bytes: Uint8Array; label: string } {
  if (typeof source !== "string") {
    return { bytes: source, label: `image ${index + 1}` };
  }

  const trimmed = source.trim();
  if (trimmed.toLowerCase().startsWith("data:")) {
    return { bytes: bytesFromDataUrl(trimmed, index), label: `image ${index + 1}` };
  }
  if (isRemoteUrl(trimmed)) {
    throw new RequestError(
      `image ${index + 1}: remote URLs are not accepted; pass a local PNG, JPEG, or WebP file`
    );
  }

  const label = JSON.stringify(source);
  try {
    return { bytes: readFileSync(source), label };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RequestError(`${label}: could not read file: ${message}`);
  }
}

function isRemoteUrl(value: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (match === null) return false;
  // A single letter is a Windows drive (`C:\photo.jpg`), not a URL scheme.
  return match[1]!.length > 1;
}

function bytesFromDataUrl(value: string, index: number): Uint8Array {
  const match = DATA_URL.exec(value);
  if (match === null) {
    throw new RequestError(
      `image ${index + 1}: data URLs must be base64 PNG, JPEG, or WebP (data:image/png;base64,...)`
    );
  }
  const declared = match[1]!.toLowerCase() as MediaType;
  const bytes = Buffer.from(match[2]!.replace(/\s+/g, ""), "base64");
  const actual = sniff(bytes);
  if (actual === null) {
    throw new RequestError(`image ${index + 1}: data URL is not a PNG, JPEG, or WebP image`);
  }
  if (actual !== declared) {
    throw new RequestError(`image ${index + 1}: data URL says ${declared} but the bytes are ${actual}`);
  }
  return bytes;
}

function sniff(bytes: Uint8Array): MediaType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return PNG;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return JPEG;
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return WEBP;
  }
  return null;
}

function dimensions(bytes: Uint8Array, mediaType: MediaType, label: string): { width: number; height: number } {
  try {
    switch (mediaType) {
      case PNG:
        return pngSize(bytes);
      case JPEG:
        return jpegSize(bytes);
      case WEBP:
        return webpSize(bytes);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RequestError(`${label}: ${message}`);
  }
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") {
    throw new RequestError("PNG is missing an IHDR chunk");
  }
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset]!;
    offset += 1;
    // Standalone markers carry no length: SOI, EOI, RSTn, TEM.
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= bytes.length) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) {
      throw new RequestError("JPEG marker is truncated");
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 7) throw new RequestError("JPEG frame header is truncated");
      return { height: u16be(bytes, offset + 3), width: u16be(bytes, offset + 5) };
    }
    offset += length;
  }
  throw new RequestError("could not read JPEG dimensions");
}

function webpSize(bytes: Uint8Array): { width: number; height: number } {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = ascii(bytes, offset, 4);
    const size = u32le(bytes, offset + 4);
    const data = offset + 8;
    if (data > bytes.length || size > bytes.length - data) break;

    if (tag === "VP8X" && size >= 10) {
      return {
        width: 1 + (bytes[data + 4]! | (bytes[data + 5]! << 8) | (bytes[data + 6]! << 16)),
        height: 1 + (bytes[data + 7]! | (bytes[data + 8]! << 8) | (bytes[data + 9]! << 16)),
      };
    }
    if (tag === "VP8 " && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      return {
        width: (bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff,
        height: (bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff,
      };
    }
    if (tag === "VP8L" && size >= 5 && bytes[data] === 0x2f) {
      const b1 = bytes[data + 1]!;
      const b2 = bytes[data + 2]!;
      const b3 = bytes[data + 3]!;
      const b4 = bytes[data + 4]!;
      return {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + (((b2 & 0xc0) >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    }

    const padded = size + (size & 1);
    offset = data + padded;
  }
  throw new RequestError("could not read WebP dimensions");
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i]!);
  return text;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>>
    0
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
  );
}
