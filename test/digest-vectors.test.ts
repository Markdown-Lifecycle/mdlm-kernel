import {spawnSync, execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";
import {expect, test} from "vitest";
import {parse} from "yaml";
import {directDigest} from "../src/direct-proposal.js";
import {reviewBinding, reviewDigest, reviewPacketDigest} from "../src/external-review.js";
import {canonicalChunks} from "../src/json-stream.js";
import {processPackageDigest} from "../src/process-package-digest.js";
import vectors from "./fixtures/digest-vectors.json" with {type: "json"};

const hex = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

// Published vectors pin today's canonicalization; see docs/contracts/digests.md.
test("published digest vectors match the current kernel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-digest-vectors-"));
  try {
    for (const vector of vectors.package) {
      const directory = path.join(root, vector.name.replaceAll(" ", "-"));
      for (const file of vector.files) {
        await fs.mkdir(path.dirname(path.join(directory, file.path)), {recursive: true});
        await fs.writeFile(path.join(directory, file.path), file.content);
      }
      expect(`sha256:${hex(vector.preimage)}`).toBe(vector.digest);
      expect(await processPackageDigest(directory)).toBe(vector.digest);
    }
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
  for (const vector of vectors.snapshot) {
    expect(JSON.stringify(vector.input)).toBe(vector.preimage);
    expect(directDigest(vector.preimage)).toBe(vector.digest);
  }
  expect(vectors.snapshot[0]!.digest).not.toBe(vectors.snapshot[1]!.digest);
  for (const vector of vectors.proposal) expect(directDigest(vector.bytes)).toBe(vector.digest);
  for (const vector of vectors.transaction) expect(`direct-${hex(vector.operation)}`).toBe(vector.id);
  for (const vector of vectors.reviewContext) {
    expect([...canonicalChunks(vector.input)].join("")).toBe(vector.preimage);
    expect(reviewDigest(vector.preimage)).toBe(vector.contextSha256);
    expect(reviewPacketDigest(vector.input)).toBe(vector.contextSha256);
  }
  expect(vectors.reviewContext[0]!.contextSha256).toBe(vectors.reviewContext[1]!.contextSha256);
  expect(vectors.reviewContext[0]!.contextSha256).not.toBe(vectors.reviewContext[2]!.contextSha256);
  for (const vector of vectors.reviewBinding) {
    expect([...canonicalChunks({contract: "mdlm-review-binding@1", repository: vector.repository, context: {...vector.context, snapshot: undefined}})].join("")).toBe(vector.preimage);
    expect(reviewDigest(vector.preimage)).toBe(vector.reviewBinding);
    expect(reviewBinding(vector.repository, vector.context as unknown as Parameters<typeof reviewBinding>[1])).toBe(vector.reviewBinding);
  }
  expect(vectors.reviewBinding[0]!.reviewBinding).toBe(vectors.reviewBinding[1]!.reviewBinding);
  for (const vector of vectors.reviewBytes) expect(reviewDigest(vector.bytes)).toBe(vector.sha256);
  for (const vector of vectors.registryKey) expect(`${reviewDigest(vector.repositoryRealpath)}-${vector.operation}.json`).toBe(vector.file);
});

