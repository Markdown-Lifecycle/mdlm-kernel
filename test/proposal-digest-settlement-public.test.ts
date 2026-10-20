import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

// KF-009 registered-review witness: only the stored proposalDigest changes, to the hash of
// never-registered bytes Q2 that parse equal to the registered proposal Q.
test("settlement and replay refuse a stored proposal digest that contradicts its registered review", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-proposal-digest-"));
  const repository = path.join(root, "lifecycle"), registry = path.join(root, "registry");
  const cli = (exit: number, ...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000,
      env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: args[0] === "review" ? "1" : "0"}});
    expect(result.status, result.stdout + result.stderr).toBe(exit);
    return JSON.parse(result.stdout);
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], {encoding: "utf8"});
  const submit = async (action: string, operation: string, candidates: object[], subject?: string, register = false) => {
    const g = cli(0, "expectations", "show", action, ...(subject ? [subject] : []));
    const source = JSON.stringify({operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates});
    const file = path.join(root, `${operation}.json`);
    await fs.writeFile(file, source);
    if (register) cli(0, "review", "register", file, file);
    return {file, source, result: cli(0, "proposal", "submit", file)};
  };
  try {
    cli(0, "init", repository, "--process", "iterative");
    await fs.mkdir(registry);
    const framing = cli(0, "expectations", "show", "frame-experiment").candidates[0];
    await submit("frame-experiment", "frame", [{...framing, payload: {...framing.payload, title: "Count CLI", criterion: "Count all arguments", question: "Can a CLI count items?", approach: "Minimal counter", constraints: "No persistence", allowance_minutes: 5, scope_cut: "No interactive mode"}}]);
    const req = (localId: string, payload: object) => ({localId, type: "REQ", payload: {title: localId, publication: "recorded", ...payload}, links: [], body: ""});
    const set = cli(0, "expectations", "show", "draft-requirements").candidates.find((c: {type: string}) => c.type === "RQS");
    const published = (await submit("draft-requirements", "requirements", [
      req("need", {kind: "stakeholder", statement: "The user shall obtain the number of supplied arguments", rationale: "Count supplied items"}),
      req("count", {kind: "software", ears: {pattern: "ubiquitous", system: "The CLI", response: "print the number of arguments and exit zero"}}),
      {localId: "decomposition", type: "DCP", payload: {title: "Counting", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$count"}], body: ""}, set])).result;
    const subject = published.revisions.find((id: string) => id.startsWith("RQS-"));
    const graph = cli(0, "review", "context", "review-requirements", subject).requirementGraphs[0];
    const review = cli(0, "expectations", "show", "review-requirements", subject).candidates[0];
    review.payload = {...review.payload, title: "Requirements review", outcome: "pass", findings: "Bounded fixture review",
      requirement_assessments: graph.requirements.map((r: {revision_id: string}) => ({requirement: r.revision_id, disposition: "valid", rationale: "Necessary"})),
      decomposition_assessments: graph.groups.map((d: {revision_id: string; links: {type: string; target: string}[]}) => ({group: d.revision_id, children: d.links.filter(l => l.type === "child").map(l => ({requirement: l.target, disposition: "valid", rationale: "Necessary"})), disposition: "adequate", membership_action: "none", rationale: "Sufficient"}))};
    const q = await submit("review-requirements", "review", [review], subject, true);
    const {command: _command, ...accepted} = q.result;
    const executionFile = path.join(repository, ".lifecycle/data/.transactions", q.result.transaction, "execution.json");
    const original = await fs.readFile(executionFile, "utf8"), tx = JSON.parse(original);
    expect(tx.authority.review.proposalSha256).toBe(createHash("sha256").update(q.source).digest("hex"));
    const q2 = `${JSON.stringify(JSON.parse(q.source), null, 2)}\n`, q2File = path.join(root, "review-q2.json");
    await fs.writeFile(q2File, q2);
    await fs.writeFile(executionFile, JSON.stringify({...tx, proposalDigest: `sha256:${createHash("sha256").update(q2).digest("hex")}`}, null, 2) + "\n");
    const state = [git("status", "--porcelain"), git("show-ref")];
    for (const args of [["proposal", "settlement", "review"], ["proposal", "submit", q2File], ["proposal", "submit", q.file]]) {
      expect(cli(1, ...args).diagnostics[0].message, args.join(" ")).toContain("contradicts its registered review proof");
    }
    expect([git("status", "--porcelain"), git("show-ref")]).toEqual(state);
    // Valid alternative: the untouched transaction settles and replays its exact registered bytes.
    await fs.writeFile(executionFile, original);
    expect(cli(0, "proposal", "settlement", "review")).toMatchObject(accepted);
    expect(cli(0, "proposal", "submit", q.file)).toMatchObject(accepted);
    expect(cli(1, "proposal", "submit", q2File).diagnostics[0].message).toContain("different candidate bytes");
    expect(cli(0, "show", q.result.revisions[0]).lifecycleDatum.datum.payload.outcome).toBe("pass");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}, 60_000);
