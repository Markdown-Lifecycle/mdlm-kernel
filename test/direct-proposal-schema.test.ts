import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

// Stand-ins for the expensive authority/evidence checks: the schema refusal must arrive first.
const expensive = vi.hoisted(() => ({authority: vi.fn(async () => { throw new Error("expensive authority check ran"); }), historical: vi.fn()}));
vi.mock("../src/direct-authority.js", async original => ({...await original<typeof import("../src/direct-authority.js")>(), validateDirectAuthority: expensive.authority}));
vi.mock("../src/verification-applicability.js", async original => {
  const actual = await original<typeof import("../src/verification-applicability.js")>();
  return {...actual, validateCurrentHistoricalResults: expensive.historical.mockImplementation(actual.validateCurrentHistoricalResults)};
});
const {draftDirectProposal, submitDirectProposal} = await import("../src/direct-proposal.js");
const {initializeBundledRepository} = await import("../src/repository-initialization.js");
const {installedProcessPackageRoot} = await import("../src/installed-process-package.js");
const {loadProcessPackage, resolveType} = await import("../src/index.js");
const {authorablePayloadSchema} = await import("../src/direct-guidance.js");
const {payloadSchemaDiagnostics} = await import("../src/lifecycle-repository.js");

test("a payload missing an inherited required field is refused before expensive evidence checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdlm-schema-first-"));
  try {
    const repository = path.join(root, "lifecycle");
    expect((await initializeBundledRepository(repository, "tiny")).ok).toBe(true);
    const draft = await draftDirectProposal(repository, "draft-requirements@1", undefined, "schema-first-1");
    await expect(submitDirectProposal(repository, JSON.stringify(draft))).rejects.toThrow(/"code":"datum-payload","path":"outputs\[0\]\.payload\/title"/);
    expect(expensive.authority).not.toHaveBeenCalled();
    expect(expensive.historical).not.toHaveBeenCalled();
    const [requirement, group] = draft.candidates;
    requirement!.payload = {...requirement!.payload, title: "Count words", kind: "software", ears: {pattern: "ubiquitous", system: "The counter", response: "print the word count"}};
    group!.payload.title = "Word counting";
    await expect(submitDirectProposal(repository, JSON.stringify(draft))).rejects.toThrow("expensive authority check ran");
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("the early check sees the inherited ACC title the type file does not list", async () => {
  const loaded = await loadProcessPackage(installedProcessPackageRoot("iterative"));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  const resolved = resolveType(loaded.package, "ACC");
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  expect(payloadSchemaDiagnostics(authorablePayloadSchema(resolved.type), {publication: "recorded"}, "payload"))
    .toContainEqual(expect.objectContaining({code: "datum-payload", path: "payload/title"}));
});
