import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureVerificationReport, validateIndependentVerification, verificationReportOutcome,
  type IndependentVerification, type VerificationArtifact, type VerificationCaseResult } from "./independent-verification-execution.js";
import type { SecretFinding } from "./secret-scan.js";
export type { IndependentVerification, VerificationArtifact, VerificationCaseResult } from "./independent-verification-execution.js";

export interface DockerVerificationInput {
  repositoryPath: string;
  sourceCommit: string;
  image: string;
  command?: string[];
  scriptPath?: string;
  independentVerification?: IndependentVerification;
  timeoutMs?: number;
  formalFiles?: string[];
}

export interface VerificationSourceIdentity {
  sourceCommit: string;
  sourceTree: string;
  scriptSha256: string;
}

export interface DockerVerificationResult {
  sourceCommit: string;
  sourceTree: string | null;
  scriptSha256: string | null;
  image: string;
  imageDigest: string | null;
  imageId: string | null;
  command: string[];
  scriptPath: string;
  stdoutBase64: string;
  stderrBase64: string;
  exitCode: number | null;
  outcome: "pass" | "fail" | "error";
  started: boolean;
  phase: "source" | "environment" | "execution";
  diagnostic?: string;
  startedAt: string;
  finishedAt: string;
  independentVerification?: VerificationSourceIdentity & {activityRevision: string};
  caseResults?: VerificationCaseResult[];
  artifacts?: VerificationArtifact[];
  rawReportBase64?: string;
  /** Present only on a result refused by the secret-pattern scan. */
  secretFindings?: SecretFinding[];
}

export interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  problem?: string;
}

// Docker control messages are never substituted for the verification script's
// streams. This helper also bounds a script that hangs or emits endless output.
export function execute(file: string, args: string[], timeoutMs: number, options: {env?: NodeJS.ProcessEnv; cwd?: string} = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let problem: string | undefined;
    const stop = (reason: string): void => {
      problem ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("Execution timed out."), timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) stop("Execution output exceeded 16 MiB; capture is incomplete.");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => { problem ??= error.message; });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (signal) problem ??= `Execution terminated by ${signal}.`;
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode,
        ...(problem === undefined ? {} : { problem }) });
    });
  });
}

