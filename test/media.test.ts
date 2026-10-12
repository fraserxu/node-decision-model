import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Client,
  CloudflareProvider,
  noul,
  OpenRouterProvider,
  RequestError,
  TypesafeProvider,
} from "../src/index.js";
import type { ClientOptions } from "../src/index.js";
import { CLEF_MAX_BODY_BYTES } from "../src/images.js";
import {
  CLEF_OMNI_MAX_AUDIO_BYTES,
  CLEF_OMNI_MAX_MEDIA_BYTES,
  CLEF_OMNI_MAX_VIDEO_BYTES,
  inspectAudio,
  inspectVideo,
} from "../src/media.js";
import { run, type CliIo } from "../src/cli/run.js";
import { FakeTransport, withEnv } from "./helpers.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const RUN_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`;
const NO_ENV = {
  TYPESAFE_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  CLOUDFLARE_AUTH_TOKEN: undefined,
  CLOUDFLARE_ACCOUNT_ID: undefined,
  CELERIS_API_KEY: undefined,
};

const questions = { urgent: noul("Is this urgent?") };

// --- fixtures: the smallest headers each sniffer and duration reader needs ---

function riffChunk(tag: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from(tag), size, payload]);
}

/** 8-bit mono at 8 Hz, so one second of audio is 8 bytes. `pad` adds a JUNK chunk after the data. */
function wav({ seconds = 1, pad = 0 }: { seconds?: number; pad?: number } = {}): Buffer {
  const byteRate = 8;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // channels
  fmt.writeUInt32LE(8, 4); // sample rate
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(1, 12); // block align
  fmt.writeUInt16LE(8, 14); // bits per sample
  const chunks = [riffChunk("fmt ", fmt), riffChunk("data", Buffer.alloc(Math.round(seconds * byteRate)))];
  if (pad > 0) chunks.push(riffChunk("JUNK", Buffer.alloc(pad)));
  const body = Buffer.concat([Buffer.from("WAVE"), ...chunks]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

/** A valid one-second WAV of exactly `total` bytes. */
function wavOfSize(total: number): Buffer {
  const bare = wav();
  const bytes = wav({ pad: total - bare.length - 8 });
  expect(bytes.length).toBe(total);
  return bytes;
}

function mp3WithId3(): Buffer {
  return Buffer.concat([Buffer.from("ID3"), Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(16)]);
}

function mp3Frame(): Buffer {
  // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz.
  return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(32)]);
}

function box(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length);
  return Buffer.concat([size, Buffer.from(type), payload]);
}

function mvhd(seconds: number, version: 0 | 1, timescale = 1000): Buffer {
  const payload = Buffer.alloc(version === 0 ? 100 : 112);
  payload[0] = version;
  const duration = Math.round(seconds * timescale);
  if (version === 0) {
    payload.writeUInt32BE(timescale, 12);
    payload.writeUInt32BE(duration, 16);
  } else {
    payload.writeUInt32BE(timescale, 20);
    payload.writeBigUInt64BE(BigInt(duration), 24);
  }
  return box("mvhd", payload);
}

function mp4({
  seconds = 1,
  version = 0,
  mdatFirst = false,
  pad = 0,
}: { seconds?: number; version?: 0 | 1; mdatFirst?: boolean; pad?: number } = {}): Buffer {
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isom")]));
  const moov = box("moov", Buffer.concat([box("iods", Buffer.alloc(4)), mvhd(seconds, version)]));
  const mdat = box("mdat", Buffer.alloc(40 + pad));
  return Buffer.concat(mdatFirst ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

/** A valid one-second MP4 of exactly `total` bytes. */
function mp4OfSize(total: number): Buffer {
  const bare = mp4();
  const bytes = mp4({ pad: total - bare.length });
  expect(bytes.length).toBe(total);
  return bytes;
}

function webm(): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from([0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]),
    Buffer.from("webm"),
  ]);
}

function onePixelPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from("IHDR"),
    ihdr,
    Buffer.alloc(4),
  ]);
}

const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;

type Media = {
  images?: readonly (string | Uint8Array)[];
  audio?: readonly (string | Uint8Array)[];
  videos?: readonly (string | Uint8Array)[];
};

interface WireBody {
  model: string;
  state: unknown;
  images?: { content_type: string; base64: string }[];
  audio?: string[];
  videos?: string[];
}

function bodyOf(media: Media, model = "clef-omni"): WireBody {
  const provider = new CloudflareProvider({ apiKey: "k", accountId: "acct" });
  return JSON.parse(provider.requestBody({ model, state: "x", questions, ...media })) as WireBody;
}

function mediaError(media: Media, model = "clef-omni"): string {
  try {
    bodyOf(media, model);
  } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    return (error as Error).message;
  }
  throw new Error("expected RequestError");
}

describe("Clef-omni media encoding", () => {
  it("embeds audio and video as data URLs", () => {
    const clips = [wav(), mp3WithId3()];
    const videos = [mp4(), webm()];
    const body = bodyOf({ audio: clips, videos });
    expect(body).toMatchObject({ model: "clef-omni", state: "x" });
    expect(body.audio).toEqual([dataUrl("audio/wav", clips[0]!), dataUrl("audio/mpeg", clips[1]!)]);
    expect(body.videos).toEqual([dataUrl("video/mp4", videos[0]!), dataUrl("video/webm", videos[1]!)]);
    expect(body).not.toHaveProperty("images");
  });

  it("sends images, audio, and video together, images still as objects", () => {
    const png = onePixelPng();
    const body = bodyOf({ images: [png], audio: [mp3Frame()], videos: [mp4()] });
    expect(Object.keys(body)).toEqual(["model", "state", "questions", "images", "audio", "videos"]);
    expect(body.images).toEqual([{ content_type: "image/png", base64: png.toString("base64") }]);
    expect(body.audio![0]).toMatch(/^data:audio\/mpeg;base64,/);
    expect(body.videos![0]).toMatch(/^data:video\/mp4;base64,/);
  });

  it("keeps a text-only body byte-identical, with no empty media arrays", () => {
    const provider = new CloudflareProvider({ apiKey: "k", accountId: "acct" });
    const plain = provider.requestBody({ model: "clef-omni", state: "x", questions });
    expect(plain).toBe(JSON.stringify({ model: "clef-omni", state: "x", questions }));
    expect(provider.requestBody({ model: "clef-omni", state: "x", questions, audio: [], videos: [] })).toBe(plain);
    const withAudio = bodyOf({ audio: [wav()] });
    expect(withAudio).not.toHaveProperty("videos");
    expect(bodyOf({ videos: [webm()] })).not.toHaveProperty("audio");
  });

  it("reads local paths, bytes, and data URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "clef-media-"));
    const files = {
      wav: join(dir, "clip.wav"),
      mp3: join(dir, "clip.mp3"),
      mp4: join(dir, "clip.mp4"),
      webm: join(dir, "clip.webm"),
      noExt: join(dir, "clip"),
    };
    writeFileSync(files.wav, wav());
    writeFileSync(files.mp3, mp3Frame());
    writeFileSync(files.mp4, mp4());
    writeFileSync(files.webm, webm());
    writeFileSync(files.noExt, wav());

    const body = bodyOf({ audio: [files.wav, files.mp3, files.noExt], videos: [files.mp4, files.webm] });
    expect(body.audio).toEqual([dataUrl("audio/wav", wav()), dataUrl("audio/mpeg", mp3Frame()), dataUrl("audio/wav", wav())]);
    expect(body.videos).toEqual([dataUrl("video/mp4", mp4()), dataUrl("video/webm", webm())]);

    // Data URLs round-trip, and the WAV and MP3 synonyms normalize.
    const urls = bodyOf({
      audio: [dataUrl("audio/wav", wav()), dataUrl("audio/x-wav", wav()), dataUrl("audio/mp3", mp3WithId3())],
      videos: [dataUrl("video/webm", webm())],
    });
    expect(urls.audio).toEqual([dataUrl("audio/wav", wav()), dataUrl("audio/wav", wav()), dataUrl("audio/mpeg", mp3WithId3())]);
    expect(urls.videos).toEqual([dataUrl("video/webm", webm())]);
  });

  it("rejects audio and video on clef and clef-flash, naming the fix", () => {
    expect(mediaError({ audio: [wav()] }, "clef")).toBe(
      'audio is only accepted by the clef-omni model, not clef; pass model "clef-omni" (--model clef-omni)'
    );
    expect(mediaError({ videos: [mp4()] }, "clef-flash")).toMatch(
      /videos are only accepted by the clef-omni model, not clef-flash; .*--model clef-omni/
    );
    expect(mediaError({ images: [onePixelPng()], audio: [wav()] }, "clef")).toMatch(/audio is only accepted/);
    // Images alone still work on every model.
    expect(bodyOf({ images: [onePixelPng()] }, "clef").images).toHaveLength(1);
    expect(bodyOf({ images: [onePixelPng()] }, "clef-flash").images).toHaveLength(1);
    expect(bodyOf({ images: [onePixelPng()] }, "clef-omni").images).toHaveLength(1);
  });

  it("rejects audio and video on providers other than Cloudflare", () => {
    const openRouter = new OpenRouterProvider({ apiKey: "k" });
    expect(() => openRouter.requestBody({ model: "typesafe/jev-1.13", state: "x", questions, audio: [wav()] })).toThrow(
      /audio is only supported by the cloudflare provider \(model clef-omni\), not open-router/
    );
    expect(() => openRouter.requestBody({ model: "typesafe/jev-1.13", state: "x", questions, videos: [mp4()] })).toThrow(
      /videos are only supported by the cloudflare provider \(model clef-omni\), not open-router/
    );
    expect(() =>
      new TypesafeProvider({ apiKey: "k" }).requestBody({ model: "jev-latest", state: "x", questions, audio: [wav()] })
    ).toThrow(/not typesafe/);
  });

  it("rejects a fifth clip and a third video", () => {
    expect(bodyOf({ audio: [wav(), wav(), wav(), wav()] }).audio).toHaveLength(4);
    expect(mediaError({ audio: [wav(), wav(), wav(), wav(), wav()] })).toBe("at most 4 audio clips are accepted, got 5");
    expect(bodyOf({ videos: [mp4(), webm()] }).videos).toHaveLength(2);
    expect(mediaError({ videos: [mp4(), mp4(), mp4()] })).toBe("at most 2 videos are accepted, got 3");
  });

  it("rejects remote URLs, missing files, the wrong format, bad data URLs, and a lying extension", () => {
    expect(mediaError({ audio: ["https://example.com/a.wav"] })).toBe(
      "audio 1: remote URLs are not accepted; pass a local WAV or MP3 file"
    );
    expect(mediaError({ videos: ["http://example.com/v.mp4"] })).toMatch(/video 1: remote URLs are not accepted/);
    expect(mediaError({ audio: ["/tmp/does-not-exist-clef.wav"] })).toMatch(
      /^audio "\/tmp\/does-not-exist-clef\.wav": could not read file/
    );
    expect(mediaError({ audio: ["C:\\clip.wav"] })).toMatch(/could not read file/);
    expect(mediaError({ audio: [mp4()] })).toBe("audio 1 must be a WAV or MP3 file");
    expect(mediaError({ audio: [Buffer.from("OggS")] })).toMatch(/must be a WAV or MP3 file/);
    expect(mediaError({ audio: [Buffer.from([0xff, 0xd8, 0xff, 0xe0])] })).toMatch(/must be a WAV or MP3 file/); // a JPEG is not an MPEG frame
    expect(mediaError({ videos: [wav()] })).toBe("video 1 must be an MP4 or WebM file");
    expect(mediaError({ videos: [Buffer.from("FLV\x01")] })).toMatch(/must be an MP4 or WebM file/);

    expect(mediaError({ audio: [dataUrl("audio/ogg", wav())] })).toBe(
      "audio 1: data URLs must be base64 WAV or MP3 (data:audio/wav;base64,...)"
    );
    expect(mediaError({ audio: ["data:audio/wav,notbase64"] })).toMatch(/data URLs must be base64/);
    expect(mediaError({ audio: [dataUrl("audio/mpeg", wav())] })).toBe(
      "audio 1: data URL says audio/mpeg but the bytes are audio/wav"
    );
    expect(mediaError({ audio: [dataUrl("audio/wav", mp4())] })).toMatch(/data URL is not a WAV or MP3 file/);
    expect(mediaError({ videos: [dataUrl("video/mp4", webm())] })).toBe(
      "video 1: data URL says video/mp4 but the bytes are video/webm"
    );
    expect(mediaError({ videos: [dataUrl("video/quicktime", mp4())] })).toMatch(/data:video\/mp4;base64/);

    const dir = mkdtempSync(join(tmpdir(), "clef-media-"));
    const lying = join(dir, "clip.mp3");
    writeFileSync(lying, wav());
    expect(mediaError({ audio: [lying] })).toBe(`audio ${JSON.stringify(lying)} has a .mp3 extension but the bytes are WAV`);
    const lyingVideo = join(dir, "clip.mp4");
    writeFileSync(lyingVideo, webm());
    expect(mediaError({ videos: [lyingVideo] })).toMatch(/has a \.mp4 extension but the bytes are WebM/);
    // An extension the sniffer does not know is not a promise.
    const other = join(dir, "clip.bin");
    writeFileSync(other, mp3WithId3());
    expect(bodyOf({ audio: [other] }).audio![0]).toMatch(/^data:audio\/mpeg;/);
  });

  it("enforces the per-clip and per-video sizes", () => {
    expect(bodyOf({ audio: [wavOfSize(CLEF_OMNI_MAX_AUDIO_BYTES)] }).audio).toHaveLength(1);
    expect(mediaError({ audio: [wavOfSize(CLEF_OMNI_MAX_AUDIO_BYTES + 1)] })).toBe(
      `audio 1 is ${CLEF_OMNI_MAX_AUDIO_BYTES + 1} bytes, over the 8 MiB per-clip limit`
    );
    expect(bodyOf({ videos: [mp4OfSize(CLEF_OMNI_MAX_VIDEO_BYTES)] }).videos).toHaveLength(1);
    expect(mediaError({ videos: [mp4OfSize(CLEF_OMNI_MAX_VIDEO_BYTES + 1)] })).toBe(
      `video 1 is ${CLEF_OMNI_MAX_VIDEO_BYTES + 1} bytes, over the 16 MiB per-video limit`
    );
    expect(CLEF_OMNI_MAX_AUDIO_BYTES).toBe(8 * 1024 * 1024);
    expect(CLEF_OMNI_MAX_VIDEO_BYTES).toBe(16 * 1024 * 1024);
  });

  it("enforces the 16 MiB combined audio and video limit", () => {
    const eight = wavOfSize(CLEF_OMNI_MAX_AUDIO_BYTES);
    expect(bodyOf({ audio: [eight, eight] }).audio).toHaveLength(2);
    expect(mediaError({ audio: [eight, eight], videos: [mp4()] })).toMatch(
      /^audio and video clips are \d+ bytes combined, over the 16 MiB total decoded limit$/
    );
    expect(mediaError({ audio: [wav()], videos: [mp4OfSize(CLEF_OMNI_MAX_VIDEO_BYTES)] })).toMatch(/16 MiB total decoded limit/);
    expect(CLEF_OMNI_MAX_MEDIA_BYTES).toBe(16 * 1024 * 1024);
  });

  it("reads WAV and MP4 durations from their headers", () => {
    expect(inspectAudio(wav({ seconds: 2.5 }))).toEqual({ contentType: "audio/wav", durationSeconds: 2.5 });
    expect(inspectAudio(mp3WithId3())).toEqual({ contentType: "audio/mpeg", durationSeconds: null });
    expect(inspectAudio(mp3Frame()).contentType).toBe("audio/mpeg");
    // A fmt chunk without a data chunk, or a zero byte rate, has no duration to check.
    expect(inspectAudio(wav().subarray(0, 36)).durationSeconds).toBeNull();

    expect(inspectVideo(mp4({ seconds: 12 }))).toEqual({ contentType: "video/mp4", durationSeconds: 12 });
    expect(inspectVideo(mp4({ seconds: 12.5, version: 1 })).durationSeconds).toBe(12.5);
    expect(inspectVideo(mp4({ seconds: 7, mdatFirst: true })).durationSeconds).toBe(7);
    // A fragmented MP4 reports zero: nothing to check locally.
    expect(inspectVideo(mp4({ seconds: 0 })).durationSeconds).toBeNull();
    expect(inspectVideo(webm())).toEqual({ contentType: "video/webm", durationSeconds: null });
    expect(() => inspectAudio(Buffer.from("OggS"))).toThrow(RequestError);
    expect(() => inspectVideo(Buffer.from("FLV"))).toThrow(RequestError);
  });

  it("rejects audio over 300 seconds and video over 60 seconds", () => {
    expect(bodyOf({ audio: [wav({ seconds: 300 })] }).audio).toHaveLength(1);
    expect(mediaError({ audio: [wav({ seconds: 300.125 })] })).toBe(
      "audio 1 is 300.1 seconds long, over the 300 second limit"
    );
    expect(mediaError({ audio: [wav({ seconds: 3600 })] })).toMatch(/is 3600 seconds long/);
    expect(bodyOf({ videos: [mp4({ seconds: 60 })] }).videos).toHaveLength(1);
    expect(mediaError({ videos: [mp4({ seconds: 60.5 })] })).toBe("video 1 is 60.5 seconds long, over the 60 second limit");
    expect(mediaError({ videos: [mp4({ seconds: 61, version: 1 })] })).toMatch(/over the 60 second limit/);
    // MP3 and WebM durations are left to the server.
    expect(bodyOf({ audio: [mp3Frame()], videos: [webm()] }).audio).toHaveLength(1);
  });

  it("does not cap the request body at 13 MiB for clef-omni, but still does for clef", () => {
    const provider = new CloudflareProvider({ apiKey: "k", accountId: "acct" });
    const state = "x".repeat(CLEF_MAX_BODY_BYTES);
    expect(provider.requestBody({ model: "clef-omni", state, questions }).length).toBeGreaterThan(CLEF_MAX_BODY_BYTES);
    expect(() => provider.requestBody({ model: "clef", state, questions })).toThrow(/13 MiB limit/);
    expect(() => provider.requestBody({ model: "clef-flash", state, questions })).toThrow(/13 MiB limit/);
    // Two full clips base64 to well over 13 MiB.
    const eight = wavOfSize(CLEF_OMNI_MAX_AUDIO_BYTES);
    const body = provider.requestBody({ model: "clef-omni", state: "x", questions, audio: [eight, eight] });
    expect(body.length).toBeGreaterThan(CLEF_MAX_BODY_BYTES);
  });
});

