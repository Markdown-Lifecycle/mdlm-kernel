import { installedProcessPackageRoot } from "../src/installed-process-package.js";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, test, vi } from "vitest";
import { registerExternalReview, requireExternalReview, reviewDigest, reviewPacketDigest } from "../src/external-review.js";
import { validateDirectAuthority } from "../src/direct-authority.js";
import type { DirectReviewContext } from "../src/direct-review-context.js";
import type { DirectContext, DirectProposal } from "../src/direct-contract.js";

const identity = {reference:"fixture@1",digest:"fixture",language:"fixture"};
const action = {id:"review",version:1,kind:"action-definition" as const,capability:"review" as const,types:["REV"],prompt_ref:"fixture",authority:{kind:"independent-review" as const,name:"reviewer"}};
const reviewContext:DirectReviewContext = {contract:"mdlm-direct-review-context@1",package:identity,snapshot:"exact",action,inputs:{subject:["RQS-exact-r00001"]},prompt:"Review exact requirements",payloadSchemas:{},records:[],requirementGraphs:[],sourceScopes:[],sources:[],verificationReceipts:[]};
const candidates = [{localId:"verdict",type:"REV",payload:{outcome:"fail"},links:[],body:"A requirement is missing"}];

test("review registration preserves exact verdict bytes and refuses changed context or proposal reuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"mdlm-direct-review-"));
  const repository = path.join(root,"lifecycle"), registry = path.join(root,"registry");
  await mkdir(repository);await mkdir(registry);
  vi.stubEnv("MDLM_REVIEW_REGISTRY",registry);vi.stubEnv("MDLM_REVIEW_REGISTRAR","1");
  const source = JSON.stringify({operation:"review-1",candidates});
  const verdict = JSON.stringify({candidates});
  const id = "git-commit:fixture";
  try {
    await expect(requireExternalReview(repository,"review-1",reviewContext,id,source)).rejects.toThrow();
    const registered = await registerExternalReview(repository,"review-1",reviewContext,id,verdict,source);
    expect(registered.contract).toBe("mdlm-registered-review@3");
    expect(await requireExternalReview(repository,"review-1",reviewContext,id,source)).toEqual(registered);
    // ADR 0011: the binding ignores the whole-lifecycle snapshot but not the review's own context or repository.
    expect(await requireExternalReview(repository,"review-1",{...reviewContext,snapshot:"changed"},id,source)).toEqual(registered);
    await expect(requireExternalReview(repository,"review-1",{...reviewContext,inputs:{subject:["RQS-exact-r00002"]}},id,source)).rejects.toThrow("contextSha256");
    await expect(requireExternalReview(repository,"review-1",reviewContext,"git-commit:other",source)).rejects.toThrow("contextSha256");
    await expect(requireExternalReview(repository,"review-1",reviewContext,id,source+"\n")).rejects.toThrow("proposalSha256");
    await expect(registerExternalReview(repository,"review-2",reviewContext,id,JSON.stringify({candidates:[]}),source)).rejects.toThrow("exact verdict");
    // A registration written by an earlier kernel (@2) still binds the whole context, snapshot included.
    const legacy = {contract:"mdlm-registered-review@2",operation:"review-1",contextSha256:reviewPacketDigest(reviewContext),verdictSha256:reviewDigest(verdict),proposalSha256:reviewDigest(source)};
    const file = path.join(registry,`${reviewDigest(await realpath(repository))}-review-1.json`);
    await writeFile(file,`${JSON.stringify({...legacy,verdict})}\n`);
    expect(await requireExternalReview(repository,"review-1",reviewContext,id,source)).toEqual(legacy);
    await expect(requireExternalReview(repository,"review-1",{...reviewContext,snapshot:"changed"},id,source)).rejects.toThrow("contextSha256");
    vi.stubEnv("MDLM_REVIEW_REGISTRAR","0");
    await expect(registerExternalReview(repository,"review-2",reviewContext,id,verdict,source)).rejects.toThrow("manager");
  } finally {vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});

test("stakeholder decisions require exact supplied authority and cannot borrow reviewer proof", async () => {
  const pkg: DirectContext["pkg"] = {root:".",manifest:{id:"fixture",version:"1.0.0"},kernelCapabilities:{},envelopeSchema:{},templates:{},types:{},policies:{},states:{},selectors:{},primitives:{},actions:{}};
  const context: DirectContext = {root:".",pkg,package:identity,snapshot:"exact",data:[],inputs:{},action:{...action,id:"accept",capability:"acceptance",authority:{kind:"stakeholder",name:"stakeholder"}}};
  const proposal:DirectProposal = {operation:"decision",action:"accept@1",package:identity,snapshot:"exact",candidates:[]};
  await expect(validateDirectAuthority(context,proposal,JSON.stringify(proposal))).rejects.toThrow("explicit authority");
  const wrong = {...proposal,evidence:{authority:["reviewer"]}};
  await expect(validateDirectAuthority(context,wrong,JSON.stringify(wrong))).rejects.toThrow("differs");
  const borrowed = {...proposal,evidence:{authority:["stakeholder"],review:{proof:"reviewer"}}};
  await expect(validateDirectAuthority(context,borrowed,JSON.stringify(borrowed))).rejects.toThrow("cannot supply");
  const supplied = {...proposal,evidence:{authority:["stakeholder"]}};
  expect(await validateDirectAuthority(context,supplied,JSON.stringify(supplied))).toMatchObject({kind:"stakeholder",source:"authority-supply"});
});

test("review output schema omits managed fields while records keep their computed values", async () => {
  const {loadProcessPackage, resolveType} = await import("../src/index.js");
  const {buildDirectReviewContext} = await import("../src/direct-review-context.js");
  const loaded = await loadProcessPackage(installedProcessPackageRoot("tiny"));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  const record = {id: "REV-prior", revision: 1, revision_id: "REV-prior-r00001", type: "REV", payload: {scope_amendment_required: true}, links: [], body: "Prior judgment", created_by: {process_ref: "fixture"}};
  const context = await buildDirectReviewContext({root: ".", pkg: loaded.package, package: identity, snapshot: "fixture", action: loaded.package.actions["review-requirements"]!, data: [record], inputs: {prior: [record.revision_id]}});
  expect(context.payloadSchemas.REV).not.toHaveProperty("properties.scope_amendment_required");
  expect(context.payloadSchemas.REV).toHaveProperty("properties.publication");
  expect(context.records).toEqual([record]);
  expect(context.records[0]!.payload.scope_amendment_required).toBe(true);
  const full = resolveType(loaded.package, "REV");
  expect(full.ok && full.type.payloadSchema.properties).toHaveProperty("scope_amendment_required");
});


test("fixed review evidence accepts multiple exact inputs and rejects missing, foreign or duplicate links", async () => {
  const {validateFixedContextLinks} = await import("../src/direct-proposal.js");
  const required=[{type:"uses-evidence",target:"RES-first-r00001"},{type:"uses-evidence",target:"RES-second-r00001"}];
  expect(()=>validateFixedContextLinks([...required].reverse(),required)).not.toThrow();
  for(const links of [required.slice(0,1),[...required,{type:"uses-evidence",target:"RES-foreign-r00001"}],[...required,required[0]!]]) expect(()=>validateFixedContextLinks(links,required)).toThrow("exact inputs");
});
