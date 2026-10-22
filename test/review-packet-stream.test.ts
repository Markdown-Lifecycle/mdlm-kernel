import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { registerExternalReview, requireExternalReview, reviewPacketDigest } from "../src/external-review.js";
import { jsonChunks, writeJsonFile } from "../src/json-stream.js";
import type { DirectContext } from "../src/direct-contract.js";

const sha256 = (source: string | Buffer) => createHash("sha256").update(source).digest("hex");
const MiB = 1 << 20;
// Long strings straddle chunk boundaries with surrogate pairs and escapes.
const straddle = (offset: number) => `${"x".repeat(offset - 1)}😀"\\\n\u0001${"é".repeat(17)}\ud800`;
const shared = {path: "lib/shared.js", blob: "1".repeat(40), content: "export const shared = \"☃\";\r\n\t// é 😀 \u2028\n".repeat(2000)};

/** Representative packets; vectors below were produced from `main` at 2d2d77f2. */
const packets: Record<string, unknown> = {
  review: {
    contract: "mdlm-direct-review-context@1", snapshot: "sha256:abc", subject: "IMP-0001",
    package: {reference: "mdlm-process-package@2.5.47", digest: "sha256:def", language: "en"},
    action: {id: "implementation-review", version: 3, capability: "review", types: ["REV"], prompt_ref: "prompts/review.md"},
    inputs: {implementation: ["IMP-0001"], requirements: ["RQS-0002"]},
    prompt: {title: "Review", body: "# Review\n\nRead **everything**.\n", steps: ["a", "b"]},
    payloadSchemas: {REV: {type: "object", required: ["outcome"], properties: {outcome: {enum: ["pass", "fail"]}}}},
    sourceAssessmentTargets: undefined,
    records: [{revision_id: "RQS-0002", id: "RQS", revision: 2, type: "RQS", payload: {title: "Ünïcödé", weight: -0.5, big: 1e21, small: 5e-7, zero: -0, flag: false, none: null}, links: [{type: "parent", target: "GRP-1"}], body: "Line\u2028Sep\u0000"}],
    requirementGraphs: [{selection: "RQS-0002", assessment: {ok: true}, groups: [], requirements: []}],
    sourceScopes: [{implementation: "IMP-0001", scopes: [], changes: null, comparison: null}],
    sources: [{implementation: "IMP-0001", repositoryPath: "/repo", sourceCommit: "a".repeat(40), acceptanceScope: "whole-product",
      files: [{path: "src/ä.ts", role: "source", mode: "100644", blob: "2".repeat(40), content: "const s = \"\\u0041\";\n", formal: true}]}],
    verifierSources: [
      {activity: "VFY-a", sourceCommit: "b".repeat(40), files: [shared, {path: "shot.png", blob: "3".repeat(40), content: Buffer.from([0, 137, 80, 78]).toString("base64"), encoding: "base64"}]},
      {activity: "VFY-b", sourceCommit: "c".repeat(40), files: [shared]},
    ],
    verificationReceipts: [],
    zKeyOrder: {b: 1, a: 2, "é": 3, "Z": 4, "10": 5, "2": 6, "😀": 7, "\uffff": 8},
  },
  edges: {empty: {}, list: [], nested: [[[]], [{}]], holes: [1, undefined, null, "x"], undef: undefined, strings: ["", "\"", "\\", "\b\f\n\r\t", "\u007f", "\ud83d", "\ude00"]},
  long: {a: straddle(MiB), b: straddle(64 * 1024), c: [straddle(MiB + 1), straddle(2 * MiB)]},
  authoring: {contract: "mdlm-verification-authoring@1", package: {reference: "p", digest: "d"}, subject: "RQS-1",
    requirements: [{revision_id: "RQ-1", type: "RQ", payload: {statement: "Shall ☃"}, body: "", links: []}], decomposition: [], interfaces: [], instructions: "Author intent only."},
};
const vectors: Record<string, {canonical: string; compact: string; pretty: string}> = {
  review: {canonical: "e91dcba1ab8280f613fda2d4543649099324c22ee62859639851f9dfe6b78501",
    compact: "9b7bc5c3ee51aee9fb1ebdf4af0ab8c6978ca98d6a7b33d141a39694086fd52c",
    pretty: "245e2dcfecf8e777ad2e6761dcebee25009e0318231c6a1c48bca66853c32e19"},
  edges: {canonical: "402eccf4e6013867b310610feb8b565b1bfff7732d5a60b6b4eb022e7896fb46",
    compact: "af638d6fdc17ef3541ed2b28cfbba13ef3e96203a1ed110c85103e4c0da782ee",
    pretty: "f6fa3d0e324863d452691a87852f4ee697a21b90f825f36a8cee46370419a561"},
  long: {canonical: "54615d62a35821ecef64fd9dd22f724744153ce00979322a0bc826fca9e5f670",
    compact: "54615d62a35821ecef64fd9dd22f724744153ce00979322a0bc826fca9e5f670",
    pretty: "9f593a1e0efe0b9e63d145d4cf4140e6fa6d7901970bc5cbf24d5ec632140453"},
  authoring: {canonical: "fd8564fbde2c1a046b0e5fe95aedd5d1c95a408d89fbd258501a754c19ec7096",
    compact: "298cd611f8f3f06153efef9a7a0d5f4ed9603be5f98744f5ed51ca8c09c24934",
    pretty: "f57a267d7938627ea3a53a076dd089c9fc7c58cafd7a6ad7b0677330f0ba4239"},
};

