import { execFileSync, spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
vi.mock("../src/docker-verification.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/docker-verification.js")>();
  const {simulatedDockerVerification} = await import("./simulated-docker.js");
  return {...actual, executeDockerVerification: (input: unknown) => simulatedDockerVerification(actual, input)};
});
import { buildEndgameFixture } from "./endgame-fixture.js";

// Export and registration are killed mid-run, then rerun. The rerun resumes from
// checkpoints and produces exactly the bytes of an uninterrupted run.
test("killed export and registration resume to identical results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-checkpoint-resume-"));
  const executable = path.join(process.cwd(), "dist/mdlm.js");
  try {
    const fixture = await buildEndgameFixture(path.join(root, "base"), 4, 2);
    // Receipt reads in the lifecycle repository are slowed so the kill lands between results.
    const slow = path.join(root, "slow-git"), realGit = execFileSync("which", ["git"], {encoding: "utf8"}).trim();
    await fs.mkdir(slow);
    await fs.writeFile(path.join(slow, "git"), `#!/bin/sh\ncase " $* " in *" cat-file blob "*) case "$2" in */lifecycle) sleep 0.5;; esac;; esac\nexec "${realGit}" "$@"\n`, {mode: 0o755});
    const copy = async (name: string) => {
      const run = path.join(root, name), repository = path.join(run, "lifecycle"), registry = path.join(run, "registry");
      await fs.mkdir(registry, {recursive: true}); await fs.cp(fixture.repository, repository, {recursive: true});
      return {run, repository, env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: "1"}, registry};
    };
    const cli = (target: Awaited<ReturnType<typeof copy>>, ...args: string[]) => {
      const result = spawnSync(process.execPath, [executable, ...args, "--json"], {cwd: target.repository, encoding: "utf8", env: target.env});
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result;
    };
    const killMidRun = (target: Awaited<ReturnType<typeof copy>>, ...args: string[]) => new Promise<{signal: NodeJS.Signals | null; stderr: string}>((resolve, reject) => {
      const child = spawn(process.execPath, [executable, ...args, "--json"], {cwd: target.repository, env: {...target.env, PATH: `${slow}${path.delimiter}${process.env.PATH}`}});
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; if (/verification results [1-3]\/4/.test(stderr)) child.kill("SIGKILL"); });
      child.on("error", reject);
      child.on("close", (_code, signal) => resolve({signal, stderr}));
    });
    const checkpoints = async (target: Awaited<ReturnType<typeof copy>>) => {
      const parent = path.join(target.repository, ".lifecycle/work/checkpoints/review-context");
      return (await Promise.all((await fs.readdir(parent)).map(async dir => fs.readdir(path.join(parent, dir))))).flat().filter(file => file.startsWith("result-")).length;
    };

    // Exports embed the repository path, so the uninterrupted reference runs in the same copy first.
    const target = await copy("run"), context = path.join(target.run, "context.json"), reference = path.join(target.run, "reference.json");
    const work = path.join(target.repository, ".lifecycle/work/checkpoints");
    const exportTo = (file: string) => ["review", "context", "review-implementation", fixture.implementation, "--output", file];
    cli(target, ...exportTo(reference));
    await fs.rm(work, {recursive: true, force: true});
    const killed = await killMidRun(target, ...exportTo(context));
    expect(killed.signal).toBe("SIGKILL");
    await expect(fs.access(context)).rejects.toThrow();
    const saved = await checkpoints(target);
    expect(saved).toBeGreaterThan(0); expect(saved).toBeLessThan(4);
    expect(cli(target, ...exportTo(context)).stderr).toContain(`verification results 4/4 (${saved} resumed from checkpoint)`);
    expect(await fs.readFile(context)).toEqual(await fs.readFile(reference));
    // Transaction records are outside the snapshot; changing one invalidates every checkpoint.
    const records = path.join(target.repository, ".lifecycle/data/.transactions"), record = path.join(records, (await fs.readdir(records))[0]!, "execution.json");
    const original = await fs.readFile(record);
    await fs.appendFile(record, " ");
    expect(cli(target, ...exportTo(path.join(target.run, "changed.json"))).stderr).not.toContain("resumed");
    await fs.writeFile(record, original);

    const review = path.join(target.run, "review.json");
    cli(target, "proposal", "draft", "review-implementation", fixture.implementation, "--operation", "review-implementation", "--output", review);
    const draft = JSON.parse(await fs.readFile(review, "utf8"));
    draft.candidates[0].payload = {...draft.candidates[0].payload, title: "Resume review", outcome: "pass", findings: "Fixture review", coverage_assessments: []};
    await fs.writeFile(review, JSON.stringify(draft));
    const registration = async () => {
      const files = (await fs.readdir(target.registry)).filter(file => file.endsWith(".json"));
      expect(files).toHaveLength(1);
      return fs.readFile(path.join(target.registry, files[0]!), "utf8");
    };
    cli(target, "review", "register", review, review);
    const registered = await registration();
    await fs.rm(target.registry, {recursive: true}); await fs.mkdir(target.registry); await fs.rm(work, {recursive: true, force: true});
    expect((await killMidRun(target, "review", "register", review, review)).signal).toBe("SIGKILL");
    expect(await fs.readdir(target.registry)).toEqual([]);
    expect(cli(target, "review", "register", review, review).stderr).toMatch(/verification results 4\/4 \([1-3] resumed from checkpoint\)/);
    expect(await registration()).toBe(registered);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}, 240_000);
