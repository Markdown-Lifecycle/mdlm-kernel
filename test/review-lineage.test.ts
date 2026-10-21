import { installedProcessPackageRoot } from "../src/installed-process-package.js";
import {execFileSync} from "node:child_process";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {beforeAll, expect, test} from "vitest";
import {loadProcessPackage, type DatumEnvelope} from "../src/index.js";
import {buildDirectReviewContext} from "../src/direct-review-context.js";
import {reviewPacketDigest} from "../src/external-review.js";
import type {DirectContext} from "../src/direct-contract.js";

const datum = (type: string, name: string, revision = 1): DatumEnvelope => ({id: `${type}-${name}`, revision, revision_id: `${type}-${name}-r${String(revision).padStart(5, "0")}`, type, payload: {}, links: [], body: "Exact fixture", created_by: {process_ref: "fixture"}});
const link = (type: string, target: DatumEnvelope) => ({type, target: target.revision_id});
let context: DirectContext, parent: DatumEnvelope, oldChild: DatumEnvelope, oldGroup: DatumEnvelope, first: DatumEnvelope, second: DatumEnvelope, current: DatumEnvelope, firstReview: DatumEnvelope, secondReview: DatumEnvelope, change: DatumEnvelope, approval: DatumEnvelope;
beforeAll(async () => {
  const loaded = await loadProcessPackage(path.join(installedProcessPackageRoot("iterative")));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  parent = {...datum("REQ", "purpose"), payload: {kind: "stakeholder", statement: "Provide the answer"}};
  oldChild = {...datum("REQ", "behavior"), payload: {kind: "software", statement: "A"}};
  const child = {...datum("REQ", "behavior", 2), payload: {kind: "software", statement: "B"}};
  oldGroup = {...datum("DCP", "allocation"), links: [link("parent", parent), link("child", oldChild)]};
  const group = {...datum("DCP", "allocation", 2), links: [link("parent", parent), link("child", child)]};
  first = {...datum("RQS", "selection"), links: [link("contains", parent), link("contains", oldChild), link("decomposition", oldGroup)]};
  firstReview = {...datum("REV", "first"), payload: {publication: "recorded", outcome: "fail", findings: "A is ambiguous"}, links: [link("reviews", first)]};
  second = {...first, ...datum("RQS", "selection", 2), links: [...first.links, link("corrects", firstReview)]};
  secondReview = {...datum("REV", "second"), payload: {publication: "recorded", outcome: "fail", findings: "Still ambiguous"}, links: [link("reviews", second)]};
  change = {...datum("CHG", "request"), payload: {reason: "Stakeholder decision 06"}};
  approval = {...datum("REV", "approval"), payload: {publication: "recorded", outcome: "pass", findings: "Approved"}, links: [link("reviews", change)]};
  current = {...datum("RQS", "selection", 3), links: [link("contains", parent), link("contains", child), link("decomposition", group), link("corrects", secondReview), link("changes-under", change)]};
  const unrelated = {...datum("REV", "unrelated"), payload: {publication: "recorded", outcome: "fail", findings: "Other set"}, links: [{type: "reviews", target: "RQS-other-r00001"}]};
  context = {root: process.cwd(), pkg: loaded.package, package: {reference: "fixture@1", digest: "fixture", language: "fixture"}, snapshot: "exact", action: loaded.package.actions["review-requirements"]!, subject: current.revision_id, inputs: {subject: [current.revision_id]}, data: [parent, oldChild, child, oldGroup, group, first, firstReview, second, secondReview, change, approval, current, unrelated]};
});

test("a corrected requirement set's review context carries its exact lineage, answered review and change approval", async () => {
  const original = JSON.stringify(context);
  const reviewed = await buildDirectReviewContext(context);
  expect(reviewed.lineage).toEqual({predecessors: [first, second], answers: [secondReview.revision_id], changes: [change], decisions: [firstReview, secondReview, approval],
    predecessorGraph: {selection: second.revision_id, groups: [oldGroup], requirements: [{...parent, leaf: false}, {...oldChild, leaf: true}], diagnostics: []}});
  // Lineage is context only: records and the reviewed graph are unchanged.
  expect(reviewed.records.map(d => d.revision_id)).toEqual([current.revision_id]);
  expect(reviewed.requirementGraphs.map(graph => graph.selection)).toEqual([current.revision_id]);
  expect(JSON.stringify(context)).toBe(original);
});

test("a later judgment on a predecessor changes the bound context, so an earlier registration cannot match", async () => {
  const before = reviewPacketDigest(await buildDirectReviewContext(context));
  const late = {...datum("REV", "late"), payload: {publication: "recorded", outcome: "fail", findings: "Late"}, links: [link("reviews", first)]};
  expect(reviewPacketDigest(await buildDirectReviewContext({...context, data: [...context.data, late]}))).not.toBe(before);
});

test("a revised verification activity carries its predecessor and the failed review it answers", async () => {
  const verifier = await mkdtemp(path.join(os.tmpdir(), "mdlm-review-lineage-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", verifier, ...args], {encoding: "utf8"}).trim();
  try {
    git("init", "-q");
    await writeFile(path.join(verifier, "verify.js"), "// Public checks.\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Verifier");
    const activity = {...datum("VFY", "activity"), payload: {repository_path: verifier, source_commit: git("rev-parse", "HEAD")}};
    const failed = {...datum("REV", "activity"), payload: {publication: "recorded", outcome: "fail", findings: "Weak oracle"}, links: [link("reviews", activity)]};
    const revised = {...activity, ...datum("VFY", "activity", 2), payload: activity.payload};
    const reviewed = await buildDirectReviewContext({...context, action: context.pkg.actions["review-verification"]!, subject: revised.revision_id, inputs: {activity: [revised.revision_id]}, data: [...context.data, activity, failed, revised]});
    expect(reviewed.lineage).toEqual({predecessors: [activity], answers: [], changes: [], decisions: [failed]});
  } finally { await rm(verifier, {recursive: true, force: true}); }
});

test("a first revision has no lineage and a missing answered review fails explicitly", async () => {
  const firstContext = {...context, subject: first.revision_id, inputs: {subject: [first.revision_id]}};
  expect(await buildDirectReviewContext(firstContext)).not.toHaveProperty("lineage");
  await expect(buildDirectReviewContext({...context, data: context.data.filter(d => d !== secondReview)})).rejects.toThrow(/Review lineage/);
});
