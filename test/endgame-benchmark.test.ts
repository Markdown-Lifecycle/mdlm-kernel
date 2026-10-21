import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
vi.mock("../src/docker-verification.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/docker-verification.js")>();
  const {simulatedDockerVerification} = await import("./simulated-docker.js");
  return {...actual, executeDockerVerification: (input: unknown) => simulatedDockerVerification(actual, input)};
});
import { buildEndgameFixture, type EndgameFixture } from "./endgame-fixture.js";

// Manual benchmark, outside the PR suite:
//   MDLM_ENDGAME_BENCHMARK=/tmp/endgame MDLM_ENDGAME_RESULTS=200 \
//   MDLM_ENDGAME_EXECUTABLES=/path/to/before/dist/mdlm.js,dist/mdlm.js \
//   npx vitest run test/endgame-benchmark.test.ts
// The fixture is built once under MDLM_ENDGAME_BENCHMARK and reused. Each executable
// times export, status, verification status, review registration, review submission and acceptance on a
// fresh copy of the same lifecycle repository. Timings go to stdout and timings.json.
const benchmarkRoot = process.env.MDLM_ENDGAME_BENCHMARK;
test.skipIf(!benchmarkRoot)("endgame commands on a large lifecycle repository", async () => {
  const root = path.resolve(benchmarkRoot!), marker = path.join(root, "fixture.json");
  const results = Number(process.env.MDLM_ENDGAME_RESULTS ?? 200), historical = Math.round(results * 0.45);
  let fixture: EndgameFixture;
  try { fixture = JSON.parse(await fs.readFile(marker, "utf8")); }
  catch {
    await fs.mkdir(root, {recursive: true});
    const started = performance.now();
    fixture = await buildEndgameFixture(path.join(root, "base"), results, historical, message => process.stderr.write(`fixture: ${message}\n`));
    await fs.writeFile(marker, JSON.stringify({...fixture, results, historical, buildSeconds: (performance.now() - started) / 1000}, null, 2));
  }
  const executables = (process.env.MDLM_ENDGAME_EXECUTABLES ?? "dist/mdlm.js").split(",").map(file => path.resolve(file));
  const report: Record<string, Record<string, number>> = {};
  for (const [index, executable] of executables.entries()) {
    const run = path.join(root, `run-${Date.now()}-${index}`), repository = path.join(run, "lifecycle"), registry = path.join(run, "registry");
    await fs.mkdir(registry, {recursive: true});
    await fs.cp(fixture.repository, repository, {recursive: true, verbatimSymlinks: true});
    const timings: Record<string, number> = {};
    const cli = (label: string | undefined, ...args: string[]) => {
      const started = performance.now();
      const result = spawnSync(process.execPath, [executable, ...args, "--json"], {cwd: repository, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024,
        env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: "1"}});
      if (label) timings[label] = Math.round(performance.now() - started) / 1000;
      expect(result.status, `${args.join(" ")}\n${result.stdout.slice(0, 4000)}${result.stderr}`).toBe(0);
      return JSON.parse(result.stdout);
    };
    const draft = async (action: string, operation: string, payload: Record<string, unknown>) => {
      const file = path.join(run, `${operation}.json`);
      cli(undefined, "proposal", "draft", action, fixture.implementation, "--operation", operation, "--output", file);
      const proposal = JSON.parse(await fs.readFile(file, "utf8"));
      proposal.candidates[0].payload = {...proposal.candidates[0].payload, ...payload};
      await fs.writeFile(file, JSON.stringify(proposal));
      return file;
    };
    cli("export", "review", "context", "review-implementation", fixture.implementation, "--output", path.join(run, "context.json"));
    cli("status", "status");
    cli("verificationStatus", "verification", "status", fixture.implementation);
    const context = JSON.parse(await fs.readFile(path.join(run, "context.json"), "utf8"));
    expect(context.verificationReceipts).toHaveLength(results);
    const targets = context.requirementGraphs[0].requirements.map((r: any) => r.revision_id);
    const review = await draft("review-implementation", "review-implementation", {title: "Benchmark review", outcome: "pass", findings: "Benchmark fixture review",
      coverage_assessments: targets.map((target: string) => ({target, disposition: "adequate", rationale: "Benchmark coverage"}))});
    cli("register", "review", "register", review, review);
    cli("reviewSubmit", "proposal", "submit", review);
    const acceptance = await draft("accept-product", "accept-product", {title: "Benchmark acceptance", decision: "accept", rationale: "Benchmark fixture acceptance"});
    cli("acceptance", "proposal", "submit", acceptance, "--authority", "stakeholder");
    report[executable] = timings;
    process.stdout.write(`${JSON.stringify({executable, results, timings})}\n`);
    await fs.rm(run, {recursive: true, force: true});
  }
  await fs.writeFile(path.join(root, "timings.json"), JSON.stringify(report, null, 2));
}, 24 * 60 * 60 * 1000);
