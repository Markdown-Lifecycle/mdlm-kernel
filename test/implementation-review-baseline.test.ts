import { installedProcessPackageRoot } from "../src/installed-process-package.js";
import {execFileSync} from "node:child_process";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, expect, test} from "vitest";
import {loadProcessPackage, type DatumEnvelope} from "../src/index.js";
import {buildDirectReviewContext} from "../src/direct-review-context.js";
import {verificationAuthoringContext} from "../src/independent-verification.js";
import {reviewPacketDigest} from "../src/external-review.js";
import {sourceAssessmentTargets} from "../src/direct-guidance.js";
import type {DirectContext} from "../src/direct-contract.js";

const datum = (type: string, name: string, revision = 1): DatumEnvelope => ({id: `${type}-${name}`, revision, revision_id: `${type}-${name}-r${String(revision).padStart(5, "0")}`, type, payload: {}, links: [], body: "Exact fixture", created_by: {process_ref: "fixture"}});
const link = (type: string, target: DatumEnvelope) => ({type, target: target.revision_id});
let context: DirectContext, repository: string, accepted: DatumEnvelope, previous: DatumEnvelope, current: DatumEnvelope, set: DatumEnvelope, change: DatumEnvelope, acceptance: DatumEnvelope, oldScope: DatumEnvelope, oldRequirement: DatumEnvelope, oldRefusal: DatumEnvelope, approval: DatumEnvelope;
beforeAll(async () => {
  const loaded = await loadProcessPackage(path.join(installedProcessPackageRoot("iterative")));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  repository = await mkdtemp(path.join(os.tmpdir(), "mdlm-review-baseline-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], {encoding: "utf8"}).trim();
  git("init", "-q");
  const commit = async (content: string) => {
    await writeFile(path.join(repository, "app.js"), content);
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", content.trim());
    return git("rev-parse", "HEAD");
  };
  const a = await commit("export const answer = 'A';\n"), b = await commit("export const answer = 'B';\n");
  oldRequirement = {...datum("REQ", "behavior"), payload: {kind: "software", statement: "A"}};
  const requirement = {...datum("REQ", "behavior", 2), payload: {kind: "software", statement: "B"}};
  oldRefusal = {...datum("REQ", "refusal"), payload: {kind: "software", statement: "Reject inputs outside A"}};
  const refusal = {...datum("REQ", "refusal", 2), payload: {kind: "software", statement: "Reject inputs outside B"}};
  const parent = {...datum("REQ", "purpose"), payload: {kind: "stakeholder", statement: "Provide the answer"}};
  const oldGroup = {...datum("DCP", "allocation"), links: [link("parent", parent), link("child", oldRequirement), link("child", oldRefusal)]};
  const group = {...datum("DCP", "allocation", 2), links: [link("parent", parent), link("child", requirement), link("child", refusal)]};
  const oldSet = {...datum("RQS", "selection", 4), links: [link("contains", parent), link("contains", oldRequirement), link("contains", oldRefusal), link("decomposition", oldGroup)]};
  accepted = {...datum("IMP", "product", 4), payload: {repository_path: repository, source_commit: a, file_roles: {"app.js": "production"}}, links: [link("implements", oldSet)]};
  acceptance = {...datum("ACC", "baseline"), payload: {decision: "accept"}, links: [link("accepts", accepted), link("confirms", oldSet)]};
  change = {...datum("CHG", "request"), links: [link("baseline", acceptance), link("changes", oldRequirement), link("changes", oldRefusal)]};
  approval = {...datum("REV", "approval"), payload: {outcome: "pass", findings: "Approve A to B and its refusal domain"}, links: [link("reviews", change)]};
  set = {...datum("RQS", "selection", 5), links: [link("contains", parent), link("contains", requirement), link("contains", refusal), link("decomposition", group), link("changes-under", change)]};
  previous = {...datum("IMP", "product", 5), payload: {...accepted.payload, source_commit: b}, links: [link("implements", set), link("changes-under", change)]};
  current = {...datum("IMP", "product", 6), payload: {...previous.payload, source_changes: {baseline_implementation: previous.revision_id, files: []}}, links: previous.links};
  const scope = (implementation: DatumEnvelope, requirement: DatumEnvelope) => ({...datum("SCP", `scope${implementation.revision}`), payload: {path: "app.js", name: "answer", role: "production", blob: git("rev-parse", `${implementation.payload.source_commit}:app.js`), source_commit: implementation.payload.source_commit, ranges: [{start: 1, end: 1}]}, links: [link("belongs-to", implementation), link("implements", requirement)]});
  oldScope = scope(accepted, oldRequirement);
  // A newer, unrelated acceptance must never become this change's baseline.
  const laterAcceptance = {...datum("ACC", "later", 9), payload: {decision: "accept"}, links: [link("accepts", previous), link("confirms", set)]};
  context = {root: repository, pkg: loaded.package, package: {reference: "fixture@1", digest: "fixture", language: "fixture"}, snapshot: "exact", action: loaded.package.actions["review-implementation"]!, subject: current.revision_id, inputs: {subject: [current.revision_id], requirements: [set.revision_id]}, data: [approval, oldRefusal, refusal, parent, oldGroup, group, oldRequirement, requirement, oldSet, set, accepted, previous, current, acceptance, change, oldScope, scope(previous, requirement), scope(current, requirement), laterAcceptance]};
});
afterAll(async () => { await rm(repository, {recursive: true, force: true}); });

test("accepted A remains visible when the nearest B to B source comparison is empty", async () => {
  const original = JSON.stringify(context);
  const reviewed = await buildDirectReviewContext(context);
  expect(reviewed.sourceScopes[0]).toMatchObject({implementation: current.revision_id, changes: current.payload.source_changes, comparison: {before: previous.revision_id, after: current.revision_id, diagnostics: [], differences: []}, acceptedBaseline: {requirements: set, change, acceptance, implementation: accepted, scopes: [oldScope], source: {implementation: accepted.revision_id, sourceCommit: accepted.payload.source_commit, files: [{path: "app.js", content: "export const answer = 'A';\n", formal: true}]}, comparison: {before: accepted.revision_id, after: current.revision_id, diagnostics: [], differences: [{status: "changed"}]}}});
  expect(reviewed.priorNormativeContext).toEqual({selection: set.revision_id, change, approvals: [approval], requirements: [oldRequirement, oldRefusal]});
  expect(reviewed.requirementGraphs[0]?.requirements.map(d => d.revision_id)).toEqual(["REQ-purpose-r00001", "REQ-behavior-r00002", "REQ-refusal-r00002"]);
  expect(reviewed.sources).toHaveLength(1);
  expect(reviewed.sources[0]?.sourceCommit).toBe(current.payload.source_commit);
  expect(reviewed.sourceAssessmentTargets).toEqual(sourceAssessmentTargets(context));
  expect(reviewed.sourceAssessmentTargets?.sourceScopes).toEqual([oldScope.revision_id]);
  expect(reviewed).toMatchObject({action: context.action, subject: context.subject, inputs: context.inputs});
  expect(reviewed.records.map(d => d.revision_id)).toEqual(context.data.filter(d => Object.values(context.inputs).flat().includes(d.revision_id)).map(d => d.revision_id));
  expect(JSON.stringify(context)).toBe(original);
});

test("first baseline and non-review implementation contexts gain no acceptedBaseline", async () => {
  const first = {...context, subject: accepted.revision_id, inputs: {subject: [accepted.revision_id]}};
  expect(await buildDirectReviewContext(first)).not.toHaveProperty("priorNormativeContext");
  expect(await buildDirectReviewContext({...context, action: {...context.action, capability: "implementation"}})).not.toHaveProperty("priorNormativeContext");
  expect((await buildDirectReviewContext(first)).sourceScopes[0]).not.toHaveProperty("acceptedBaseline");
  expect((await buildDirectReviewContext({...context, action: {...context.action, capability: "implementation"}})).sourceScopes[0]).not.toHaveProperty("acceptedBaseline");
});

test("missing or conflicting exact baseline references fail rather than selecting a later acceptance", async () => {
  for (const missing of [change, acceptance, accepted]) {
    await expect(buildDirectReviewContext({...context, data: context.data.filter(d => d !== missing)})).rejects.toThrow(/Accepted baseline/);
  }
  for (const owner of [current, set, change, acceptance]) {
    const relation = owner === current ? "implements" : owner === set ? "changes-under" : owner === change ? "baseline" : "accepts";
    const conflict = {...owner, links: [...owner.links, {type: relation, target: "conflicting-exact-revision"}]};
    await expect(buildDirectReviewContext({...context, data: context.data.map(d => d === owner ? conflict : d)})).rejects.toThrow(/Accepted baseline/);
  }
  await expect(buildDirectReviewContext({...context, data: context.data.map(d => d === acceptance ? {...d, payload: {decision: "reject"}} : d)})).rejects.toThrow(/Accepted baseline/);
});

test("activity review retains its graph and verifier while excluding available baseline product source", async () => {
  const verifier = await mkdtemp(path.join(os.tmpdir(), "mdlm-baseline-verifier-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", verifier, ...args], {encoding: "utf8"}).trim();
  try {
    git("init", "-q");
    await writeFile(path.join(verifier, "verify.js"), "// Requirement-derived public checks.\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Verifier");
    const activity = {...datum("VFY", "activity"), payload: {repository_path: verifier, source_commit: git("rev-parse", "HEAD"), authoring_subject: set.revision_id}, links: [{type: "verifies", target: "REQ-behavior-r00002"}]};
    const methodContext = {...context, subject: activity.revision_id, action: context.pkg.actions["review-verification"]!, inputs: {activity: [activity.revision_id]}, data: [...context.data, activity]};
    const reviewed = await buildDirectReviewContext(methodContext);
    expect(reviewed.priorNormativeContext).toEqual({selection: set.revision_id, change, approvals: [approval], requirements: [oldRequirement, oldRefusal]});
    expect(reviewed.records.filter(d => d.type === "REQ").map(d => d.revision_id)).toEqual(["REQ-behavior-r00002"]);
    const freshActivity = {...activity, payload: {...activity.payload, authoring_subject: "RQS-selection-r00004"}};
    expect(await buildDirectReviewContext({...context, subject: activity.revision_id, action: context.pkg.actions["review-verification"]!, inputs: {activity: [activity.revision_id]}, data: [...context.data, freshActivity]})).not.toHaveProperty("priorNormativeContext");
    expect(reviewed.sources).toEqual([]);
    expect(reviewed.sourceScopes).toEqual([]);
    expect(reviewed.sourceAssessmentTargets).toBeUndefined();
    expect(reviewed.records.some(d => ["IMP", "SCP", "ACC", "CHG"].includes(d.type))).toBe(false);
    expect(reviewed.requirementGraphs.map(graph => graph.selection)).toEqual([set.revision_id]);
    expect(reviewed.verifierSources?.[0]?.files[0]?.content).toBe("// Requirement-derived public checks.\n");
    expect(JSON.stringify(reviewed)).not.toContain("export const answer");
    // These records were absent from method context; their content now binds registration.
    const canonical = reviewPacketDigest(reviewed);
    const authoring = verificationAuthoringContext(methodContext, set.revision_id);
    for (const record of [change, approval, oldRequirement, oldRefusal]) {
      const changed = {...methodContext, data: methodContext.data.map(d => d === record ? {...d, body: "Changed authoritative context"} : d)};
      expect(reviewPacketDigest(await buildDirectReviewContext(changed))).not.toBe(canonical);
      expect(verificationAuthoringContext(changed, set.revision_id)).toEqual(authoring);
    }
    expect(authoring).not.toHaveProperty("priorNormativeContext");

    // Later amendments and other judgments cannot replace an exact historical approval.
    const amendment = {...datum("CHG", "request", 2), payload: change.payload, links: change.links};
    const laterApproval = {...datum("REV", "later-approval"), payload: approval.payload, links: [link("reviews", amendment)]};
    const failed = {...datum("REV", "rejected"), payload: {outcome: "fail"}, links: approval.links};
    const unrelated = {...datum("REV", "old-method"), payload: approval.payload, links: [link("reviews", accepted)]};
    const extended = {...methodContext, data: [...methodContext.data, amendment, laterApproval, failed, unrelated]};
    expect((await buildDirectReviewContext(extended)).priorNormativeContext).toEqual(reviewed.priorNormativeContext);
    const anotherApproval = {...datum("REV", "second-approval"), payload: approval.payload, links: approval.links};
    expect((await buildDirectReviewContext({...methodContext, data: [...methodContext.data, anotherApproval]})).priorNormativeContext?.approvals).toEqual([approval, anotherApproval]);
    for (const missing of [change, approval, oldRequirement, oldRefusal]) {
      await expect(buildDirectReviewContext({...extended, data: extended.data.filter(d => d !== missing)})).rejects.toThrow(/Prior normative context/);
    }
    const conflictingSet = {...set, links: [...set.links, link("changes-under", amendment)]};
    await expect(buildDirectReviewContext({...extended, data: extended.data.map(d => d === set ? conflictingSet : d)})).rejects.toThrow(/must bind one exact changes-under/);
    const wrongTarget = {...oldRefusal, type: "OBS"};
    await expect(buildDirectReviewContext({...methodContext, data: methodContext.data.map(d => d === oldRefusal ? wrongTarget : d)})).rejects.toThrow(/must name one available exact REQ/);

  } finally { await rm(verifier, {recursive: true, force: true}); }
});