describe("Client sends Clef-omni media", () => {
  const envelope = JSON.stringify({
    success: true,
    result: { model: "clef-omni", answers: { urgent: { type: "noul", noul: 0.5 } } },
  });

  function client(transport: FakeTransport, options: Partial<ClientOptions> = {}): Client {
    return new Client({
      provider: new CloudflareProvider({ accountId: ACCOUNT }),
      apiKey: "cf-token",
      transport: transport.call,
      model: "clef-omni",
      ...options,
    });
  }

  it("posts audio and video data URLs to the clef-omni URL", async () => {
    const transport = new FakeTransport([[200, envelope]]);
    const response = await client(transport).ask({
      state: "the unit running",
      questions,
      images: [onePixelPng()],
      audio: [wav()],
      videos: [mp4()],
    });
    expect(response.answers.urgent.noul).toBe(0.5);
    expect(transport.requests[0]!.url).toBe(`${RUN_URL}/@cf/cloudflare/clef-omni`);
    const sent = JSON.parse(transport.requests[0]!.body) as WireBody;
    expect(sent.model).toBe("clef-omni");
    expect(sent.images![0]!.content_type).toBe("image/png");
    expect(sent.audio).toEqual([dataUrl("audio/wav", wav())]);
    expect(sent.videos).toEqual([dataUrl("video/mp4", mp4())]);
  });

  it("refuses media on clef and on other providers before sending", async () => {
    const transport = new FakeTransport([]);
    await expect(client(transport, { model: "clef" }).ask({ state: "x", questions, audio: [wav()] })).rejects.toThrow(
      /audio is only accepted by the clef-omni model, not clef/
    );
    await expect(client(transport, { model: "clef-flash" }).ask({ state: "x", questions, videos: [mp4()] })).rejects.toThrow(
      /videos are only accepted by the clef-omni model, not clef-flash/
    );
    const openRouter = new Client({ apiKey: "k", transport: transport.call });
    await expect(openRouter.ask({ state: "x", questions, audio: [wav()] })).rejects.toThrow(
      /audio is only supported by the cloudflare provider/
    );
    await expect(openRouter.ask({ state: "x", questions, videos: [mp4()] })).rejects.toThrow(RequestError);
    expect(transport.requests).toHaveLength(0);
  });
});

