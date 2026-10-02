import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client, CloudflareProvider, noul, OpenRouterProvider, RequestError } from "../src/index.js";
import {
  CLEF_MAX_BODY_BYTES,
  CLEF_MAX_DECODED_BYTES,
  CLEF_MAX_IMAGE_BYTES,
  CLEF_MAX_PIXELS,
  inspectImage,
} from "../src/images.js";
import { FakeTransport } from "./helpers.js";

const questions = { urgent: noul("Is this urgent?") };

function png(width = 1, height = 1, bytes = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const header = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from("IHDR"),
    ihdr,
    Buffer.alloc(4),
  ]);
  return bytes <= header.length ? header : Buffer.concat([header, Buffer.alloc(bytes - header.length)]);
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
}

function webp(kind: "VP8X" | "VP8 " | "VP8L", width: number, height: number): Buffer {
  let payload: Buffer;
  if (kind === "VP8X") {
    payload = Buffer.alloc(10);
    payload[4] = (width - 1) & 0xff;
    payload[5] = ((width - 1) >> 8) & 0xff;
    payload[6] = ((width - 1) >> 16) & 0xff;
    payload[7] = (height - 1) & 0xff;
    payload[8] = ((height - 1) >> 8) & 0xff;
    payload[9] = ((height - 1) >> 16) & 0xff;
  } else if (kind === "VP8 ") {
    payload = Buffer.from([
      0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a,
      width & 0xff, (width >> 8) & 0x3f,
      height & 0xff, (height >> 8) & 0x3f,
    ]);
  } else {
    const w = width - 1;
    const h = height - 1;
    payload = Buffer.from([
      0x2f,
      w & 0xff,
      ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
      (h >> 2) & 0xff,
      (h >> 10) & 0x0f,
    ]);
  }
  const chunk = Buffer.concat([
    Buffer.from(kind),
    Buffer.from([payload.length, 0, 0, 0]),
    payload,
  ]);
  const size = 4 + chunk.length;
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff]),
    Buffer.from("WEBP"),
    chunk,
  ]);
}

function bodyOf(images: readonly (string | Uint8Array)[]): Record<string, unknown> {
  const provider = new CloudflareProvider({ apiKey: "k", accountId: "acct" });
  return JSON.parse(provider.requestBody({ model: "clef", state: "x", questions, images })) as Record<string, unknown>;
}

function imageError(images: readonly (string | Uint8Array)[]): string {
  try {
    bodyOf(images);
  } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    return (error as Error).message;
  }
  throw new Error("expected RequestError");
}

