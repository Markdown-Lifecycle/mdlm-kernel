import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMdlmCli } from "../src/cli-main.js";
import { executeCommandApplication } from "../src/command-application.js";

const executable = path.join(process.cwd(), "dist/mdlm.js");

describe("MDLM CLI output", () => {
  let parent: string | undefined;

  afterEach(async () => {
    if (parent) await fs.rm(parent, { recursive: true, force: true });
  });

  async function startedRepository(): Promise<string> {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-cli-output-"));
    const repository = path.join(parent, "repository");
    const initialized = await executeCommandApplication(
      ["init", repository, "--json"],
      parent,
    );
    expect(initialized.exitCode).toBe(0);
    return repository;
  }

  it("keeps the direct discovery result pending until piped stdout accepts every byte", async () => {
    const repository = await startedRepository();
    let releaseWrite: (() => void) | undefined;
    const chunks: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        releaseWrite = callback;
      },
    });
    let completed = false;
    const invocation = runMdlmCli({
      arguments_: ["expectations", "--json"],
      cwd: repository,
      stdout,
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      performanceDiagnostics: false,
    }).then((exitCode) => {
      completed = true;
      return exitCode;
    });

    while (!releaseWrite) await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    releaseWrite();
    expect(await invocation).toBe(0);
    const output = Buffer.concat(chunks).toString("utf8");
    expect(output.length).toBeGreaterThan(0);
    expect(JSON.parse(output)).toMatchObject({
      contract: "mdlm-expectations@2",
      outcome: "work-available",
      items: expect.any(Array),
    });
  });

  it("fails the built CLI when piped stdout rejects the result", async () => {
    const repository = await startedRepository();
    const probe = path.join(parent!, "stdout-failure.mjs");
    await fs.writeFile(probe, `
process.stdout.write = (_chunk, encoding, callback) => {
  const completed = typeof encoding === "function" ? encoding : callback;
  if (typeof completed === "function") completed(new Error("injected stdout failure"));
  return false;
};
`);

    const next = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(probe).href, executable, "expectations", "--json"],
      { cwd: repository, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );

    expect(next.status).not.toBe(0);
    expect(next.stdout).toBe("");
    expect(next.stderr).toContain("injected stdout failure");
  });

  it("reports a closed stdout after review registration as a structured failure and keeps the registration", async () => {
    const repository = await startedRepository();
    const registry = path.join(parent!, "registry");
    await fs.mkdir(registry);
    const run = async (...args: string[]) => JSON.parse((await executeCommandApplication([...args, "--json"], repository)).output);
    const requirements = await run("expectations", "show", "draft-requirements@1");
    const requirementsFile = path.join(parent!, "requirements.json");
    await fs.writeFile(requirementsFile, JSON.stringify({
      operation: "requirements", action: requirements.action, package: requirements.package, snapshot: requirements.snapshot, inputs: requirements.inputs,
      candidates: [
        {localId: "need", type: "REQ", payload: {title: "Count items", publication: "recorded", kind: "stakeholder", statement: "The user shall obtain the number of supplied items"}, links: [], body: ""},
        {localId: "count", type: "REQ", payload: {title: "Count arguments", publication: "recorded", kind: "software", ears: {pattern: "ubiquitous", system: "The CLI", response: "print the argument count"}}, links: [], body: ""},
        {localId: "group", type: "DCP", payload: {title: "Counting", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$count"}], body: ""},
        requirements.candidates.find((candidate: {type: string}) => candidate.type === "RQS"),
      ],
    }));
    expect(await run("proposal", "submit", requirementsFile)).toMatchObject({ok: true, outcome: "accepted"});
    const [work] = (await run("expectations")).items;
    const review = await run("expectations", "show", work.action, work.subject);
    const reviewFile = path.join(parent!, "review.json");
    await fs.writeFile(reviewFile, JSON.stringify({operation: "review", action: review.action, package: review.package, snapshot: review.snapshot, subject: review.subject, inputs: review.inputs, candidates: review.candidates}));
    const env = {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: "1"};

    const child = spawn(process.execPath, [executable, "review", "register", reviewFile, reviewFile, "--json"], {cwd: repository, env, stdio: ["ignore", "pipe", "pipe"]});
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));

    expect(status, stderr).toBe(1);
    expect(stderr).not.toContain("Unhandled");
    expect(JSON.parse(stderr)).toMatchObject({ok: false, diagnostics: [{code: "command-output-unwritable", cause: "EPIPE"}]});
    const [stored] = await fs.readdir(registry);
    expect(stored).toMatch(/-review\.json$/);
    const registration = await fs.readFile(path.join(registry, stored!), "utf8");
    vi.stubEnv("MDLM_REVIEW_REGISTRY", registry);
    vi.stubEnv("MDLM_REVIEW_REGISTRAR", "1");
    try {
      // The registration was stored complete before the output failed; an exact repeat leaves it unchanged.
      expect(await run("review", "register", reviewFile, reviewFile)).toMatchObject({ok: true, command: "review.register"});
      expect(await fs.readFile(path.join(registry, stored!), "utf8")).toBe(registration);
    } finally { vi.unstubAllEnvs(); }
  });

  it("exits nonzero without an uncaught exception when stdout and stderr are both closed", async () => {
    const repository = await startedRepository();
    const uncaught = path.join(parent!, "uncaught.txt");
    const probe = path.join(parent!, "uncaught-monitor.mjs");
    await fs.writeFile(probe, `import { appendFileSync } from "node:fs";\nprocess.on("uncaughtExceptionMonitor", (error) => appendFileSync(${JSON.stringify(uncaught)}, String(error)));\n`);
    const child = spawn(process.execPath, ["--import", pathToFileURL(probe).href, executable, "expectations", "--json"], {
      cwd: repository, env: {...process.env, MDLM_PERFORMANCE: "json"}, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.destroy();
    child.stderr.destroy();
    expect(await new Promise<number | null>((resolve) => child.on("close", resolve))).toBe(1);
    await expect(fs.readFile(uncaught, "utf8")).rejects.toMatchObject({code: "ENOENT"});
  });

  it("runs through an installed-style bin symlink", async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-cli-symlink-"));
    const launcher = path.join(parent, "mdlm");
    await fs.symlink(executable, launcher);

    const help = spawnSync(process.execPath, [launcher, "--help"], {
      cwd: parent,
      encoding: "utf8",
    });

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage: mdlm");
  });
});
