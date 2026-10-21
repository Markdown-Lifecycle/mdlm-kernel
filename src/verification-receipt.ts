import { execFile, spawn } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { executeDockerVerification, authenticateVerificationSource, authenticateProductSource, type DockerVerificationResult, type IndependentVerification } from "./docker-verification.js";
import { recaptureVerificationReport, verificationReportOutcome } from "./independent-verification-execution.js";
import { repositoryGitEnvironment } from "./git-environment.js";

const exec = promisify(execFile);
export interface VerificationBinding {
  operation: string;
  package: unknown;
  inputs: unknown;
  repositoryPath: string;
  sourceCommit: string;
  image: string;
  command?: string[];
  scriptPath?: string;
  independentVerification?: IndependentVerification;
  formalFiles?: string[];
}
/** Dry-run results are readiness checks, never receipts; credit paths reject this contract. */
export const DRY_RUN_CONTRACT = "mdlm-execution-dry-run@1";
export const verificationRef = (binding: VerificationBinding) => `refs/mdlm/execution/${binding.operation}`;
async function git(root: string, args: string[]) {
  return (await exec("git", ["-C", root, ...args], {env: repositoryGitEnvironment(), maxBuffer: 64 * 1024 * 1024})).stdout.trim();
}
export async function readVerificationReceiptBlob(root: string, oid: string) {
  if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error("Verification receipt must name an exact Git blob");
  const source = await git(root, ["cat-file", "blob", oid]);
  const receipt = JSON.parse(source) as {binding: VerificationBinding; attempt: number; result?: Awaited<ReturnType<typeof executeDockerVerification>>; state: string; contract?: unknown};
  // Every credit path reads receipts here; a stored dry-run result is never evidence.
  if (receipt?.contract === DRY_RUN_CONTRACT) throw new Error("Dry-run results are non-credit readiness checks and cannot be used as execution evidence");
  return {oid, receipt};
}
/** Read many blobs' bytes with one Git process. Missing or non-blob objects are omitted; callers parse in their own order. */
export async function readGitBlobs(root: string, oids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(oids)];
  const blobs = new Map<string, string>();
  if (!unique.length) return blobs;
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", root, "cat-file", "--batch"], {env: repositoryGitEnvironment(), stdio: ["pipe", "pipe", "pipe"]});
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git cat-file failed: ${Buffer.concat(errors).toString("utf8").trim()}`)));
    child.stdin.end(unique.map(oid => `${oid}\n`).join(""));
  });
  let offset = 0;
  for (const oid of unique) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString("utf8").split(" ");
    offset = end + 1;
    if (header.length !== 3) continue;
    const size = Number(header[2]);
    if (header[0] === oid && header[1] === "blob") blobs.set(oid, output.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return blobs;
}
export async function readBoundVerificationReceipt(root: string, binding: VerificationBinding) {
  const oid = await git(root, ["rev-parse", "--verify", "--quiet", `${verificationRef(binding)}/latest`]).catch(error => { if (error.code === 1) return undefined; throw error; });
  return oid ? readVerificationReceiptBlob(root, oid) : undefined;
}
export async function runVerificationReceipt(root: string, binding: VerificationBinding, retry: boolean) {
  const previous = await readBoundVerificationReceipt(root, binding);
  if (previous) {
    if (!isDeepStrictEqual(previous.receipt.binding, binding)) throw new Error("Verification receipt inputs do not match this execution identity");
    if (previous.receipt.result && (!retry || previous.receipt.result.started)) return previous;
    if (!retry) throw new Error("Previous verification attempt did not complete. Inspect settlement; execution must not be replayed automatically.");
  }
  const attempt = (previous?.receipt.attempt ?? 0) + 1;
  const persist = async (receipt: object, expected: string) => {
    const directory = path.join(root, ".lifecycle/work", "execution", binding.operation);
    await fs.mkdir(directory, {recursive: true});
    const file = path.join(directory, `${attempt}-${"result" in receipt ? "receipt" : "started"}.json`);
    await fs.writeFile(file, JSON.stringify(receipt, null, 2) + "\n", {flag: "wx"});
    const oid = await git(root, ["hash-object", "-w", file]);
    await git(root, ["update-ref", `${verificationRef(binding)}/attempt-${attempt}-${"result" in receipt ? "receipt" : "started"}`, oid, "0".repeat(40)]);
    await git(root, ["update-ref", `${verificationRef(binding)}/latest`, oid, expected]);
    return oid;
  };
  // The attempt marker is durable before Docker starts. An interrupted process cannot silently rerun it.
  const started = await persist({binding, attempt, state: "started"}, previous?.oid ?? "0".repeat(40));
  const result = await executeDockerVerification(binding);
  const receipt = {binding, attempt, state: "completed", result};
  const oid = await persist(receipt, started);
  return {oid, receipt};
}
export async function requireVerificationReceipt(root: string, binding: VerificationBinding, receiptOid?: string) {
  const saved = receiptOid === undefined ? await readBoundVerificationReceipt(root, binding) : await readVerificationReceiptBlob(root, receiptOid);
  return validateVerificationReceipt(binding, saved);
}

/** Authenticate an already selected receipt, independently of authoring orchestration. */
export async function validateVerificationReceipt(binding: VerificationBinding, saved: Awaited<ReturnType<typeof readVerificationReceiptBlob>> | undefined) {
  if (saved?.receipt.state !== "completed" || !saved.receipt.result || !isDeepStrictEqual(saved.receipt.binding, binding)) throw new Error("A completed receipt for this exact execution is required before publishing verification");
  const result = saved.receipt.result;
  const current = result.sourceTree !== null && result.scriptSha256 !== null
    ? binding.independentVerification ? await authenticateProductSource(binding) : await authenticateVerificationSource(binding) : {};
  if (binding.independentVerification && result.independentVerification) {
    const verifier = await authenticateVerificationSource(binding.independentVerification);
    if (!isDeepStrictEqual({...verifier, activityRevision: binding.independentVerification.activityRevision}, result.independentVerification)) throw new Error("Independent verification source binding changed.");
  }
  // Source authentication returns the same immutable fields recorded by the executor.
  for (const [key, value] of Object.entries(current)) {
    if (key in result && !isDeepStrictEqual((result as unknown as Record<string, unknown>)[key], value)) throw new Error(`Verification source binding changed: ${key}`);
  }
  return {outcome: result.outcome, receipt: `git-blob:${saved.oid}`, saved, ...(binding.independentVerification ? {caseResults: result.caseResults ?? [], artifacts: result.artifacts ?? []} : {})};
}

/** A fresh pass or fail must be the outcome its own saved execution derives; stored summaries are not trusted. */
export async function requireCoherentVerificationResult(binding: VerificationBinding, result: DockerVerificationResult) {
  if (result.outcome === "error") return;
  const refuse = (field: string): never => { throw new Error(`Verification receipt ${field} contradicts its ${result.outcome} outcome`); };
  if (result.started !== true || result.phase !== "execution" || !Number.isInteger(result.exitCode)) refuse("start state");
  // Null source identities would skip source authentication in validateVerificationReceipt.
  if (result.sourceTree === null || result.scriptSha256 === null) refuse("source identity");
  if (result.image !== binding.image || !/^sha256:[a-f0-9]{64}$/.test(String(result.imageId))
    || (/^sha256:[a-f0-9]{64}$/.test(binding.image) && result.imageId !== binding.image)) refuse("imageId");
  const independent = binding.independentVerification;
  if (!independent) {
    if (result.outcome !== (result.exitCode === 0 ? "pass" : result.exitCode === 1 ? "fail" : "error")) refuse("exit code");
    return;
  }
  // The executor records the verifier script digest at top level; the nested copy is source-authenticated.
  if (!result.independentVerification || result.scriptSha256 !== result.independentVerification.scriptSha256) refuse("scriptSha256");
  const report = await recaptureVerificationReport(independent, result);
  if (report.diagnostic) refuse("report");
  if (!isDeepStrictEqual(report.caseResults, result.caseResults ?? [])) refuse("case results");
  if (!isDeepStrictEqual(report.artifacts, result.artifacts ?? [])) refuse("artifacts");
  if (verificationReportOutcome(report, result.exitCode).outcome !== result.outcome) refuse("case outcomes and exit code");
}
