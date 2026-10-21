import {spawn, execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {expect, test} from "vitest";
import {repositoryLockWaitMilliseconds} from "../src/repository-lock.js";

// A peer kernel's lease is only the documented ref and blob, so the test writes it byte-for-byte.
test("submission waits for a released peer lease, refuses sustained contention and accepts later work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-repository-lease-"));
  const repository = path.join(root, "lifecycle"), registry = path.join(root, "registry");
  const executable = process.env.MDLM_DIRECT_EXECUTABLE ?? path.join(process.cwd(), "dist/mdlm.js");
  const cli = (args: string[]) => new Promise<{status: number | null; json: any; elapsed: number}>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(executable.endsWith(".js") ? process.execPath : executable, [...(executable.endsWith(".js") ? [executable] : []), ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: "0"},
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk);
    child.on("error", reject);
    child.on("close", status => resolve({status, json: JSON.parse(stdout), elapsed: Date.now() - started}));
  });
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], {encoding: "utf8"}).trim();
  const reference = (name: string) => { try { return git("rev-parse", "--verify", "--quiet", name); } catch { return undefined; } };
  const holdPeerLease = (name: string) => {
    const blob = execFileSync("git", ["-C", repository, "hash-object", "-w", "--stdin"], {
      input: `${JSON.stringify({expiresAt: Date.now() + 120_000, pid: process.pid, token: randomUUID()})}\n`, encoding: "utf8",
    }).trim();
    git("update-ref", name, blob);
    return blob;
  };
  const transactionLock = "refs/mdlm/transaction-lock", publicationLock = "refs/mdlm/publication-lock";
  try {
    expect((await cli(["init", repository, "--process", "iterative"])).status).toBe(0);
    await fs.mkdir(registry);
    const frame = (await cli(["expectations", "show", "frame-experiment"])).json;
    frame.candidates[0].payload = {...frame.candidates[0].payload, title: "Seat count", criterion: "Staff see the seat count", question: "Is the count useful?", approach: "Prototype", constraints: "None", allowance_minutes: 5, scope_cut: "One count"};
    const proposal = (operation: string) => {
      const file = path.join(root, `${operation}.json`);
      return fs.writeFile(file, JSON.stringify({operation, action: frame.action, package: frame.package, snapshot: frame.snapshot, inputs: frame.inputs, candidates: frame.candidates})).then(() => file);
    };

    const file = await proposal("lease-contention");
    const before = git("status", "--porcelain", "--untracked-files=all");

    // Sustained contention: a publication-scope lease held past the wait is refused with state preserved.
    const peer = holdPeerLease(publicationLock);
    const refused = await cli(["proposal", "submit", file]);
    expect(refused.status).not.toBe(0);
    expect(refused.json.diagnostics[0].code).toBe("direct-proposal-invalid");
    expect(refused.json.diagnostics[0].message).toContain(publicationLock);
    expect(refused.elapsed).toBeGreaterThanOrEqual(repositoryLockWaitMilliseconds);
    expect(reference(publicationLock)).toBe(peer);
    expect(reference(transactionLock)).toBeUndefined();
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect((await cli(["proposal", "settlement", "lease-contention"])).json.outcome).toBe("not-published");
    git("update-ref", "-d", publicationLock);

    // Short release, then later accepted work: a transaction-scope lease released within
    // the wait is acquired rather than refused, and the previously refused bytes publish.
    holdPeerLease(transactionLock);
    const pending = cli(["proposal", "submit", file]);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    git("update-ref", "-d", transactionLock);
    const accepted = await pending;
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(0);
    expect(accepted.json.outcome).toBe("accepted");
    expect(accepted.elapsed).toBeGreaterThanOrEqual(1_000);

    // Completed replay returns the settled result even with a stale snapshot and a held publication lease.
    holdPeerLease(publicationLock);
    const replay = await cli(["proposal", "submit", file]);
    expect(replay.status, JSON.stringify(replay.json)).toBe(0);
    expect(replay.json.transaction).toBe(accepted.json.transaction);
    expect(replay.elapsed).toBeLessThan(repositoryLockWaitMilliseconds);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}, 60_000);