test.each(Object.keys(packets))("%s packet streams the exact bytes main produced", async name => {
  const packet = packets[name], expected = vectors[name]!;
  expect(reviewPacketDigest(packet)).toBe(expected.canonical);
  expect(sha256([...jsonChunks(packet)].join(""))).toBe(expected.compact);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-packet-")), "export.json");
  try {
    const written = await writeJsonFile(file, packet, 2);
    const bytes = await fs.readFile(file);
    expect(sha256(bytes)).toBe(expected.pretty);
    expect(written).toEqual({bytes: bytes.length, sha256: expected.pretty});
  } finally { await fs.rm(path.dirname(file), {recursive: true, force: true}); }
});

test("a failed export removes only the file it created", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-export-failure-"));
  const file = path.join(directory, "export.json"), existing = path.join(directory, "existing.json");
  try {
    const failing = {content: "x".repeat(4 * MiB), later: {toJSON() { throw new Error("serialization failed"); }}};
    await expect(writeJsonFile(file, failing, 2)).rejects.toThrow("serialization failed");
    await expect(fs.stat(file)).rejects.toMatchObject({code: "ENOENT"});
    await fs.writeFile(existing, "keep");
    await expect(writeJsonFile(existing, {}, 2)).rejects.toMatchObject({code: "EEXIST"});
    expect(await fs.readFile(existing, "utf8")).toBe("keep");
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
// Node keeps large decoded strings outside the V8 heap, so count external memory too.
const used = () => { const {heapUsed, external} = process.memoryUsage(); return heapUsed + external; };

// A shared 32 MiB library across 34 verifier commits makes a canonical packet above
// 1 GiB, twice V8's string ceiling, while the review context holds the library once.
test("a review packet above 1 GiB registers with bounded memory when verifier commits share a library", async () => {
  const {installedProcessPackageRoot} = await import("../src/installed-process-package.js");
  const {loadProcessPackage} = await import("../src/index.js");
  const {buildDirectReviewContext} = await import("../src/direct-review-context.js");
  const {canonicalChunks} = await import("../src/json-stream.js");
  const loaded = await loadProcessPackage(installedProcessPackageRoot("iterative"));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-large-review-"));
  const repository = path.join(root, "verifier"), registry = path.join(root, "registry");
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], {encoding: "utf8"}).trim();
  const environment = {registrar: process.env.MDLM_REVIEW_REGISTRAR, registry: process.env.MDLM_REVIEW_REGISTRY};
  try {
    await fs.mkdir(repository);
    await fs.mkdir(registry);
    git("init", "-q");
    await fs.writeFile(path.join(repository, "library.js"), "export const value = 1;\n".repeat(32 * MiB / 24));
    const activities = [];
    for (let index = 0; index < 34; index++) {
      await fs.writeFile(path.join(repository, `check-${index}.js`), `// Check ${index}\n`);
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", `Check ${index}`);
      activities.push({id: `VFY-${index}`, revision: 1, revision_id: `VFY-${index}-r00001`, type: "VFY", payload: {repository_path: repository, source_commit: git("rev-parse", "HEAD")}, links: [], body: "", created_by: {process_ref: "fixture"}});
    }
    const context = {root, pkg: loaded.package, package: {reference: "fixture@1", digest: "fixture", language: "fixture"}, snapshot: "exact", action: loaded.package.actions["review-verification"]!, subject: activities[0]!.revision_id, inputs: {activity: activities.map(d => d.revision_id)}, data: activities} as unknown as DirectContext;
    gc();
    const before = used();
    const reviewed = await buildDirectReviewContext(context);
    expect(reviewed.verifierSources).toHaveLength(34);
    gc();
    expect(used() - before).toBeLessThan(256 * MiB);
    let bytes = 0, peak = 0;
    for (const chunk of canonicalChunks(reviewed)) { bytes += Buffer.byteLength(chunk); peak = Math.max(peak, used()); }
    expect(bytes).toBeGreaterThan(1024 * MiB);
    expect(peak - before).toBeLessThan(256 * MiB);
    process.env.MDLM_REVIEW_REGISTRAR = "1";
    process.env.MDLM_REVIEW_REGISTRY = registry;
    const verdict = JSON.stringify({candidates: []}), proposal = JSON.stringify({candidates: []});
    const registered = await registerExternalReview(repository, "large-review", reviewed, "git-commit:fixture", verdict, proposal);
    expect(registered.contextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await requireExternalReview(repository, "large-review", reviewed, "git-commit:fixture", proposal)).toEqual(registered);
  } finally {
    for (const [key, value] of [["MDLM_REVIEW_REGISTRAR", environment.registrar], ["MDLM_REVIEW_REGISTRY", environment.registry]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, {recursive: true, force: true});
  }
}, 120_000);
