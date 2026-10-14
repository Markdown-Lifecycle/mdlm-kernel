import { installedProcessPackageRoot } from "../src/installed-process-package.js";
import path from "node:path";
import { expect, test } from "vitest";
import { loadProcessPackage, type DatumEnvelope } from "../src/index.js";
import { requirementAuthoringTargets } from "../src/direct-guidance.js";
import { assessRequirements, validateChangeDatum } from "../src/change-assessment.js";
import { deriveImplementationScopes, requirementTraceBinding } from "../src/requirement-trace.js";
import { finalizeDirectDomain } from "../src/direct-domain.js";
import type { DirectFinalizationContext } from "../src/direct-contract.js";

const datum = (type: string, n: number, revision = 1): DatumEnvelope => {
  const id = `${type}-${String(n).padStart(10, "0")}`;
  return {id, type, revision, revision_id: `${id}-r${String(revision).padStart(5,"0")}`, payload: {}, links: [], body: "Fixture", created_by: {process_ref: "test"}};
};
async function context(data: DatumEnvelope[], outputs: DatumEnvelope[]): Promise<DirectFinalizationContext> {
  const loaded = await loadProcessPackage(path.join(installedProcessPackageRoot("tiny")));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  const identity = {reference: "fixture@1", digest: "fixture", language: "fixture"};
  const action = {id: "requirements", version: 1, kind: "action-definition" as const, capability: "requirements" as const, types: ["REQ", "DCP", "RQS"], prompt_ref: "fixture"};
  return {root: ".", pkg: loaded.package, package: identity, snapshot: "fixture", data, action, inputs: {}, outputs,
    proposal: {operation: "domain-fixture", action: action.id, package: identity, snapshot: "fixture", candidates: []}};
}

test("atomic graph derives membership and revises group endpoints without revising unchanged children", async () => {
  const parent = {...datum("REQ",1), payload: {kind: "stakeholder"}};
  const child = {...datum("REQ",2), payload: {kind: "software"}};
  const group = {...datum("DCP",1), links: [{type: "parent", target: parent.revision_id}, {type: "child", target: child.revision_id}]};
  const set = datum("RQS",1);
  const input = [parent, child, group, set];
  const before = JSON.stringify(input);
  const initial = await finalizeDirectDomain(await context([], input));
  expect(JSON.stringify(input)).toBe(before);
  expect(initial.outputs.find(d => d.type === "RQS")?.links).toEqual(expect.arrayContaining([
    {type:"contains",target:child.revision_id}, {type:"decomposition",target:group.revision_id},
  ]));
  const revised = {...parent, revision:2, revision_id:`${parent.id}-r00002`, body:"Clarified stakeholder intention"};
  const nextSet = {...set, revision:2, revision_id:`${set.id}-r00002`};
  const next = await finalizeDirectDomain(await context(initial.outputs,[revised,nextSet]));
  expect(next.outputs.filter(d=>d.type === "REQ")).toEqual([revised]);
  expect(next.outputs.find(d=>d.type === "DCP")).toMatchObject({id:group.id,revision:2,links:expect.arrayContaining([
    {type:"parent",target:revised.revision_id},{type:"child",target:child.revision_id},
  ])});
  expect(initial.outputs.find(d=>d.type === "DCP")?.links[0]?.target).toBe(parent.revision_id);
});

test("authored source scopes and generated membership cannot bypass the deriving service", async () => {
  const set = datum("RQS",1);
  await expect(finalizeDirectDomain(await context([], [set,datum("SCP",1)]))).rejects.toThrow("trace-generated-output");
  set.links = [{type:"contains",target:"REQ-invented-r00001"}];
  await expect(finalizeDirectDomain(await context([], [set]))).rejects.toThrow("trace-generated-selection");
});

