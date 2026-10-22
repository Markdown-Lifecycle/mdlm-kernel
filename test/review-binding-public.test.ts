import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { reviewDigest, reviewPacketDigest } from "../src/external-review.js";

// ADR 0011: a review binds its own context, so publications outside it leave the registration valid.
test("independent reviews stay valid across unrelated publications and refuse in-set ones", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-review-binding-"));
  const repository = path.join(root, "lifecycle"), verifier = path.join(root, "verifier"), registry = path.join(root, "registry");
  const cli = (exit: number, ...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000,
      env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: args[0] === "review" ? "1" : "0"}});
    expect(result.status, result.stdout + result.stderr).toBe(exit);
    return JSON.parse(result.stdout);
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
  const write = async (name: string, value: unknown) => { const file = path.join(root, name); await fs.writeFile(file, JSON.stringify(value)); return file; };
  let experiment = "", sourceCommit = "";
  const plan = async (operation: string) => {
    const g = cli(0, "expectations", "show", "plan-criterion-verification", experiment);
    const candidate = g.candidates[0];
    candidate.payload = {...candidate.payload, title: operation, method: "CLI test", objective: "Observe the count", authoring_subject: experiment, authoring_context: cli(0, "verification", "context", experiment).authoringContext, repository_path: verifier, source_commit: sourceCommit, verification_image: "python@sha256:" + "b".repeat(64), verification_command: ["python3", "verify.py"], verification_script: "verify.py", results_path: "results.json", cases: [{id: "count", targets: [experiment], preconditions: ["Fresh start"], actions: ["Ask for the count"], expected_results: ["The count is shown"], coverage_rationale: "Observes the criterion"}], coverage: [{target: experiment, obligations: ["Show the count"], case_ids: ["count"], rationale: "The case observes the criterion"}]};
    candidate.links = [{type: "verifies", target: experiment}];
    return cli(0, "proposal", "submit", await write(`${operation}.json`, {operation, action: g.action, package: g.package, snapshot: g.snapshot, subject: g.subject, inputs: g.inputs, candidates: [candidate]})).revisions[0] as string;
  };
  // Export, draft and fill one review, as a manager does before handing it to a reviewer.
  const draft = async (activity: string, operation: string) => {
    cli(0, "review", "context", "review-verification", activity, "--output", path.join(root, `${operation}-context.json`));
    const file = path.join(root, `${operation}.json`);
    cli(0, "proposal", "draft", "review-verification", activity, "--operation", operation, "--output", file);
    const proposal = JSON.parse(await fs.readFile(file, "utf8"));
    expect(proposal.reviewBinding).toMatch(/^sha256:[a-f0-9]{64}$/);
    proposal.candidates[0].payload = {...proposal.candidates[0].payload, title: "Adequacy review", outcome: "fail", findings: "No expected count", coverage_assessments: [{target: experiment, disposition: "needs-change", rationale: "Expected result is not observable"}]};
    await fs.writeFile(file, JSON.stringify(proposal));
    return {file, proposal, verdict: await write(`${operation}-verdict.json`, {candidates: proposal.candidates})};
  };
  try {
    cli(0, "init", repository, "--process", "iterative");
    await fs.mkdir(verifier); await fs.mkdir(registry);
    git(verifier, "init", "-q");
    await fs.writeFile(path.join(verifier, "verify.py"), "raise SystemExit(0)\n");
    git(verifier, "add", ".");
    git(verifier, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Verifier");
    sourceCommit = git(verifier, "rev-parse", "HEAD");
    const frame = cli(0, "expectations", "show", "frame-experiment");
    frame.candidates[0].payload = {...frame.candidates[0].payload, title: "Seat count", criterion: "Staff see the seat count", question: "Is the count useful?", approach: "Prototype", constraints: "None", allowance_minutes: 5, scope_cut: "One count"};
    experiment = cli(0, "proposal", "submit", await write("frame.json", {operation: "frame", action: frame.action, package: frame.package, snapshot: frame.snapshot, inputs: frame.inputs, candidates: frame.candidates})).revisions[0];
    const [a, b] = [await plan("plan-a"), await plan("plan-b")];

    // Two independent reviews in flight, with an unrelated publication before either registers.
    const first = await draft(a, "review-a"), second = await draft(b, "review-b");
    const c = await plan("plan-c");
    cli(0, "review", "register", first.file, first.verdict);
    const published = cli(0, "proposal", "submit", first.file);
    // The first review's publication is outside the second review's context too.
    cli(0, "review", "register", second.file, second.verdict);
    const registered = JSON.parse(await fs.readFile(path.join(registry, `${reviewDigest(await fs.realpath(repository))}-review-b.json`), "utf8"));
    expect(registered).toMatchObject({contract: "mdlm-registered-review@3", contextSha256: second.proposal.reviewBinding.slice(7)});
    const tx = JSON.parse(await fs.readFile(path.join(repository, ".lifecycle/data/.transactions", cli(0, "proposal", "submit", second.file).transaction, "execution.json"), "utf8"));
    expect(tx.authority.review.contract).toBe("mdlm-registered-review@3");
    expect(tx.snapshot).not.toBe(second.proposal.snapshot);
    expect(cli(0, "proposal", "settlement", "review-a")).toMatchObject({outcome: "accepted", revisions: published.revisions});

    // In-set: another review of the same activity publishes first, so the stale one is refused.
    const stale = await draft(c, "review-c-stale"), fresh = await draft(c, "review-c-fresh");
    cli(0, "review", "register", fresh.file, fresh.verdict);
    cli(0, "proposal", "submit", fresh.file);
    expect(cli(1, "review", "register", stale.file, stale.verdict).diagnostics[0].message).toContain("not currently eligible");
    // A binding that doesn't name the current context is refused, and a non-review action can't use one.
    const d = await plan("plan-d"), tampered = await draft(d, "review-d");
    await fs.writeFile(tampered.file, JSON.stringify({...tampered.proposal, reviewBinding: `sha256:${"0".repeat(64)}`}));
    expect(cli(1, "review", "register", tampered.file, tampered.verdict).diagnostics[0].message).toContain("Review context changed since the proposal was drafted");
    const g = cli(0, "expectations", "show", "plan-criterion-verification", experiment);
    expect(cli(1, "proposal", "submit", await write("unreviewed.json", {operation: "unreviewed", action: g.action, package: g.package, snapshot: `sha256:${"0".repeat(64)}`, reviewBinding: tampered.proposal.reviewBinding, subject: g.subject, inputs: g.inputs, candidates: g.candidates})).diagnostics[0].message).toContain("Only an independently reviewed review action can bind a review context");

    // Compatibility: a registration from an earlier kernel (@2, whole context with snapshot) still authorizes a
    // proposal without a binding, and its published proof settles and replays.
    const legacy = cli(0, "expectations", "show", "review-verification", d);
    legacy.candidates[0] = tampered.proposal.candidates[0];
    const source = JSON.stringify({operation: "review-d-legacy", action: legacy.action, package: legacy.package, snapshot: legacy.snapshot, subject: legacy.subject, inputs: legacy.inputs, candidates: legacy.candidates});
    const legacyFile = await write("review-d-legacy.json", JSON.parse(source)), verdict = JSON.stringify({candidates: legacy.candidates});
    const {ok: _ok, command: _command, diagnostics: _diagnostics, ...context} = cli(0, "review", "context", "review-verification", d);
    await fs.writeFile(path.join(registry, `${reviewDigest(await fs.realpath(repository))}-review-d-legacy.json`), `${JSON.stringify({contract: "mdlm-registered-review@2", operation: "review-d-legacy", contextSha256: reviewPacketDigest(context), verdictSha256: reviewDigest(verdict), proposalSha256: reviewDigest(source), verdict})}\n`);
    const accepted = cli(0, "proposal", "submit", legacyFile);
    const legacyTx = JSON.parse(await fs.readFile(path.join(repository, ".lifecycle/data/.transactions", accepted.transaction, "execution.json"), "utf8"));
    expect(legacyTx.authority.review.contract).toBe("mdlm-registered-review@2");
    expect(cli(0, "proposal", "settlement", "review-d-legacy")).toMatchObject({outcome: "accepted", revisions: accepted.revisions});
    expect(cli(0, "proposal", "submit", legacyFile)).toMatchObject({outcome: "accepted", revisions: accepted.revisions});
    expect(cli(0, "show", accepted.revisions[0]).lifecycleDatum.datum.payload.outcome).toBe("fail");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}, 180_000);