// The CLI's own outputs follow the documented preimages, so the vectors describe real repositories.
test("a lifecycle repository's reported digests follow the documented preimages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-digest-live-"));
  const repository = path.join(root, "lifecycle"), verifier = path.join(root, "verifier"), registry = path.join(root, "registry");
  const executable = process.env.MDLM_DIRECT_EXECUTABLE ?? path.join(process.cwd(), "dist/mdlm.js");
  const cli = (args: string[], manager = false) => {
    const result = spawnSync(executable.endsWith(".js") ? process.execPath : executable, [...(executable.endsWith(".js") ? [executable] : []), ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000,
      env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: manager ? "1" : "0"},
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
  const commit = (cwd: string) => {
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Digest fixture");
    return git(cwd, "rev-parse", "HEAD");
  };
  const write = async (name: string, value: unknown) => {
    const file = path.join(root, name), bytes = JSON.stringify(value);
    await fs.writeFile(file, bytes);
    return {file, bytes};
  };
  const proposal = (g: any, operation: string) => write(`${operation}.json`, {operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates: g.candidates});
  const snapshotOf = async (g: any) => {
    const data = [];
    for (const file of execFileSync("find", [path.join(repository, ".lifecycle/data"), "-name", "*.md"], {encoding: "utf8"}).split("\n").filter(Boolean)) {
      const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(await fs.readFile(file, "utf8"))!;
      data.push({...parse(frontmatter!), body});
    }
    data.sort((a, b) => a.revision_id.localeCompare(b.revision_id));
    const repositoryIdentity = `git-commit:${git(repository, "rev-list", "--first-parent", "--max-parents=0", "HEAD")}`;
    return directDigest(JSON.stringify({package: g.package, repository: repositoryIdentity, data}));
  };
  try {
    cli(["init", repository, "--process", "iterative"]);
    await fs.mkdir(verifier); await fs.mkdir(registry);
    git(verifier, "init", "-q");
    await fs.writeFile(path.join(verifier, "verify.py"), "raise SystemExit(0)\n");
    const sourceCommit = commit(verifier);

    // Package digest covers the selected package directory; snapshot covers package, root commit and data.
    const frame = cli(["expectations", "show", "frame-experiment"]);
    const selection = JSON.parse(await fs.readFile(path.join(repository, ".lifecycle/process-selection.json"), "utf8"));
    expect(await processPackageDigest(path.join(repository, selection.package.path))).toBe(frame.package.digest);
    expect(await snapshotOf(frame)).toBe(frame.snapshot);

    // Proposal digest is the exact submitted bytes; transaction identity is the operation alone.
    frame.candidates[0].payload = {...frame.candidates[0].payload, title: "Seat count", criterion: "Staff see the seat count", question: "Is the count useful?", approach: "Prototype", constraints: "None", allowance_minutes: 5, scope_cut: "One count"};
    const framed = await proposal(frame, "frame");
    const accepted = cli(["proposal", "submit", framed.file]);
    expect(accepted.proposalDigest).toBe(`sha256:${hex(framed.bytes)}`);
    expect(accepted.transaction).toBe(`direct-${hex("frame")}`);
    commit(repository);
    const experiment = accepted.revisions[0];
    const authoring = cli(["verification", "context", experiment]);
    const plan = cli(["expectations", "show", "plan-criterion-verification", experiment]);
    expect(await snapshotOf(plan)).toBe(plan.snapshot);
    plan.candidates[0].payload = {...plan.candidates[0].payload, title: "Count check", method: "CLI test", objective: "Observe the count", authoring_subject: experiment, authoring_context: authoring.authoringContext, repository_path: verifier, source_commit: sourceCommit, verification_image: "python@sha256:" + "b".repeat(64), verification_command: ["python3", "verify.py"], verification_script: "verify.py", results_path: "results.json", cases: [{id: "count", targets: [experiment], preconditions: ["Fresh start"], actions: ["Ask for the count"], expected_results: ["The count is shown"], coverage_rationale: "Observes the criterion"}], coverage: [{target: experiment, obligations: ["Show the count"], case_ids: ["count"], rationale: "The case observes the criterion"}]};
    plan.candidates[0].links = [{type: "verifies", target: experiment}];
    const activity = cli(["proposal", "submit", (await proposal(plan, "plan")).file]).revisions[0];
    commit(repository);

    // Registration binds the review context without ok/command/diagnostics or its snapshot, in its repository,
    // plus exact verdict and proposal bytes, in a registry file keyed by the lifecycle repository's absolute real path.
    const review = cli(["expectations", "show", "review-verification", activity]);
    review.candidates[0].payload = {...review.candidates[0].payload, title: "Adequacy review", outcome: "fail", findings: "No expected count", coverage_assessments: [{target: experiment, disposition: "needs-change", rationale: "Expected result is not observable"}]};
    const reviewProposal = await proposal(review, "review"), verdict = await write("verdict.json", {candidates: review.candidates});
    const {ok: _ok, command: _command, diagnostics: _diagnostics, ...context} = cli(["review", "context", "review-verification", activity]);
    cli(["review", "register", reviewProposal.file, verdict.file], true);
    const realRepository = await fs.realpath(repository);
    const registered = JSON.parse(await fs.readFile(path.join(registry, `${hex(realRepository)}-review.json`), "utf8"));
    const repositoryIdentity = `git-commit:${git(repository, "rev-list", "--first-parent", "--max-parents=0", "HEAD")}`;
    expect(registered.contextSha256).toBe(reviewPacketDigest({contract: "mdlm-review-binding@1", repository: repositoryIdentity, context: {...context, snapshot: undefined}}));
    const drafted = path.join(root, "review-draft.json");
    cli(["proposal", "draft", "review-verification", activity, "--operation", "review-draft", "--output", drafted]);
    expect(JSON.parse(await fs.readFile(drafted, "utf8")).reviewBinding).toBe(`sha256:${registered.contextSha256}`);
    expect(registered.verdictSha256).toBe(hex(verdict.bytes));
    expect(registered.proposalSha256).toBe(hex(reviewProposal.bytes));
    expect(context.action.when.contract.definitionPath.startsWith(`${realRepository}/.lifecycle/packages/`)).toBe(true);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}, 60_000);