test("implementation requirement findings derive scope amendment through their exact selection", async () => {
  const parent = {...datum("REQ", 1), payload: {kind: "stakeholder"}};
  const child = {...datum("REQ", 2), payload: {kind: "software"}};
  const group = {...datum("DCP", 1), links: [{type: "parent", target: parent.revision_id}, {type: "child", target: child.revision_id}]};
  const set = {...datum("RQS", 1), links: [{type: "contains", target: parent.revision_id}, {type: "contains", target: child.revision_id}, {type: "decomposition", target: group.revision_id}]};
  const baselineProduct = {...datum("IMP", 1), links: [{type: "implements", target: set.revision_id}]};
  const baseline = {...datum("ACC", 1), payload: {decision: "accept"}, links: [{type: "confirms", target: set.revision_id}, {type: "accepts", target: baselineProduct.revision_id}]};
  const change = {...datum("CHG", 1), links: [{type: "baseline", target: baseline.revision_id}, {type: "changes", target: child.revision_id}]};
  const approval = {...datum("REV", 1), payload: {outcome: "pass"}, links: [{type: "reviews", target: change.revision_id}]};
  const current = {...set, revision: 2, revision_id: `${set.id}-r00002`, links: [...set.links, {type: "changes-under", target: change.revision_id}]};
  const product = {...datum("IMP", 1, 2), links: [{type: "implements", target: current.revision_id}, {type: "changes-under", target: change.revision_id}]};
  const data = [parent, child, group, set, baselineProduct, baseline, change, approval, current, product];
  for (const target of [parent, child]) {
    const review = {...datum("REV", 2), payload: {outcome: "fail", source_assessments: [], requirement_assessments: [{requirement: target.revision_id, disposition: "needs-change"}]}, links: [{type: "reviews", target: product.revision_id}]};
    const ctx = await context(data, [review]); ctx.action = {...ctx.action, capability: "review", types: ["REV"]};
    const finalized = await finalizeDirectDomain(ctx);
    expect(finalized.outputs[0]?.payload.scope_amendment_required).toBe(target === parent);
    expect(review.payload).not.toHaveProperty("scope_amendment_required");
  }
});


test("initial late implementation correction admits only the exact marked requirement", async () => {
  const loaded = await loadProcessPackage(path.join(installedProcessPackageRoot("iterative")));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  const parent = {...datum("REQ", 1), payload: {kind: "stakeholder"}};
  const marked = {...datum("REQ", 2), payload: {kind: "software"}};
  const peer = {...datum("REQ", 3), payload: {kind: "software"}};
  const group = {...datum("DCP", 1), links: [{type: "parent", target: parent.revision_id}, ...[marked, peer].map(r => ({type: "child", target: r.revision_id}))]};
  const set = {...datum("RQS", 1), links: [...[parent, marked, peer].map(r => ({type: "contains", target: r.revision_id})), {type: "decomposition", target: group.revision_id}]};
  const product = {...datum("IMP", 1), links: [{type: "implements", target: set.revision_id}]};
  const review = {...datum("REV", 1), payload: {outcome: "fail", requirement_assessments: [{requirement: marked.revision_id, disposition: "needs-change"}]}, links: [{type: "reviews", target: product.revision_id}]};
  const data = [parent, marked, peer, group, set, product, review];
  const revised = {...marked, revision: 2, revision_id: `${marked.id}-r00002`, body: "Require station acknowledgement."};
  const unmarked = {...peer, revision: 2, revision_id: `${peer.id}-r00002`, body: "Hide awaiting events."};
  const successor = {...datum("RQS", 1, 2), links: [{type: "corrects", target: review.revision_id}]};
  const ctx = await context(data, [revised, successor]);
  ctx.pkg = loaded.package; ctx.action = loaded.package.actions["correct-requirements-after-review"]!;
  ctx.subject = set.revision_id; ctx.inputs = {subject: [set.revision_id], failure: [review.revision_id]};
  const before = JSON.stringify(ctx);
  expect(requirementAuthoringTargets(ctx)).toMatchObject({selection: set.revision_id, failure: review.revision_id, frontier: {requirements: [marked.revision_id], groups: []}});
  const finalized = await finalizeDirectDomain(ctx);
  expect(finalized.outputs.find(d => d.type === "RQS")?.links).toEqual(expect.arrayContaining([{type: "contains", target: revised.revision_id}, {type: "contains", target: peer.revision_id}]));
  await expect(finalizeDirectDomain({...ctx, outputs: [revised, unmarked, successor]})).rejects.toThrow("change-frontier");
  expect(JSON.stringify(ctx)).toBe(before);
  // Ordinary initial refinement remains flexible; this limit belongs to the exact late failure.
  await expect(finalizeDirectDomain({...ctx, action: loaded.package.actions["refine-requirements"]!, inputs: {subject: [set.revision_id]}, outputs: [revised, unmarked, {...successor, links: []}]})).resolves.toBeDefined();
  const binding = requirementTraceBinding(loaded.package)!;
  const selected = finalized.outputs.find(d => d.type === "RQS")!;
  const successorProduct = {...datum("IMP", 1, 2), links: [{type: "implements", target: selected.revision_id}]};
  const acceptance = {...datum("ACC", 1), payload: {decision: "accept"}, links: [{type: "confirms", target: selected.revision_id}, {type: "accepts", target: successorProduct.revision_id}]};
  expect(validateChangeDatum([...data, ...finalized.outputs, successorProduct, acceptance], binding, selected)).toEqual([]);
});

