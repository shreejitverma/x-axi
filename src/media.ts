import { AxiError } from "axi-sdk-js";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { displayText, shortenPath, usage } from "./args.js";

/**
 * From https://docs.x.com/x-api/media/quickstart/media-upload-chunked and
 * https://docs.x.com/x-api/media/quickstart/best-practices, read 2026-11-01.
 * Each segment at or below 5 MB; the server maximum is 8 MB. Decimal here, so it holds whichever megabyte X means.
 */
export const MEDIA_CHUNK_BYTES = 5_000_000;

const MIB = 1024 * 1024;

interface MediaKind {
  category: "tweet_image" | "tweet_gif" | "tweet_video";
  maxBytes: number;
  extensions: string[];
}

// Video allows the Premium size, because the account's tier is not known locally. X applies the 8 GB default itself.
const KINDS: Record<string, MediaKind> = {
  "image/jpeg": { category: "tweet_image", maxBytes: 5 * MIB, extensions: [".jpg", ".jpeg"] },
  "image/png": { category: "tweet_image", maxBytes: 5 * MIB, extensions: [".png"] },
  "image/webp": { category: "tweet_image", maxBytes: 5 * MIB, extensions: [".webp"] },
  "image/gif": { category: "tweet_gif", maxBytes: 15 * MIB, extensions: [".gif"] },
  "video/mp4": { category: "tweet_video", maxBytes: 16 * 1024 * MIB, extensions: [".mp4", ".m4v"] },
  "video/quicktime": { category: "tweet_video", maxBytes: 16 * 1024 * MIB, extensions: [".mov"] },
  "video/webm": { category: "tweet_video", maxBytes: 16 * 1024 * MIB, extensions: [".webm"] },
};

export interface MediaFile {
  path: string;
  name: string;
  mediaType: string;
  category: MediaKind["category"];
  size: number;
  modifiedAt: number;
}

// ftyp major brands of plain MP4 files, from the MP4 Registration Authority (mp4ra.org). HEIC, AVIF, M4A, and 3GP share the container but are not on it.
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VH", "M4VP", "dash", "MSNV", "XAVC"]);
const EBML_DOCTYPE_ID = Buffer.from([0x42, 0x82]);

/** The EBML header holds the DocType, which separates WebM from other Matroska files. */
function isWebm(header: Buffer): boolean {
  const id = header.indexOf(EBML_DOCTYPE_ID);
  return id !== -1 && header.toString("latin1", id + 3, id + 7) === "webm";
}

/** The file's own bytes decide its type, so a renamed file cannot pass as something else. */
function sniff(header: Buffer): string | undefined {
  const ascii = (start: number, end: number): string => header.toString("latin1", start, end);
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "qt  ") return "video/quicktime";
    return MP4_BRANDS.has(brand) ? "video/mp4" : undefined;
  }
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return isWebm(header) ? "video/webm" : undefined;
  return undefined;
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Checks everything knowable without spending. Video duration is not knowable here, so X judges that. */
export function inspectMedia(path: string): MediaFile {
  const header = Buffer.alloc(64);
  let size: number;
  let modifiedAt: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw usage(`${path} is not a file`);
    size = stat.size;
    modifiedAt = stat.mtimeMs;
    const fd = openSync(path, "r");
    try {
      readSync(fd, header, 0, header.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof AxiError) throw error;
    throw usage(`cannot read ${path}: ${(error as Error).message}`);
  }
  if (size === 0) throw usage(`${path} is empty`);
  const mediaType = sniff(header);
  const kind = mediaType ? KINDS[mediaType] : undefined;
  if (!mediaType || !kind) throw usage(`${path} is not a supported file: expected JPEG, PNG, WebP, GIF, MP4, MOV, or WebM content`);
  if (!kind.extensions.includes(extname(path).toLowerCase())) {
    throw usage(`${path} holds ${mediaType} content, but its extension says otherwise; rename it to ${kind.extensions[0] as string}`);
  }
  if (size > kind.maxBytes) throw usage(`${path} is ${mb(size)}, over X's ${mb(kind.maxBytes)} limit for ${mediaType}`);
  return { path, name: basename(path), mediaType, category: kind.category, size, modifiedAt };
}

export function chunkCount(size: number): number {
  return Math.ceil(size / MEDIA_CHUNK_BYTES);
}

/** The approval dialog and the dry-run output both name the file this way. */
export function describeMedia(media: MediaFile): string {
  return `${shortenPath(displayText(resolve(media.path)))} (${media.mediaType}, ${mb(media.size)})`;
}

/** Yields one reused buffer, so a consumer must copy what it keeps. Refuses a file that changed after approval. */
export function* readChunks(media: MediaFile): Generator<Buffer> {
  const assertUnchanged = (): void => {
    const stat = statSync(media.path);
    if (stat.size !== media.size || stat.mtimeMs !== media.modifiedAt) {
      throw new AxiError(`${media.path} changed after it was approved; nothing was posted`, "VALIDATION_ERROR", ["Run the command again so the dialog shows the current file"]);
    }
  };
  assertUnchanged();
  const fd = openSync(media.path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(MEDIA_CHUNK_BYTES, media.size));
    for (let offset = 0; offset < media.size; offset += MEDIA_CHUNK_BYTES) {
      const want = Math.min(MEDIA_CHUNK_BYTES, media.size - offset);
      const got = readSync(fd, buffer, 0, want, offset);
      if (got !== want) throw new AxiError(`${media.path} changed after it was approved; nothing was posted`, "VALIDATION_ERROR");
      yield buffer.subarray(0, want);
    }
    assertUnchanged();
  } finally {
    closeSync(fd);
  }
}
