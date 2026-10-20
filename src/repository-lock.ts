import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { repositoryGitEnvironment } from "./git-environment.js";

const locallyReleasedLocks = new Set<string>();

/**
 * Policy: how long one scope waits for a live peer lease before refusing.
 * This is a kernel policy, not a service-level guarantee; see
 * docs/contracts/repository-leases.md.
 */
export const repositoryLockWaitMilliseconds = 10_000;

interface GitCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function gitCommand(
  root: string,
  arguments_: string[],
  input?: string,
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...arguments_], {
      env: repositoryGitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout += chunk);
    child.stderr.on("data", (chunk: string) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

interface RepositoryLockOwner {
  expiresAt?: unknown;
  pid?: unknown;
  token?: unknown;
}

async function lockOwner(
  root: string,
  objectId: string,
): Promise<RepositoryLockOwner | undefined> {
  const owner = await gitCommand(root, ["cat-file", "-p", objectId]);
  if (owner.code !== 0) return undefined;
  try {
    return JSON.parse(owner.stdout) as RepositoryLockOwner;
  } catch {
    return undefined;
  }
}

function processState(pid: number): "running" | "absent" | "unknown" {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "absent" : "unknown";
  }
}

async function updateLock(
  root: string,
  reference: string,
  ownerObjectId: string,
  expectedObjectId: string,
): Promise<boolean> {
  const updated = await gitCommand(root, [
    "update-ref",
    reference,
    ownerObjectId,
    expectedObjectId,
  ]);
  return updated.code === 0;
}

async function releaseLock(
  root: string,
  reference: string,
  ownerObjectId: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (true) {
    const current = await gitCommand(root, [
      "rev-parse",
      "--verify",
      reference,
    ]);
    if (current.code !== 0 || current.stdout.trim() !== ownerObjectId) return;
    const released = await gitCommand(root, [
      "update-ref",
      "-d",
      reference,
      ownerObjectId,
    ]);
    if (released.code === 0) return;
    if (Date.now() >= deadline) {
      locallyReleasedLocks.add(token);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function lockObject(root: string, token: string): Promise<string> {
  const hashed = await gitCommand(
    root,
    ["hash-object", "-w", "--stdin"],
    `${JSON.stringify({
      expiresAt: Date.now() + 60_000,
      pid: process.pid,
      token,
    })}\n`,
  );
  const ownerObjectId = hashed.stdout.trim();
  if (hashed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(ownerObjectId)) {
    throw new Error(
      `Could not create repository lock owner: ${hashed.stderr.trim()}`,
    );
  }
  return ownerObjectId;
}

/** Serialize and fence one repository mutation class across processes. */
export async function withRepositoryLock<T>(
  root: string,
  reference: `refs/mdlm/${string}`,
  operation: (renew: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  let ownerObjectId = await lockObject(root, token);
  const deadline = Date.now() + repositoryLockWaitMilliseconds;
  while (true) {
    if (
      await updateLock(
        root,
        reference,
        ownerObjectId,
        "0".repeat(ownerObjectId.length),
      )
    ) break;
    const current = await gitCommand(root, [
      "rev-parse",
      "--verify",
      reference,
    ]);
    const currentObjectId = current.stdout.trim();
    if (current.code === 0 && /^[0-9a-f]{40,64}$/.test(currentObjectId)) {
      const owner = await lockOwner(root, currentObjectId);
      const abandoned =
        typeof owner?.expiresAt !== "number" ||
        typeof owner.pid !== "number" ||
        typeof owner.token !== "string" ||
        processState(owner.pid) === "absent" ||
        Date.now() >= owner.expiresAt ||
        (
          owner.pid === process.pid &&
          locallyReleasedLocks.has(owner.token)
        );
      if (
        abandoned &&
        await updateLock(root, reference, ownerObjectId, currentObjectId)
      ) break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for repository lock '${reference}'`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const renew = async () => {
    const renewedObjectId = await lockObject(root, token);
    if (!await updateLock(root, reference, renewedObjectId, ownerObjectId)) {
      throw new Error(`Repository lock '${reference}' was lost before commit`);
    }
    ownerObjectId = renewedObjectId;
  };

  let result: T;
  try {
    result = await operation(renew);
  } catch (error) {
    await releaseLock(root, reference, ownerObjectId, token);
    throw error;
  }
  await releaseLock(root, reference, ownerObjectId, token);
  return result;
}