test('review recovery rejects foreign targets, ordinary authors, accepted and stale subjects', async () => {
  const loaded = await loadProcessPackage(installedProcessPackageRoot('iterative'));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  const requirement = {...datum('REQ', 91), payload: {kind: 'stakeholder'}};
  const set = {...datum('RQS', 91), links: [{type: 'contains', target: requirement.revision_id}]};
  const failure = {...datum('REV', 91), payload: {outcome: 'fail'}, links: [{type: 'reviews', target: set.revision_id}]};
  const replacement = {...datum('REV', 92), payload: {outcome: 'fail', correction_reason: 'Acknowledged wrong allocation', requirement_assessments: [{requirement: requirement.revision_id, disposition: 'needs-change', rationale: 'Fixture'}], decomposition_assessments: []}, links: [{type: 'reviews', target: set.revision_id}, {type: 'supersedes', target: failure.revision_id}]};
  const ctx = await context([requirement, set, failure], [replacement]);
  ctx.pkg = loaded.package; ctx.action = loaded.package.actions['correct-requirements-review']!;
  ctx.subject = set.revision_id; ctx.inputs = {subject: [set.revision_id], failure: [failure.revision_id]};
  await expect(finalizeDirectDomain(ctx)).resolves.toBeDefined();
  await expect(finalizeDirectDomain({...ctx, action: loaded.package.actions['review-requirements']!})).rejects.toThrow('review-correction-action');
  const foreign = {...failure, id: 'REV-FOREIGN', revision_id: 'REV-FOREIGN-r00001', links: [{type: 'reviews', target: 'RQS-FOREIGN-r00001'}]};
  const foreignOutput = {...replacement, links: [replacement.links[0]!, {type: 'supersedes', target: foreign.revision_id}]};
  await expect(finalizeDirectDomain({...ctx, data: [...ctx.data, foreign], inputs: {...ctx.inputs, failure: [foreign.revision_id]}, outputs: [foreignOutput]})).rejects.toThrow('review-correction-target');
  await expect(finalizeDirectDomain({...ctx, outputs: [{...replacement, payload: {...replacement.payload, requirement_assessments: [{requirement: 'REQ-FOREIGN-r00001', disposition: 'needs-change', rationale: 'Unauthorized scope'}]}}]})).rejects.toThrow('change-review-coverage');
  const accepted = {...datum('ACC', 91), payload: {decision: 'accept'}, links: [{type: 'confirms', target: set.revision_id}]};
  await expect(finalizeDirectDomain({...ctx, data: [...ctx.data, accepted]})).rejects.toThrow('review-correction-stale');
  const stale = {...set, revision: 2, revision_id: `${set.id}-r00002`};
  await expect(finalizeDirectDomain({...ctx, data: [...ctx.data, stale]})).rejects.toThrow('review-correction-stale');
  await expect(finalizeDirectDomain({...ctx, outputs: [{...replacement, payload: {...replacement.payload, correction_reason: ' '}}]})).rejects.toThrow('review-correction-reason');
});

