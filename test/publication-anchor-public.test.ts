import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

// ADR 0010. Each witness edits saved copies consistently, so only the publication anchor can refuse it.
test("publication anchors refuse coordinated saved-copy edits and migrate an unanchored repository from Git history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-publication-anchor-"));
  const repository = path.join(root, "lifecycle"), registry = path.join(root, "registry");
  const cli = (exit: number, ...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000,
      env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: args[0] === "review" ? "1" : "0"}});
    expect(result.status, `${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(exit);
    return JSON.parse(result.stdout);
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], {encoding: "utf8"});
  const anchors = () => git("for-each-ref", "--format=%(refname) %(objectname)", "refs/mdlm/publication/");
  const submit = async (action: string, operation: string, candidates: object[], subject?: string, register = false) => {
    const g = cli(0, "expectations", "show", action, ...(subject ? [subject] : []));
    const file = path.join(root, `${operation}.json`);
    await fs.writeFile(file, JSON.stringify({operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates}));
    if (register) cli(0, "review", "register", file, file);
    const result = cli(0, "proposal", "submit", file);
    return {operation, file, result, directory: path.join(repository, ".lifecycle/data/.transactions", result.transaction)};
  };
  try {
    cli(0, "init", repository, "--process", "iterative");
    await fs.mkdir(registry);
    const framing = cli(0, "expectations", "show", "frame-experiment").candidates[0];
    const frame = await submit("frame-experiment", "frame", [{...framing, payload: {...framing.payload, title: "Count CLI", criterion: "Count all arguments", question: "Can a CLI count items?", approach: "Minimal counter", constraints: "No persistence", allowance_minutes: 5, scope_cut: "No interactive mode"}}]);
    const req = (localId: string, payload: object) => ({localId, type: "REQ", payload: {title: localId, publication: "recorded", ...payload}, links: [], body: ""});
    const set = cli(0, "expectations", "show", "draft-requirements").candidates.find((c: {type: string}) => c.type === "RQS");
    const requirements = await submit("draft-requirements", "requirements", [
      req("need", {kind: "stakeholder", statement: "The user shall obtain the number of supplied arguments", rationale: "Count supplied items"}),
      req("count", {kind: "software", ears: {pattern: "ubiquitous", system: "The CLI", response: "print the number of arguments and exit zero"}}),
      {localId: "decomposition", type: "DCP", payload: {title: "Counting", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$count"}], body: ""}, set]);
    git("add", "-A"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "Committed publications");
    const subject = requirements.result.revisions.find((id: string) => id.startsWith("RQS-"));
    const graph = cli(0, "review", "context", "review-requirements", subject).requirementGraphs[0];
    const verdict = cli(0, "expectations", "show", "review-requirements", subject).candidates[0];
    verdict.payload = {...verdict.payload, title: "Requirements review", outcome: "pass", findings: "Bounded fixture review",
      requirement_assessments: graph.requirements.map((r: {revision_id: string}) => ({requirement: r.revision_id, disposition: "valid", rationale: "Necessary"})),
      decomposition_assessments: graph.groups.map((d: {revision_id: string; links: {type: string; target: string}[]}) => ({group: d.revision_id, children: d.links.filter(l => l.type === "child").map(l => ({requirement: l.target, disposition: "valid", rationale: "Necessary"})), disposition: "adequate", membership_action: "none", rationale: "Sufficient"}))};
    // The review stays uncommitted: a never-committed publication, the normal state after submission.
    const review = await submit("review-requirements", "review", [verdict], subject, true);
    const published = anchors();
    expect(published.trim().split("\n")).toHaveLength(3);

    const execution = (directory: string) => path.join(directory, "execution.json");
    const editExecution = async (directory: string, edit: (tx: any) => void) => {
      const tx = JSON.parse(await fs.readFile(execution(directory), "utf8")); edit(tx);
      await fs.writeFile(execution(directory), `${JSON.stringify(tx, null, 2)}\n`);
    };
    const titleFile = path.join(frame.directory, "EXP", frame.result.revisions[0].replace(/-r\d+$/, ""), "r00001.md");
    const witnesses: [string, typeof frame, () => Promise<void>][] = [
      ["coordinated output and datum title", frame, async () => {
        await fs.writeFile(titleFile, (await fs.readFile(titleFile, "utf8")).replace("Count CLI", "Edited CLI"));
        await editExecution(frame.directory, tx => { tx.outputs[0].payload.title = "Edited CLI"; });
      }],
      ["transaction snapshot", requirements, () => editExecution(requirements.directory, tx => { tx.snapshot = `sha256:${"0".repeat(64)}`; })],
      ["transaction package language", requirements, () => editExecution(requirements.directory, tx => { tx.package.language = "mdlm-expression@2"; })],
      ["registered-review subject", review, () => editExecution(review.directory, tx => { tx.subject = frame.result.revisions[0]; })],
      ["registered-review inputs", review, () => editExecution(review.directory, tx => { tx.inputs = {subject: [frame.result.revisions[0]]}; })],
      ["registered-review verdict hash", review, () => editExecution(review.directory, tx => { tx.authority.review.verdictSha256 = "0".repeat(64); })],
      ["plain digest-only proposal digest (KF-009)", frame, () => editExecution(frame.directory, tx => { tx.proposalDigest = `sha256:${"0".repeat(64)}`; })],
    ];
    const snapshot = async (directory: string) => Object.fromEntries(await Promise.all((await fs.readdir(directory, {recursive: true, withFileTypes: true}))
      .filter(entry => entry.isFile()).map(async entry => [path.join(entry.parentPath, entry.name), await fs.readFile(path.join(entry.parentPath, entry.name), "utf8")])));
    const restore = async (saved: Record<string, string>) => { for (const [file, source] of Object.entries(saved)) await fs.writeFile(file, source); };
    const refused = (...args: string[]) => expect(JSON.stringify(cli(1, ...args).diagnostics), args.join(" ")).toContain("publication anchor");
    for (const [name, target, edit] of witnesses) {
      const saved = await snapshot(target.directory);
      await edit();
      const state = [git("status", "--porcelain"), git("show-ref")];
      refused("proposal", "settlement", target.operation);
      refused("proposal", "submit", target.file);
      refused("list");
      expect([git("status", "--porcelain"), git("show-ref")], name).toEqual(state);
      await restore(saved);
      // Valid alternative: the untouched publication settles, replays and reads.
      expect(cli(0, "proposal", "settlement", target.operation).outcome, name).toBe("accepted");
    }
    expect(cli(0, "proposal", "submit", review.file).transaction).toBe(review.result.transaction);

    // Migration: an existing repository has no anchor refs; this is its exact on-disk state.
    for (const line of published.trim().split("\n")) git("update-ref", "-d", line.split(" ")[0]!);
    const committed = await snapshot(requirements.directory);
    await editExecution(requirements.directory, tx => { tx.snapshot = `sha256:${"0".repeat(64)}`; });
    const blocked = cli(1, "list").diagnostics;
    expect(blocked).toContainEqual(expect.objectContaining({code: "publication-anchor-migration-refused", path: path.relative(repository, execution(requirements.directory))}));
    expect(anchors()).toBe("");
    await restore(committed);
    expect(cli(0, "list").ok).toBe(true);
    // Committed and never-committed publications are anchored exactly as at publication.
    expect(anchors()).toBe(published);
    for (const operation of ["frame", "requirements", "review"]) expect(cli(0, "proposal", "settlement", operation).outcome).toBe("accepted");
    expect(cli(0, "proposal", "submit", review.file).transaction).toBe(review.result.transaction);
    // After migration the uncommitted review is held to its anchor, and a single missing anchor refuses.
    const reviewed = await snapshot(review.directory);
    await editExecution(review.directory, tx => { tx.authority.review.verdictSha256 = "0".repeat(64); });
    refused("list");
    await restore(reviewed);
    git("update-ref", "-d", `refs/mdlm/publication/${frame.result.transaction}`);
    expect(cli(1, "list").diagnostics).toContainEqual(expect.objectContaining({code: "publication-anchor-missing"}));
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}, 120_000);
