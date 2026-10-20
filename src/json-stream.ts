import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { once } from "node:events";

/** Long strings are escaped in slices and small tokens batched to about this many characters. */
const CHUNK = 1 << 20;

const container = (value: unknown): value is object => value !== null && typeof value === "object";

/** `JSON.stringify(value)` in slices that never split a surrogate pair, so no slice nears V8's string limit. */
function* stringTokens(value: string): Generator<string> {
  if (value.length <= CHUNK) return yield JSON.stringify(value);
  yield "\"";
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + CHUNK, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield "\"";
}

/** Tokens of `JSON.stringify(value, null, indent)`; yields nothing where JSON.stringify returns undefined. */
function* stringifyTokens(input: unknown, indent: string, key = "", prefix = ""): Generator<string> {
  let value = input;
  if (container(value) && typeof (value as {toJSON?: unknown}).toJSON === "function") value = (value as {toJSON(key: string): unknown}).toJSON(key);
  if (typeof value === "string") return yield* stringTokens(value);
  if (!container(value) || value instanceof Number || value instanceof String || value instanceof Boolean) {
    const leaf = JSON.stringify(value);
    if (leaf !== undefined) yield leaf;
    return;
  }
  const inner = indent ? `\n${prefix}${indent}` : "", close = indent ? `\n${prefix}` : "";
  if (Array.isArray(value)) {
    if (!value.length) return yield "[]";
    for (let index = 0; index < value.length; index++) {
      yield index ? `,${inner}` : `[${inner}`;
      let empty = true;
      for (const token of stringifyTokens(value[index], indent, String(index), prefix + indent)) { empty = false; yield token; }
      if (empty) yield "null";
    }
    return yield `${close}]`;
  }
  let first = true;
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
    yield `${first ? "{" : ","}${inner}${JSON.stringify(name)}:${indent ? " " : ""}`;
    first = false;
    yield* stringifyTokens(item, indent, name, prefix + indent);
  }
  yield first ? "{}" : `${close}}`;
}

/** Tokens of the canonical review packet: sorted keys and no toJSON, keeping its historical forms exactly. */
function* canonicalTokens(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      const item = value[index];
      // Array.join rendered an unserializable element as empty.
      if (container(item) || typeof item === "string") yield* canonicalTokens(item);
      else yield JSON.stringify(item) ?? "";
    }
    yield "]";
  } else if (container(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    yield "{";
    for (const [index, [key, item]] of entries.entries()) {
      yield `${index ? "," : ""}${JSON.stringify(key)}:`;
      yield* canonicalTokens(item);
    }
    yield "}";
  } else if (typeof value === "string") yield* stringTokens(value);
  // A template literal rendered an unserializable member as "undefined".
  else yield String(JSON.stringify(value));
}

function* batched(tokens: Iterable<string>): Generator<string> {
  let pending: string[] = [], size = 0;
  for (const token of tokens) {
    pending.push(token);
    size += token.length;
    if (size >= CHUNK) { yield pending.join(""); pending = []; size = 0; }
  }
  if (pending.length) yield pending.join("");
}

const digest = (chunks: Iterable<string>): string => {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
};

/** Chunks of `JSON.stringify(value, null, indent)`, produced lazily. */
export const jsonChunks = (value: unknown, indent = 0): Generator<string> => batched(stringifyTokens(value, " ".repeat(indent)));
/** Chunks of the canonical review packet, produced lazily. */
export const canonicalChunks = (value: unknown): Generator<string> => batched(canonicalTokens(value));
/** SHA-256 of `JSON.stringify(value)`. */
export const jsonDigest = (value: unknown): string => digest(jsonChunks(value));
/** SHA-256 of the canonical review packet. */
export const canonicalDigest = (value: unknown): string => digest(canonicalChunks(value));

/** Write `${JSON.stringify(value, null, indent)}\n` to a new file without building it as one string. */
export async function writeJsonFile(file: string, value: unknown, indent: number): Promise<{bytes: number; sha256: string}> {
  const stream = createWriteStream(file, {flags: "wx"}), hash = createHash("sha256");
  let bytes = 0;
  try {
    await once(stream, "open");
    const write = async (chunk: string) => {
      const buffer = Buffer.from(chunk, "utf8");
      hash.update(buffer);
      bytes += buffer.length;
      // once() also rejects on a stream error.
      if (!stream.write(buffer)) await once(stream, "drain");
    };
    for (const chunk of jsonChunks(value, indent)) await write(chunk);
    await write("\n");
    stream.end();
    await once(stream, "finish");
    return {bytes, sha256: hash.digest("hex")};
  } catch (error) {
    stream.destroy();
    // Only a stream that opened created this file; never remove an existing one.
    if (stream.pending === false) await fs.rm(file, {force: true});
    throw error;
  }
}