describe("Clef image encoding", () => {
  it("embeds PNG, JPEG, and WebP as content_type plus base64", () => {
    const files = [png(), jpeg(2, 3), webp("VP8X", 4, 5), webp("VP8 ", 6, 7)];
    // four is the maximum; VP8L is covered on its own below so this stays at the cap
    const body = bodyOf(files);
    const images = body.images as { content_type: string; base64: string }[];
    expect(images.map((image) => image.content_type)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/webp",
    ]);
    expect(Buffer.from(images[0]!.base64, "base64")).toEqual(files[0]);
    expect(Buffer.from(images[1]!.base64, "base64")).toEqual(files[1]);
    expect(body).toMatchObject({ model: "clef", state: "x" });
  });

  it("reads a lossless WebP", () => {
    const bytes = webp("VP8L", 8, 9);
    const images = bodyOf([bytes]).images as { content_type: string; base64: string }[];
    expect(images[0]!.content_type).toBe("image/webp");
    expect(Buffer.from(images[0]!.base64, "base64")).toEqual(bytes);
  });

  it("reads a local path and a matching data URL", () => {
    const bytes = png();
    const dir = mkdtempSync(join(tmpdir(), "clef-images-"));
    const path = join(dir, "photo.png");
    writeFileSync(path, bytes);
    const fromPath = bodyOf([path]).images as { base64: string }[];
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const fromUrl = bodyOf([dataUrl]).images as { base64: string }[];
    expect(fromPath[0]!.base64).toBe(bytes.toString("base64"));
    expect(fromUrl[0]!.base64).toBe(bytes.toString("base64"));
  });

  it("omits images when none were given", () => {
    const provider = new CloudflareProvider({ apiKey: "k", accountId: "acct" });
    const body = JSON.parse(provider.requestBody({ model: "clef", state: "x", questions })) as Record<string, unknown>;
    expect(body).not.toHaveProperty("images");
  });

  it("rejects a fifth image, a remote URL, a non-image, and a missing file", () => {
    expect(imageError([png(), png(), png(), png(), png()])).toMatch(/at most 4 images/);
    expect(imageError(["https://example.com/a.png"])).toMatch(/remote URLs are not accepted/);
    expect(imageError(["http://example.com/a.jpg"])).toMatch(/remote URLs are not accepted/);
    expect(imageError([Buffer.from("GIF89a")])).toMatch(/must be a PNG, JPEG, or WebP image/);
    expect(imageError(["/tmp/does-not-exist-clef.png"])).toMatch(/could not read file/);
    expect(imageError(["data:image/gif;base64,R0lGODlh"])).toMatch(/data URLs must be base64 PNG, JPEG, or WebP/);
    const mismatch = `data:image/jpeg;base64,${png().toString("base64")}`;
    expect(imageError([mismatch])).toMatch(/says image\/jpeg but the bytes are image\/png/);
  });

  it("does not treat a Windows drive path as a URL", () => {
    expect(imageError(["C:\\photo.png"])).toMatch(/could not read file/);
  });

  it("reads width and height from each header, in that order", () => {
    // Asymmetric sizes catch a swapped or off-by-one field: VP8X and VP8L
    // store size minus one, VP8 stores it directly, JPEG puts height first.
    expect(inspectImage(png(300, 200))).toEqual({ contentType: "image/png", width: 300, height: 200 });
    expect(inspectImage(jpeg(300, 200))).toEqual({ contentType: "image/jpeg", width: 300, height: 200 });
    expect(inspectImage(webp("VP8X", 300, 200))).toEqual({ contentType: "image/webp", width: 300, height: 200 });
    expect(inspectImage(webp("VP8 ", 300, 200))).toEqual({ contentType: "image/webp", width: 300, height: 200 });
    expect(inspectImage(webp("VP8L", 300, 200))).toEqual({ contentType: "image/webp", width: 300, height: 200 });
    // Sizes that need the high bits: 16383 is the 14-bit VP8 and VP8L maximum.
    expect(inspectImage(webp("VP8 ", 16383, 1025))).toMatchObject({ width: 16383, height: 1025 });
    expect(inspectImage(webp("VP8L", 16384, 1025))).toMatchObject({ width: 16384, height: 1025 });
    expect(inspectImage(webp("VP8X", 70000, 1))).toMatchObject({ width: 70000, height: 1 });
    expect(inspectImage(jpeg(65535, 1))).toMatchObject({ width: 65535, height: 1 });
    expect(inspectImage(png(70000, 1))).toMatchObject({ width: 70000, height: 1 });
  });

  it("rejects bytes that are not an image or have a broken header", () => {
    expect(() => inspectImage(Buffer.from("GIF89a"))).toThrow(RequestError);
    expect(() => inspectImage(png().subarray(0, 20))).toThrow(/IHDR/);
    expect(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow(/JPEG dimensions/);
    expect(() => inspectImage(Buffer.from("RIFF\0\0\0\0WEBP"))).toThrow(/WebP dimensions/);
  });

  it("enforces the per-image size and pixel limits", () => {
    expect(bodyOf([png(1, 1, CLEF_MAX_IMAGE_BYTES)]).images).toHaveLength(1);
    expect(imageError([png(1, 1, CLEF_MAX_IMAGE_BYTES + 1)])).toMatch(/4 MiB per-image limit/);
    expect(CLEF_MAX_PIXELS).toBe(16_000_000);
    // 4000×4000 is exactly 16 megapixels; one more row or column is over.
    for (const at of [png(4000, 4000), jpeg(4000, 4000), webp("VP8X", 4000, 4000), webp("VP8 ", 4000, 4000), webp("VP8L", 4000, 4000)]) {
      expect(bodyOf([at]).images).toHaveLength(1);
    }
    for (const over of [png(4000, 4001), png(4001, 4000), jpeg(4000, 4001), webp("VP8X", 4001, 4000), webp("VP8 ", 4000, 4001), webp("VP8L", 4001, 4000)]) {
      expect(imageError([over])).toMatch(/16 megapixel limit/);
    }
  });

  it("enforces the 8 MiB total decoded limit across images", () => {
    const four = png(1, 1, CLEF_MAX_IMAGE_BYTES);
    expect(bodyOf([four, four]).images).toHaveLength(2);
    const three = png(1, 1, 3 * 1024 * 1024);
    expect(imageError([three, three, three])).toMatch(/8 MiB total decoded limit/);
    expect(CLEF_MAX_DECODED_BYTES).toBe(8 * 1024 * 1024);
  });

  it("rejects a request body over 13 MiB", () => {
    const provider = new CloudflareProvider({ apiKey: "k", accountId: "acct" });
    expect(() =>
      provider.requestBody({
        model: "clef",
        state: "x".repeat(CLEF_MAX_BODY_BYTES),
        questions,
      })
    ).toThrow(/13 MiB limit/);
  });

  it("rejects images on providers other than Cloudflare", () => {
    expect(() =>
      new OpenRouterProvider({ apiKey: "k" }).requestBody({
        model: "typesafe/jev-1.13",
        state: "x",
        questions,
        images: [png()],
      })
    ).toThrow(/images are only supported by the cloudflare provider, not open-router/);
  });
});

describe("Client sends Clef images", () => {
  it("posts the embedded image and does not call the network", async () => {
    const transport = new FakeTransport([[200, JSON.stringify({
      success: true,
      result: { model: "clef", answers: { urgent: { type: "noul", noul: 0.5 } } },
    })]]);
    const bytes = jpeg(1, 1);
    const client = new Client({
      provider: new CloudflareProvider({ accountId: "acct" }),
      apiKey: "cf-token",
      transport: transport.call,
    });
    const response = await client.ask({ state: "receipt", questions, images: [bytes] });
    expect(response.answers.urgent.noul).toBe(0.5);
    expect(transport.requests).toHaveLength(1);
    const sent = JSON.parse(transport.requests[0]!.body) as {
      images: { content_type: string; base64: string }[];
    };
    expect(sent.images[0]).toEqual({
      content_type: "image/jpeg",
      base64: bytes.toString("base64"),
    });
    expect(transport.requests[0]!.url).toContain("/@cf/cloudflare/clef");
  });

  it("refuses images for a non-Cloudflare client before sending", async () => {
    const transport = new FakeTransport([]);
    const client = new Client({ apiKey: "k", transport: transport.call });
    await expect(client.ask({ state: "x", questions, images: [png()] })).rejects.toThrow(
      /only supported by the cloudflare provider/
    );
    expect(transport.requests).toHaveLength(0);
  });
});
