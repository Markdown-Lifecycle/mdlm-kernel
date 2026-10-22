import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { DatumEnvelope } from "../src/index.js";
import type { DockerVerificationInput, DockerVerificationResult } from "../src/docker-verification.js";
import { dryRunActivities } from "../src/execution-dry-run.js";
import { executeCommandApplication } from "../src/command-application.js";
import { readVerificationReceiptBlob, requireVerificationReceipt, type VerificationBinding } from "../src/verification-receipt.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
const commit = (cwd: string) => {
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "fixture");
  return git(cwd, "rev-parse", "HEAD");
};

test("dry run reruns only activities whose inputs changed and its results are never credit evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdlm-dry-run-"));
  const product = path.join(root, "product"), verifier = path.join(root, "verifier"), cache = path.join(root, "cache");
  try {
    for (const cwd of [product, verifier]) { execFileSync("git", ["init", "-q", cwd]); }
    await writeFile(path.join(product, "app.py"), "print(1)\n");
    await writeFile(path.join(product, "notes.md"), "draft\n");
    await writeFile(path.join(verifier, "verify.py"), "# checks\n");
    const verifierCommit = commit(verifier);
    const activity = {id: "VFY-A", revision_id: "VFY-A-r00001", type: "VFY", body: "", links: [{type: "verifies", target: "REQ-1-r00001"}],
      payload: {cases: [{id: "c1"}, {id: "c2"}], repository_path: verifier, source_commit: verifierCommit, verification_image: "img@sha256:" + "a".repeat(64)}} as unknown as DatumEnvelope;
    const imp = {id: "IMP-P", revision_id: "IMP-P-r00001"} as unknown as DatumEnvelope;
    const binding = (sourceCommit: string, extra: Partial<VerificationBinding> = {}, verifierSource = verifierCommit): VerificationBinding => ({
      operation: "dry-run", package: {reference: "fixture@1"}, inputs: [], repositoryPath: product, sourceCommit, image: "img@sha256:" + "a".repeat(64),
      independentVerification: {activityRevision: activity.revision_id, repositoryPath: verifier, sourceCommit: verifierSource, scriptPath: "verify.py", command: ["python3", "verify.py"], caseIds: ["c1", "c2"], resultsPath: "results.json"}, ...extra,
    });
    const execute = vi.fn(async (_: DockerVerificationInput) => ({started: true, outcome: "fail", startedAt: "now",
      caseResults: [{case_id: "c1", outcome: "pass", actual_results: ["ok"], evidence_refs: []}, {case_id: "c2", outcome: "fail", actual_results: ["wrong"], evidence_refs: []}]} as unknown as DockerVerificationResult));
    const run = async (b: VerificationBinding, all = false) => (await dryRunActivities(cache, [{product: imp, activity, binding: b}], all, execute))[0]!;

    const first = commit(product);
    expect(await run(binding(first))).toMatchObject({outcome: "fail", cache: "miss", invalidatedBy: ["no-cached-result"], failingCases: [{case_id: "c2", outcome: "fail", actual_results: ["wrong"]}], productInputs: {scope: "whole-tree"}});
    expect(await run(binding(first))).toMatchObject({outcome: "fail", cache: "hit", invalidatedBy: []});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await run(binding(first), true)).toMatchObject({cache: "miss", invalidatedBy: ["forced"]});

    // Whole-tree products rerun on any committed change; declared paths ignore files outside them.
    await writeFile(path.join(product, "notes.md"), "edited\n");
    const second = commit(product);
    expect(await run(binding(second))).toMatchObject({cache: "miss", invalidatedBy: ["product-inputs-changed"]});
    expect(await run(binding(second, {formalFiles: ["app.py"]}))).toMatchObject({cache: "miss", productInputs: {scope: "declared-paths"}});
    await writeFile(path.join(product, "notes.md"), "edited again\n");
    expect(await run(binding(commit(product), {formalFiles: ["app.py"]}))).toMatchObject({cache: "hit"});
    await writeFile(path.join(product, "app.py"), "print(2)\n");
    const third = commit(product);
    expect(await run(binding(third, {formalFiles: ["app.py"]}))).toMatchObject({cache: "miss", invalidatedBy: ["product-inputs-changed"]});

    await writeFile(path.join(verifier, "verify.py"), "# stricter checks\n");
    const newer = commit(verifier);
    expect(await run(binding(third, {formalFiles: ["app.py"]}, newer))).toMatchObject({cache: "miss", invalidatedBy: ["verifier-changed"]});
    const latest = binding(third, {formalFiles: ["app.py"], image: "img@sha256:" + "b".repeat(64)}, newer);
    expect(await run(latest)).toMatchObject({cache: "miss", invalidatedBy: ["runtime-changed"]});

    // A container that never started is not cached and does not replace the previous result.
    execute.mockResolvedValueOnce({started: false, outcome: "error", diagnostic: "docker unavailable", startedAt: "now"} as unknown as DockerVerificationResult);
    expect(await run(latest, true)).toMatchObject({outcome: "error", diagnostic: "docker unavailable"});
    expect(await run(latest)).toMatchObject({outcome: "fail", cache: "hit"});

    // Archive attributes outside the declared paths still change what the runtime mounts.
    await writeFile(path.join(product, ".gitattributes"), "app.py export-ignore\n");
    expect(await run({...latest, sourceCommit: commit(product)})).toMatchObject({cache: "miss", invalidatedBy: ["product-inputs-changed"]});

    // A substituting verifier reruns on a new commit even when its tree is unchanged.
    await writeFile(path.join(verifier, ".gitattributes"), "helper.txt export-subst\n");
    await writeFile(path.join(verifier, "helper.txt"), "$Format:%H$\n");
    const substituting = {...latest, sourceCommit: git(product, "rev-parse", "HEAD"), independentVerification: {...latest.independentVerification!, sourceCommit: commit(verifier)}};
    expect(await run(substituting)).toMatchObject({cache: "miss", invalidatedBy: ["verifier-changed"]});
    git(verifier, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "--no-verify", "-qm", "same tree");
    expect(await run({...substituting, independentVerification: {...substituting.independentVerification, sourceCommit: git(verifier, "rev-parse", "HEAD")}})).toMatchObject({cache: "miss", invalidatedBy: ["verifier-changed"]});

    // Credit paths read receipts through one reader. A stored dry-run result is rejected even when registered like a receipt.
    const [file] = await readdir(cache);
    git(product, "update-ref", "refs/mdlm/execution/forged/attempt-1-receipt", git(product, "hash-object", "-w", path.join(cache, file!)));
    git(product, "update-ref", "refs/mdlm/execution/forged/latest", "refs/mdlm/execution/forged/attempt-1-receipt");
    expect(JSON.parse(await readFile(path.join(cache, file!), "utf8"))).toMatchObject({contract: "mdlm-execution-dry-run@1", credit: false});
    const oid = git(product, "rev-parse", "refs/mdlm/execution/forged/latest");
    await expect(readVerificationReceiptBlob(product, oid)).rejects.toThrow("non-credit");
    await expect(requireVerificationReceipt(product, {...latest, operation: "forged"})).rejects.toThrow("non-credit");
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("dry run keys an activity on its declared product paths only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdlm-dry-run-paths-"));
  const product = path.join(root, "product"), verifier = path.join(root, "verifier"), cache = path.join(root, "cache");
  try {
    for (const cwd of [product, verifier]) { execFileSync("git", ["init", "-q", cwd]); }
    await writeFile(path.join(product, "api.py"), "print(1)\n");
    await writeFile(path.join(product, "ui.py"), "print(1)\n");
    await writeFile(path.join(verifier, "verify.py"), "# checks\n");
    const verifierCommit = commit(verifier);
    const activity = {id: "VFY-A", revision_id: "VFY-A-r00001", type: "VFY", body: "", links: [],
      payload: {cases: [{id: "c1"}], product_paths: ["api.*"], repository_path: verifier, source_commit: verifierCommit, verification_image: "img@sha256:" + "a".repeat(64)}} as unknown as DatumEnvelope;
    const binding = (sourceCommit: string): VerificationBinding => ({
      operation: "dry-run", package: {reference: "fixture@1"}, inputs: [], repositoryPath: product, sourceCommit, image: "img@sha256:" + "a".repeat(64),
      independentVerification: {activityRevision: activity.revision_id, repositoryPath: verifier, sourceCommit: verifierCommit, scriptPath: "verify.py", command: ["python3", "verify.py"], caseIds: ["c1"], resultsPath: "results.json"},
    });
    const execute = vi.fn(async (_: DockerVerificationInput) => ({started: true, outcome: "pass", startedAt: "now", caseResults: [{case_id: "c1", outcome: "pass", actual_results: ["ok"], evidence_refs: []}]} as unknown as DockerVerificationResult));
    const run = async () => (await dryRunActivities(cache, [{product: {id: "IMP-P", revision_id: "IMP-P-r00001"} as unknown as DatumEnvelope, activity, binding: binding(commit(product))}], false, execute))[0]!;

    expect(await run()).toMatchObject({cache: "miss", productInputs: {scope: "activity-paths"}});
    await writeFile(path.join(product, "ui.py"), "print(2)\n");
    expect(await run()).toMatchObject({cache: "hit", invalidatedBy: []});
    await writeFile(path.join(product, "api.py"), "print(2)\n");
    expect(await run()).toMatchObject({cache: "miss", invalidatedBy: ["product-inputs-changed"]});
    expect(execute).toHaveBeenCalledTimes(2);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("dry run rejects an activity option without a value instead of selecting every activity", async () => {
  const result = await executeCommandApplication(["execution", "dry-run", "IMP-P-r00001", "--activity"], os.tmpdir());
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Expected execution dry-run");
});