export async function checked(file: string, args: string[], timeoutMs = 30_000): Promise<Buffer> {
  const result = await execute(file, args, timeoutMs);
  if (result.problem || result.exitCode !== 0) {
    throw new Error(result.problem ?? `${file} failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout;
}

/** Committed source archives have their own limit, separate from captured script output. */
export const SOURCE_ARCHIVE_LIMIT = 16 * 1024 * 1024;

// Count the whole archive so an oversized source reports its actual size.
export function archiveSource(repositoryPath: string, sourceCommit: string, label: string, timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repositoryPath, "archive", "--format=tar", sourceCommit], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let problem: string | undefined;
    const timer = setTimeout(() => { problem ??= `${label} source archive timed out.`; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= SOURCE_ARCHIVE_LIMIT) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 64) stderr.push(chunk); });
    child.on("error", (error) => { problem ??= error.message; });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (signal) problem ??= `${label} source archive terminated by ${signal}.`;
      if (!problem && exitCode !== 0) problem = `git archive failed: ${Buffer.concat(stderr).toString("utf8").trim()}`;
      if (problem) reject(new Error(problem));
      else if (size > SOURCE_ARCHIVE_LIMIT) reject(new Error(`${label} source archive for commit ${sourceCommit} is ${size} bytes, over the ${SOURCE_ARCHIVE_LIMIT}-byte (16 MiB) source limit.`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** Reject verifier commits that execution or review export cannot use. */
export async function checkVerifierSource(input: {repositoryPath: string; sourceCommit: string}): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit)) throw new Error("Verification source must name a full Git commit.");
  await archiveSource(input.repositoryPath, input.sourceCommit, "Verifier");
  const listing = (await checked("git", ["-C", input.repositoryPath, "ls-tree", "-rz", "--full-tree", input.sourceCommit])).toString("utf8");
  for (const entry of listing.split("\0").filter(Boolean)) {
    const match = /^(\d+) (\w+) [a-f0-9]+\t([\s\S]+)$/.exec(entry);
    if (match && (match[1] === "100644" || match[1] === "100755") && match[2] === "blob") continue;
    const kind = match?.[1] === "120000" ? "a symlink" : match?.[1] === "160000" ? "a submodule" : `mode ${match?.[1] ?? "unknown"}`;
    throw new Error(`Verifier source supports regular committed files only; '${match?.[3] ?? entry}' in commit ${input.sourceCommit} is ${kind}.`);
  }
}

export async function authenticateProductSource(input: {repositoryPath: string; sourceCommit: string}): Promise<{sourceCommit: string; sourceTree: string}> {
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit)) throw new Error("Product source must name a full Git commit.");
  const git = (args: string[]) => checked("git", ["-C", input.repositoryPath, ...args]);
  const sourceCommit = (await git(["rev-parse", "--verify", `${input.sourceCommit}^{commit}`])).toString("utf8").trim();
  if (sourceCommit !== input.sourceCommit) throw new Error("Product source identity changed.");
  return {sourceCommit, sourceTree: (await git(["rev-parse", `${sourceCommit}^{tree}`])).toString("utf8").trim()};
}

/** Authenticate committed bytes without consulting the product working tree. */
export async function authenticateVerificationSource(
  input: Pick<DockerVerificationInput, "repositoryPath" | "sourceCommit" | "scriptPath">,
): Promise<VerificationSourceIdentity> {
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit)) throw new Error("Verification source must name a full Git commit.");
  if (!input.scriptPath || input.scriptPath.startsWith("/") || input.scriptPath.includes("\\")
    || input.scriptPath.split("/").some((part) => !part || part === "." || part === "..")
    || input.scriptPath.includes("\0")) {
    throw new Error("Verification script must be a relative path within the committed product.");
  }
  const git = (args: string[]): Promise<Buffer> => checked("git", ["-C", input.repositoryPath, ...args]);
  const sourceCommit = (await git(["rev-parse", "--verify", `${input.sourceCommit}^{commit}`])).toString("utf8").trim();
  if (sourceCommit !== input.sourceCommit) throw new Error("Verification source identity changed.");
  const sourceTree = (await git(["rev-parse", `${sourceCommit}^{tree}`])).toString("utf8").trim();
  const entry = (await git(["ls-tree", "-z", sourceCommit, "--", input.scriptPath])).toString("utf8");
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== input.scriptPath) throw new Error("Verification script must be a committed regular file.");
  const script = await git(["cat-file", "blob", match[2]!]);
  return { sourceCommit, sourceTree, scriptSha256: createHash("sha256").update(script).digest("hex") };
}

/** Run one exact script in one disposable Docker container. Operation receipts
 * and retry policy belong to the caller; this function never retries execution. */
export async function executeDockerVerification(input: DockerVerificationInput): Promise<DockerVerificationResult> {
  const independent = input.independentVerification;
  const command = independent?.command ?? input.command;
  const scriptPath = independent?.scriptPath ?? input.scriptPath;
  const result: DockerVerificationResult = {
    sourceCommit: input.sourceCommit, sourceTree: null, scriptSha256: null,
    image: input.image, imageDigest: null, imageId: null,
    command: Array.isArray(command) ? [...command] : [], scriptPath: scriptPath ?? "",
    stdoutBase64: "", stderrBase64: "", exitCode: null, outcome: "error", started: false,
    phase: "source",
    startedAt: new Date().toISOString(), finishedAt: "",
  };
  let directory: string | undefined;
  const container = `mdlm-verification-${randomUUID()}`;
  let containerAttempted = false;
  let containerCreated = false;
  try {
    const imageMatch = /^[^\s@]+@sha256:([a-f0-9]{64})$/.exec(input.image);
    const localImage = independent && /^sha256:[a-f0-9]{64}$/.test(input.image);
    if (!imageMatch && !localImage) throw new Error(independent ? "Verification image must be pinned with @sha256:<64 lowercase hex digits>, or an exact local sha256 image ID for independent verification." : "Verification image must be pinned with @sha256:<64 lowercase hex digits>.");
    result.imageDigest = imageMatch ? `sha256:${imageMatch[1]}` : null;
    if (!Array.isArray(command) || command.length === 0
      || command.some((part) => typeof part !== "string" || part.includes("\0")) || !command[0]) {
      throw new Error("Verification command must be a nonempty argv array.");
    }
    const timeoutMs = input.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("Verification timeout must be between 1 and 300000 milliseconds.");
    if (independent) validateIndependentVerification(independent);
    const source = independent ? await authenticateProductSource(input) : await authenticateVerificationSource(input);
    Object.assign(result, source);
    if (independent) {
      const verifier = await authenticateVerificationSource(independent);
      result.independentVerification = {...verifier, activityRevision: independent.activityRevision};
      result.scriptSha256 = verifier.scriptSha256;
    }
    directory = await mkdtemp(join(tmpdir(), "mdlm-verification-"));
    const archive = await archiveSource(input.repositoryPath, source.sourceCommit, "Product");
    const archivePath = join(directory, "source.tar");
    await writeFile(archivePath, archive);
    const snapshot = join(directory, "source");
    await mkdir(snapshot);
    // Preserve archive modes so the unprivileged container can read and execute
    // committed files even when the caller uses a restrictive umask.
    await checked("tar", ["-xpf", archivePath, "-C", snapshot, "--no-same-owner"]);
    if (input.formalFiles) {
      const tracked = (await checked("git", ["-C", input.repositoryPath, "ls-tree", "-rz", "--name-only", source.sourceCommit])).toString("utf8").split("\0").filter(Boolean);
      if (!input.formalFiles.length || new Set(input.formalFiles).size !== input.formalFiles.length || input.formalFiles.some(file => !tracked.includes(file)) || (!independent && !input.formalFiles.includes(input.scriptPath!))) throw new Error(independent ? "Formal source selection must name distinct committed product files." : "Formal source selection must name distinct committed files including the verifier.");
      for (const file of tracked) if (!input.formalFiles.includes(file)) await rm(join(snapshot, file), {force: true});
    }
    await chmod(snapshot, 0o755);
    let verifierSnapshot = snapshot;
    let evidenceDirectory: string | undefined;
    if (independent) {
      const verifierArchive = await archiveSource(independent.repositoryPath, independent.sourceCommit, "Verifier");
      const verifierArchivePath = join(directory, "verification.tar");
      await writeFile(verifierArchivePath, verifierArchive);
      verifierSnapshot = join(directory, "verification");
      await mkdir(verifierSnapshot);
      await checked("tar", ["-xpf", verifierArchivePath, "-C", verifierSnapshot, "--no-same-owner"]);
      await chmod(verifierSnapshot, 0o755);
      evidenceDirectory = join(directory, "evidence");
      await mkdir(evidenceDirectory, {mode: 0o777});
      await chmod(evidenceDirectory, 0o777);
    }
    const archivedScriptHash = createHash("sha256").update(await readFile(join(verifierSnapshot, scriptPath!))).digest("hex");
    if (archivedScriptHash !== result.scriptSha256) throw new Error("Git archive changed the verification script bytes.");

    result.phase = "environment";
    containerAttempted = true;
    await checked("docker", ["create", "--name", container, "--network", "none", "--read-only",
      // Match the non-root caller for writable evidence, so nested output keeps
      // host-readable/removable ownership. Root callers retain nobody in Docker.
      "--user", independent && process.getuid?.() ? `${process.getuid()}:${process.getgid!()}` : "65534:65534",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "128", "--shm-size=128m", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
      ...(independent ? [
        "--mount", `type=bind,source=${snapshot},target=/product,readonly`,
        "--mount", `type=bind,source=${verifierSnapshot},target=/verification,readonly`,
        "--mount", `type=bind,source=${evidenceDirectory},target=/evidence`,
        "--env", "MDLM_PRODUCT_DIR=/product", "--env", "MDLM_EVIDENCE_DIR=/evidence",
        "--workdir", "/verification",
      ] : ["--mount", `type=bind,source=${snapshot},target=/workspace,readonly`, "--workdir", "/workspace"]),
      "--entrypoint", command[0], input.image, ...command.slice(1)], timeoutMs);
    containerCreated = true;
    result.imageId = (await checked("docker", ["inspect", "--format", "{{.Image}}", container])).toString("utf8").trim();
    if (localImage && result.imageId !== input.image) throw new Error("Container image differs from the exact local image ID.");

    // Start detached: an unsuccessful start is an environment error. Logs from
    // this container, rather than Docker's own diagnostics, are the raw streams.
    await checked("docker", ["start", container], timeoutMs);
    result.started = true;
    result.phase = "execution";
    const wait = await execute("docker", ["wait", container], timeoutMs);
    if (wait.problem || wait.exitCode !== 0) {
      result.diagnostic = wait.problem ?? `Docker wait failed: ${wait.stderr.toString("utf8").trim()}`;
      await checked("docker", ["kill", container]).catch(() => undefined);
    }
    const logs = await execute("docker", ["logs", container], 30_000);
    result.stdoutBase64 = logs.stdout.toString("base64");
    result.stderrBase64 = logs.stderr.toString("base64");
    if (logs.problem || logs.exitCode !== 0) result.diagnostic ??= logs.problem ?? "Docker log capture failed.";
    const state = JSON.parse((await checked("docker", ["inspect", "--format", "{{json .State}}", container])).toString("utf8")) as {
      Running: boolean; ExitCode: number; Error: string; OOMKilled: boolean;
    };
    if (!state.Running && Number.isInteger(state.ExitCode)) result.exitCode = state.ExitCode;
    if (state.Error || state.OOMKilled || state.Running) result.diagnostic ??= state.Error || "Container did not finish normally.";
    if (independent && evidenceDirectory) {
      const report = await captureVerificationReport(evidenceDirectory, independent);
      result.caseResults = report.caseResults;
      result.artifacts = report.artifacts;
      if (report.rawReportBase64 !== undefined) result.rawReportBase64 = report.rawReportBase64;
      const assessment = verificationReportOutcome(report, result.exitCode);
      if (!result.diagnostic) Object.assign(result, assessment);
    } else if (!result.diagnostic) {
      result.outcome = result.exitCode === 0 ? "pass" : result.exitCode === 1 ? "fail" : "error";
      if (result.outcome === "error") result.diagnostic = `Verification script exited with ${result.exitCode}; only 0 (pass) and 1 (assertion failure) are valid script outcomes.`;
    }
  } catch (error) {
    result.outcome = "error";
    result.diagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    // Attempt by name even when create timed out after the daemon accepted it.
    if (containerAttempted) {
      const cleanup = await execute("docker", ["rm", "--force", "--volumes", container], 30_000);
      if (containerCreated && (cleanup.problem || cleanup.exitCode !== 0)) {
        result.outcome = "error";
        result.diagnostic = `${result.diagnostic ? `${result.diagnostic} ` : ""}Container cleanup failed: ${cleanup.problem ?? cleanup.stderr.toString("utf8").trim()}`;
      }
    }
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
        result.outcome = "error";
        result.diagnostic = `${result.diagnostic ? `${result.diagnostic} ` : ""}Snapshot cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      });
    }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}