class Io implements CliIo {
  out = "";
  err = "";
  readonly stdout = { write: (chunk: string) => (this.out += chunk), isTTY: false };
  readonly stderr = { write: (chunk: string) => (this.err += chunk) };
  readonly stdin = { piped: false, read: async () => "" };
  readonly env = {};
  readonly clientOptions: ClientOptions;
  now = () => 0;
  constructor(clientOptions: ClientOptions = {}) {
    this.clientOptions = clientOptions;
  }
}

describe("CLI media for Clef-omni", () => {
  const envelope = JSON.stringify({
    success: true,
    result: { model: "clef-omni", answers: { urgent: { type: "noul", noul: 0.9 } } },
  });

  function fixtures(): { png: string; wav: string; mp4: string; webm: string } {
    const dir = mkdtempSync(join(tmpdir(), "clef-omni-cli-"));
    const paths = {
      png: join(dir, "unit.png"),
      wav: join(dir, "running.wav"),
      mp4: join(dir, "fan.mp4"),
      webm: join(dir, "fan.webm"),
    };
    writeFileSync(paths.png, onePixelPng());
    writeFileSync(paths.wav, wav());
    writeFileSync(paths.mp4, mp4());
    writeFileSync(paths.webm, webm());
    return paths;
  }

  it("sends --image, --audio, and --video with --model clef-omni", async () => {
    const paths = fixtures();
    const transport = new FakeTransport([[200, envelope]]);
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const io = new Io({ apiKey: "cf-token", transport: transport.call });
      const code = await run(
        [
          "ask",
          "-s",
          "Review the installation",
          "--noul",
          "urgent=Is anything wrong?",
          "--image",
          paths.png,
          "--audio",
          paths.wav,
          "--video",
          paths.mp4,
          "--video",
          paths.webm,
          "--provider",
          "cloudflare",
          "--model",
          "clef-omni",
          "-q",
        ],
        io
      );
      expect(io.err).toBe("");
      expect(code).toBe(0);
      expect(io.out).toBe("urgent\tyes\n");
    });
    expect(transport.requests[0]!.url).toBe(`${RUN_URL}/@cf/cloudflare/clef-omni`);
    const sent = JSON.parse(transport.requests[0]!.body) as WireBody;
    expect(sent.state).toBe("Review the installation");
    expect(sent.images![0]!.content_type).toBe("image/png");
    expect(sent.audio).toEqual([dataUrl("audio/wav", wav())]);
    expect(sent.videos).toEqual([dataUrl("video/mp4", mp4()), dataUrl("video/webm", webm())]);
  });

  it("accepts the full Workers AI id and shows the data URLs in a dry run", async () => {
    const paths = fixtures();
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const io = new Io();
      const code = await run(
        ["yesno", "Is the fan rattling?", "--audio", paths.wav, "--video", paths.mp4, "--provider", "cloudflare", "--model", "@cf/cloudflare/clef-omni", "--dry-run"],
        io
      );
      expect(io.err).toBe("");
      expect(code).toBe(0);
      const printed = JSON.parse(io.out) as { model: string; url: string; request: WireBody };
      expect(printed.model).toBe("clef-omni");
      expect(printed.url).toBe(`${RUN_URL}/@cf/cloudflare/clef-omni`);
      expect(printed.request.model).toBe("clef-omni");
      expect(printed.request.audio![0]).toMatch(/^data:audio\/wav;base64,/);
      expect(printed.request.videos![0]).toMatch(/^data:video\/mp4;base64,/);
    });
  });

  it("rejects --audio and --video without --model clef-omni, pointing at the flag", async () => {
    const paths = fixtures();
    const transport = new FakeTransport([]);
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const io = new Io({ apiKey: "cf-token", transport: transport.call });
      expect(await run(["yesno", "Q?", "--audio", paths.wav, "--provider", "cloudflare"], io)).toBe(2);
      expect(io.err).toMatch(/^decision-model: audio is only accepted by the clef-omni model, not clef;/);
      expect(io.err).toMatch(/\n {2}Pass --model clef-omni\./);

      const flash = new Io();
      expect(
        await run(["yesno", "Q?", "--video", paths.mp4, "--provider", "cloudflare", "--model", "clef-flash", "--dry-run"], flash)
      ).toBe(2);
      expect(flash.err).toMatch(/videos are only accepted by the clef-omni model, not clef-flash/);
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects media for other providers and unreadable or oversized files as usage errors", async () => {
    const paths = fixtures();
    await withEnv(NO_ENV, async () => {
      const other = new Io();
      expect(await run(["yesno", "Q?", "--video", paths.mp4, "--dry-run"], other)).toBe(2);
      expect(other.err).toMatch(/videos are only supported by the cloudflare provider \(model clef-omni\), not open-router/);
      expect(other.err).toMatch(/--audio unit\.wav --video fan\.mp4 --provider cloudflare --model clef-omni/);
    });
    await withEnv({ ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, async () => {
      const missing = new Io();
      expect(
        await run(["yesno", "Q?", "--audio", "/tmp/does-not-exist-clef-omni.wav", "--provider", "cloudflare", "--model", "clef-omni", "--dry-run"], missing)
      ).toBe(2);
      expect(missing.err).toMatch(/could not read file/);
      expect(missing.err).toMatch(/Pass a local WAV or MP3 file to --audio/);

      const wrong = new Io();
      expect(
        await run(["yesno", "Q?", "--audio", paths.mp4, "--provider", "cloudflare", "--model", "clef-omni", "--dry-run"], wrong)
      ).toBe(2);
      expect(wrong.err).toMatch(/must be a WAV or MP3 file/);

      const remote = new Io();
      expect(
        await run(["yesno", "Q?", "--video", "https://example.com/v.mp4", "--provider", "cloudflare", "--model", "clef-omni", "--dry-run"], remote)
      ).toBe(2);
      expect(remote.err).toMatch(/remote URLs are not accepted/);
    });
  });
});