test("staged packages publish partial graphs, elaborate one group additively and implement only complete graphs", async () => {
  const loaded = await loadProcessPackage(installedProcessPackageRoot("iterative"));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  const {authority: _, ...refine} = loaded.package.actions["refine-requirements"]!;
  const elaborate = {...refine, id: "elaborate-requirements"};
  const pkg = {...loaded.package, actions: {...loaded.package.actions, [elaborate.id]: elaborate}, kernelCapabilities: {...loaded.package.kernelCapabilities, "staged-requirements@1": {type: "RQS", action: elaborate.id}}};
  const root = {...datum("REQ", 1), payload: {kind: "stakeholder"}};
  const draft = await context([], [root, datum("RQS", 1)]);
  const {"staged-requirements@1": _staged, ...unstaged} = loaded.package.kernelCapabilities;
  draft.pkg = {...loaded.package, kernelCapabilities: unstaged};
  await expect(finalizeDirectDomain(draft)).rejects.toThrow("trace-stakeholder-uncovered");
  const initial = await finalizeDirectDomain({...draft, pkg});
  const set = initial.outputs.find(d => d.type === "RQS")!;
  expect(set.payload.trace_complete).toBe(false);
  const pass = {...datum("REV", 1), payload: {outcome: "pass", requirement_assessments: [{requirement: root.revision_id, disposition: "valid"}], decomposition_assessments: []}, links: [{type: "reviews", target: set.revision_id}]};
  const data = [...initial.outputs, pass];
  const child = {...datum("REQ", 2), payload: {kind: "software"}};
  const group = {...datum("DCP", 1), links: [{type: "parent", target: root.revision_id}, {type: "child", target: child.revision_id}]};
  const successor = datum("RQS", 1, 2);
  const ctx = {...await context(data, [child, group, successor]), pkg, action: elaborate, subject: set.revision_id, inputs: {subject: [set.revision_id]}};
  const elaborated = await finalizeDirectDomain(ctx);
  const next = elaborated.outputs.find(d => d.type === "RQS")!;
  expect(next.payload.trace_complete).toBe(true);
  // The next review assesses only the added rows; the passed root keeps its credit.
  expect(assessRequirements([...data, ...elaborated.outputs], requirementTraceBinding(pkg)!, next)).toMatchObject({requirements: [child.revision_id], groups: [{revision: group.revision_id, parent: root.revision_id, children: [child.revision_id]}]});
  const reworded = {...root, revision: 2, revision_id: `${root.id}-r00002`, body: "Reworded"};
  await expect(finalizeDirectDomain({...ctx, outputs: [reworded, child, {...group, links: [{type: "parent", target: reworded.revision_id}, group.links[1]!]}, successor]})).rejects.toThrow("staged-elaboration-preserve");
  const second = {...datum("REQ", 3), payload: {kind: "software"}};
  await expect(finalizeDirectDomain({...ctx, outputs: [child, second, group, {...datum("DCP", 2), links: [{type: "parent", target: child.revision_id}, {type: "child", target: second.revision_id}]}, successor]})).rejects.toThrow("staged-elaboration-group");
  await expect(finalizeDirectDomain({...ctx, outputs: [{...group, links: [group.links[0]!]}, successor]})).rejects.toThrow("staged-elaboration-group");
  // A later group may reuse a passed requirement as a shared child without revising it.
  const sibling = {...datum("REQ", 4), payload: {kind: "software"}};
  const wide = await finalizeDirectDomain({...ctx, outputs: [child, sibling, {...group, links: [...group.links, {type: "child", target: sibling.revision_id}]}, successor]});
  const wideSet = wide.outputs.find(d => d.type === "RQS")!;
  const passWide = {...datum("REV", 2), payload: {outcome: "pass"}, links: [{type: "reviews", target: wideSet.revision_id}]};
  const leaf = {...datum("REQ", 5), payload: {kind: "software"}};
  const shared = {...datum("DCP", 2), links: [{type: "parent", target: child.revision_id}, {type: "child", target: leaf.revision_id}, {type: "child", target: sibling.revision_id}]};
  const deeper = {...ctx, data: [...data, ...wide.outputs, passWide], subject: wideSet.revision_id, inputs: {subject: [wideSet.revision_id]}};
  await expect(finalizeDirectDomain({...deeper, outputs: [leaf, shared, datum("RQS", 1, 3)]})).resolves.toBeDefined();
  const product = {...datum("IMP", 1), payload: {repository_path: ".", source_commit: "0".repeat(40)}, links: [{type: "implements", target: set.revision_id}]};
  expect((await deriveImplementationScopes(product, data, requirementTraceBinding(pkg)!)).diagnostics.map(d => d.code)).toContain("trace-stakeholder-uncovered");
});
