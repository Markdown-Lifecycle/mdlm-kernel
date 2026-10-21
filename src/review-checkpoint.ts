import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repositoryGitEnvironment } from "./git-environment.js";

const exec = promisify(execFile);
const contract = "mdlm-review-checkpoint@1";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Completed review-context work for one exact lifecycle snapshot, so an interrupted
 * export or registration resumes instead of revalidating every result. Entries live
 * in the ignored work directory with the same local trust as saved execution receipts.
 * Their identity is the snapshot plus every saved execution ref and transaction record;
 * any change starts a fresh set and removes the old ones.
 */
export interface ReviewCheckpoints {
  read<T>(kind: string, key: string): Promise<T | undefined>;
  write(kind: string, key: string, value: unknown): Promise<void>;
}

export async function reviewCheckpoints(root: string, snapshot: string): Promise<ReviewCheckpoints> {
  const parent = path.join(root, ".lifecycle/work/checkpoints/review-context");
  // Saved executions are outside the snapshot; a new attempt or result can change validity.
  const executions = (await exec("git", ["-C", root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/mdlm/execution"], {env: repositoryGitEnvironment(), maxBuffer: 64 * 1024 * 1024})).stdout;
  // Result validation also reads transaction records, which the snapshot does not cover.
  const transactions = createHash("sha256"), records = path.join(root, ".lifecycle/data/.transactions");
  for (const id of (await fs.readdir(records).catch(() => [] as string[])).sort()) transactions.update(`${id}\0`).update(await fs.readFile(path.join(records, id, "execution.json"))).update("\0");
  const current = digest(`${contract}\0${snapshot}\0${executions}\0${transactions.digest("hex")}`), directory = path.join(parent, current);
  for (const entry of await fs.readdir(parent).catch(() => [] as string[])) {
    if (entry !== current) await fs.rm(path.join(parent, entry), {recursive: true, force: true});
  }
  const file = (kind: string, key: string) => path.join(directory, `${kind}-${digest(key)}.json`);
  return {
    async read<T>(kind: string, key: string) {
      try {
        const saved = JSON.parse(await fs.readFile(file(kind, key), "utf8")) as {contract: string; kind: string; key: string; value: T};
        return saved.contract === contract && saved.kind === kind && saved.key === key ? saved.value : undefined;
      } catch { return undefined; }
    },
    async write(kind: string, key: string, value: unknown) {
      await fs.mkdir(directory, {recursive: true});
      const target = file(kind, key), temporary = `${target}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify({contract, kind, key, value})); await fs.rename(temporary, target); }
      finally { await fs.rm(temporary, {force: true}); }
    },
  };
}
