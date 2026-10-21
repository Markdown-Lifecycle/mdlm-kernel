import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { resolveType, type DatumEnvelope } from "./index.js";
import type { DirectAction, DirectCandidate, DirectContext, DirectProposal, DirectTransaction, DirectWorkItem, DirectProposalResult } from "./direct-contract.js";
import { selectedRepositoryPackage } from "./selected-package.js";
import { readRepositoryData, publishTransactionData, provisionalLifecycleRecord, payloadSchemaDiagnostics } from "./lifecycle-repository.js";
import { withRepositoryLock } from "./repository-lock.js";
import { resolvePrompt } from "./direct-prompt.js";
import { evaluateExpressionValue } from "./evaluator.js";
import { compileExpressionValue } from "./expression.js";
import { finalizeDirectDomain } from "./direct-domain.js";
import { validateDirectAuthority, buildDirectReviewContext, registerDirectReview } from "./direct-authority.js";
import { readVerificationReceiptBlob, requireCoherentVerificationResult, validateVerificationReceipt, type VerificationBinding, runVerificationReceipt, verificationRef } from "./verification-receipt.js";
import { repositoryGitEnvironment } from "./git-environment.js";
import { requirementTraceBinding } from "./requirement-trace.js";
import { authorablePayloadSchema, sourceAssessmentTargets, requirementAuthoringTargets } from "./direct-guidance.js";

import { independentBinding, independentExecutionBinding, selectedActivities, verificationAuthoringContext, verificationStatus, currentVerificationResults } from "./independent-verification.js";

import { historicalApplicability, validateCurrentHistoricalResults } from "./verification-applicability.js";

const exec = promisify(execFile);
export const directDigest = (source: string) => `sha256:${createHash("sha256").update(source).digest("hex")}`;
const digest = (value: unknown) => directDigest(JSON.stringify(value));
const lock = "refs/mdlm/transaction-lock";
const txId = (operation: string) => `direct-${createHash("sha256").update(operation).digest("hex")}`;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(message: string): never { throw new Error(message); }
function checkOperation(operation: string) { if (!/^[a-zA-Z0-9-]{1,80}$/.test(operation)) fail("Invalid operation identity"); }
export async function directState(root: string) {
  const selected = await selectedRepositoryPackage(root);
  if (!selected.ok) fail(JSON.stringify(selected.diagnostics));
  const loaded = await readRepositoryData(root, selected.processPackage);
  if (!loaded.ok) fail(JSON.stringify(loaded.diagnostics));
  const data = loaded.value.map(p => p.lifecycleDatum.datum).sort((a,b) => a.revision_id.localeCompare(b.revision_id));
  const {reference,digest: packageDigest,language} = selected.summary;
  const identity = {reference,digest:packageDigest,language};
  const repository = await repositoryIdentity(root);
  return {root,pkg:selected.processPackage,package:identity,repository,snapshot:digest({package:identity,repository,data}),data,parsed:loaded.value,authoringSelections:selected.authoringSelections ?? []};
}
/** The first-parent root commit identifies one lifecycle repository lineage; `mdlm init` makes it unique with a nonce. */
async function repositoryIdentity(root: string) {
  const roots = (await git(root,["rev-list","--first-parent","--max-parents=0","HEAD"]).catch(()=>"")).split("\n").filter(Boolean);
  if (roots.length !== 1 || !/^[a-f0-9]{40,64}$/.test(roots[0]!)) fail("Lifecycle repository identity requires one initial commit");
  return `git-commit:${roots[0]}`;
}
type State = Awaited<ReturnType<typeof directState>>;
function snapshot(current: State) { return {processRef:`${current.package.reference}#${current.package.digest}`,records:current.parsed.map(p=>p.lifecycleDatum),dependencyComparisons:[]}; }
function expression(current: State, value: unknown, subject?: string): unknown {
  const bindings = subject ? {subject} : {};
  let compiled = value;
  if (typeof value === "string") {
    const result = compileExpressionValue(value, current.pkg, subject ? {subject:"entity"} : {});
    if (!result.expression) fail(JSON.stringify(result.diagnostics));
    compiled = result.expression;
  }
  return evaluateExpressionValue(current.pkg,snapshot(current),compiled,bindings);
}
function revision(value: any): string | undefined { return typeof value === "string" ? value : value?.identity?.revision_id ?? value?.revision_id; }
function values(value: unknown): string[] { return (Array.isArray(value)?value:value==null?[]:[value]).map(revision).filter((v):v is string=>!!v); }
function actionRef(action: DirectAction) { return `${action.id}@${action.version}`; }
function resolveAction(current: State, ref: string) {
  const [id,version] = ref.split("@");
  const action = current.pkg.actions[id!];
  if (!action || (version !== undefined && Number(version)!==action.version)) fail("Unknown package action or version");
  return action;
}
function available(current: State) {
  const items: DirectWorkItem[]=[];
  for (const action of Object.values(current.pkg.actions)) {
    const subjects: (string|undefined)[] = action.subjects === undefined ? [undefined] : values(expression(current,action.subjects));
    for (const subject of subjects) {
      if (action.when !== undefined && expression(current,action.when,subject)!==true) continue;
      const inputs = Object.fromEntries(Object.entries(action.inputs??{}).map(([name,value])=>[name,values(expression(current,value,subject))]));
      items.push({action:actionRef(action),...(subject?{subject}:{}),reason:action.description??action.id,inputs,...(action.optional?{optional:true}:{}),priority:action.priority??0});
    }
  }
  return items.sort((a,b)=>(a.priority??0)-(b.priority??0)||a.action.localeCompare(b.action)||(a.subject??"").localeCompare(b.subject??""));
}
export function directContext(current: State, reference: string, subject?: string): DirectContext {
  const action=resolveAction(current,reference);
  const work=available(current).find(item=>item.action===actionRef(action)&&item.subject===subject);
  if (!work) fail("This action is not currently eligible for this exact subject; refresh expectations");
  return {root:current.root,pkg:current.pkg,package:current.package,snapshot:current.snapshot,data:current.data,authoringSelections:current.authoringSelections,action,...(subject?{subject}:{}),inputs:work.inputs??{}};
}
/** Every fixed relation selects the exact complete input set, including multiplicity. */
export function validateFixedContextLinks(links: DatumEnvelope["links"], required: DatumEnvelope["links"]) {
  for (const type of new Set(required.map(l=>l.type))) {
    const expected=required.filter(l=>l.type===type).map(l=>l.target).sort();
    const actual=links.filter(l=>l.type===type).map(l=>l.target).sort();
    if (!isDeepStrictEqual(actual,expected)) fail("Candidate context links differ from the declared exact inputs");
  }
}
function fixedLinks(context: DirectContext,type: string) {
  const rules=context.action.links?.[type]??{};
  return Object.entries(rules).flatMap(([link,input])=>(context.inputs[input]??[]).map(target=>({type:link,target})));
}
async function guidance(current: State,ref: string,subject?: string) {
  const context=directContext(current,ref,subject);
  const prompt=await resolvePrompt(current.pkg,context.action.prompt_ref);
  if (!prompt.prompt || prompt.diagnostics.length) fail(JSON.stringify(prompt.diagnostics));
  const schemas:Record<string,unknown>={}; const candidates:DirectCandidate[]=[];
  const trace=current.pkg.kernelCapabilities["requirement-trace@4"]??current.pkg.kernelCapabilities["requirement-trace@3"]??current.pkg.kernelCapabilities["requirement-trace@2"]??current.pkg.kernelCapabilities["requirement-trace@1"];
  for (const type of context.action.types) {
    if (type===trace?.scope_type) continue;
    const resolved=resolveType(current.pkg,type); if(!resolved.ok) fail(JSON.stringify(resolved.diagnostics));
    schemas[type]=authorablePayloadSchema(resolved.type);
    const predecessorInput=context.action.revises?.[type];
    const predecessor=predecessorInput?context.inputs[predecessorInput]?.[0]:undefined;
    candidates.push({localId:type.toLowerCase(),type,...(predecessor?{predecessor}:{}),payload:{...(context.action.fixed_payload?.[type]??{})},links:fixedLinks(context,type),body:""});
  }
  const execution=(["verification-result","independent-result"].includes(context.action.capability) || (context.action.capability === "observation" && !independentBinding(context.pkg)));
  const implementation=execution?executionSubject(context):undefined;
  return {ok:true,contract:"mdlm-direct-guidance@1",action:actionRef(context.action),...(subject?{subject}:{}),package:current.package,snapshot:current.snapshot,inputs:context.inputs,prompt:prompt.prompt,payloadSchemas:schemas,sourceAssessmentTargets:sourceAssessmentTargets(context),requirementAuthoringTargets:requirementAuthoringTargets(context),context:current.data.filter(d=>Object.values(context.inputs).flat().includes(d.revision_id)||d.revision_id===subject),candidates,effectiveAuthority:context.action.authority??{kind:"autonomous"},...(context.action.authority?{authority:context.action.authority}:{}),...(context.action.capability === "independent-result" && current.pkg.kernelCapabilities["verification-applicability@1"] ? {historicalEvidenceMode: {field: "evidence.historicalResult", instruction: "Explicit original execution RES on an earlier IMP of this lineage; every later revision selection-only, unchanged source/attribution/requirements/exact method. Omit evidence.receipt. Kernel derives historical_observation; current independent review may require fresh execution."}} : {}),...(implementation?{executionSubject:implementation.revision_id,executionCommand:`mdlm execution run ${implementation.revision_id} <operation>${independentBinding(current.pkg)?" --activity <exact-VFY>":""} --json`,evidence:await availableReceipts(current,implementation),receiptDetails:await receiptDetails(current,implementation)}:{})};
}
export async function inspectDirectExpectations(root:string,action?:string,subject?:string) {
  const current=await directState(root);
  if(action) return guidance(current,action,subject);
  return directExpectations(current);
}
export function directExpectations(current: State) {
  const all=available(current); const items=all.filter(i=>!i.optional); const optional=all.filter(i=>i.optional);
  const terminal=current.pkg.manifest.terminal as {when?:unknown;outcome?:string}|undefined;
  const completed=terminal?.when!==undefined && expression(current,terminal.when)===true;
  return {ok:true,contract:"mdlm-expectations@2",package:current.package,snapshot:current.snapshot,items,optional,outcome:completed?(terminal?.outcome??"profile-boundary-reached"):items.length?"work-available":"blocked"};
}
/**
 * A revision draft starts from its predecessor's authored payload and body. It carries a predecessor link only when
 * the author owns that relation and its target is still current. Verification activities also retain exact interface
 * revisions required by their carried targets. Not carried: relations any package action fixes for
 * the type (context such as corrects or responds-to, supplied fresh from this action's inputs), relations the kernel
 * generates for requirement tracing, and product verification selections, which need a fresh author choice unless
 * the action keeps the predecessor's exact context, as a selection-only revision does.
 */
function carryPredecessors(current: State, candidates: DirectCandidate[], action: DirectContext["action"]) {
  const kernelRelations = new Set([
    ...(requirementTraceBinding(current.pkg) ? ["contains", "decomposition", "retires", "changes-under", "baseline"] : []),
    ...(independentBinding(current.pkg) ? ["verification"] : []),
  ]);
  const latest = (target: string) => {
    const datum = current.data.find(d => d.revision_id === target);
    return !!datum && !current.data.some(d => d.id === datum.id && d.revision > datum.revision);
  };
  for (const candidate of candidates) {
    const prior = current.data.find(datum => datum.revision_id === candidate.predecessor && datum.type === candidate.type);
    if (!prior) continue;
    const resolved = resolveType(current.pkg, candidate.type); if (!resolved.ok) fail(JSON.stringify(resolved.diagnostics));
    const payload = structuredClone(prior.payload);
    for (const field of resolved.type.kernelManagedPayloadPaths) delete payload[field];
    const contextRelations = new Set(Object.values(current.pkg.actions).flatMap(action => Object.keys(action.links?.[candidate.type] ?? {})));
    const sameContext = candidate.links.every(link => prior.links.some(carried => carried.type === link.type && carried.target === link.target));
    const selection = (link: {type: string}) => sameContext && link.type === "verification" && kernelRelations.has(link.type) && !(link.type in (action.links?.[candidate.type] ?? {}));
    const authoredLinks = prior.links.filter(link => selection(link) || (!contextRelations.has(link.type) && !kernelRelations.has(link.type)));
    const carriedLinks = authoredLinks.filter(link => latest(link.target));
    const requiredInterfaces = new Set(candidate.type === independentBinding(current.pkg)?.type
      ? [...candidate.links, ...carriedLinks].filter(link => link.type === "verifies").flatMap(link =>
        current.data.find(datum => datum.revision_id === link.target)?.links.filter(link => link.type === "uses-interface").map(link => link.target) ?? [])
      : []);
    candidate.payload = {...payload, ...candidate.payload};
    candidate.links = [...candidate.links, ...authoredLinks.filter(link => latest(link.target) || (link.type === "uses-interface" && requiredInterfaces.has(link.target))).map(link => ({...link}))];
    candidate.body = prior.body;
  }
}
export async function draftDirectProposal(root: string, action: string, subject: string | undefined, operation: string, activity?: string): Promise<DirectProposal> {
  const current = await directState(root);
  const selected = await guidance(current, action, subject);
  const context = directContext(current, action, subject), binding = independentBinding(current.pkg);
  carryPredecessors(current, selected.candidates, context.action);
  if (activity === undefined && context.action.capability === "independent-result" && binding) {
    const activities = selectedActivities(current, executionSubject(context));
    if (activities.length === 1) activity = activities[0]!.revision_id;
  }
  if (activity !== undefined) {
    if (context.action.capability !== "independent-result" || !binding) fail("--activity requires an independent-result action");
    if (!selectedActivities(current, executionSubject(context)).some(candidate => candidate.revision_id === activity)) fail("Draft activity must belong to the subject's selected verification activities");
    const results = selected.candidates.filter(candidate => candidate.type === binding.result_type);
    if (results.length !== 1) fail("Activity draft requires one capability-bound result candidate");
    const result = results[0]!, existing = result.links.filter(link => link.type === "evaluates");
    if (existing.length && (existing.length !== 1 || existing[0]!.target !== activity)) fail("Draft activity conflicts with fixed evaluates links");
    if (!existing.length) result.links.push({type: "evaluates", target: activity});
  }
  return {
    operation, action: selected.action, package: selected.package, snapshot: selected.snapshot,
    ...(selected.subject ? {subject: selected.subject} : {}), inputs: selected.inputs, candidates: selected.candidates,
    ...(selected.authority?.kind === "stakeholder" ? {evidence: {authority: [selected.authority.name]}} : {}),
  };
}
export function parseDirectProposal(source:string):DirectProposal {
  const p:unknown=JSON.parse(source);
  if(!object(p)||Object.keys(p).some(k=>!["operation","action","package","snapshot","subject","inputs","candidates","evidence"].includes(k))||typeof p.operation!=="string"||typeof p.action!=="string"||!object(p.package)||typeof p.snapshot!=="string"||!Array.isArray(p.candidates)||!p.candidates.length) fail("Expected operation, action, exact package/snapshot and candidate batch");
  checkOperation(p.operation);
  p.candidates.forEach((c:unknown,index:number)=>{
    const location=`candidates[${index}]`;
    function invalid(field:string,expected:string):never { fail(`Invalid candidate datum at ${location}${field}: ${expected}`); }
    if(!object(c)) invalid("","expected object");
    for(const key of Object.keys(c)) if(!["localId","type","predecessor","payload","links","body"].includes(key)) invalid(`.${key}`,"unexpected field");
    if(typeof c.localId!=="string"||!/^[a-zA-Z0-9_-]+$/.test(c.localId)) invalid(".localId","expected string matching /^[a-zA-Z0-9_-]+$/");
    if(typeof c.type!=="string") invalid(".type","expected string");
    if(!object(c.payload)) invalid(".payload","expected object");
    if(!Array.isArray(c.links)) invalid(".links","expected array");
    c.links.forEach((l:unknown,linkIndex:number)=>{
      if(!object(l)||typeof l.type!=="string"||typeof l.target!=="string"||Object.keys(l).some(k=>!["type","target"].includes(k))) invalid(`.links[${linkIndex}]`,"expected an object containing only string fields type and target");
    });
    if(typeof c.body!=="string") invalid(".body","expected string");
    if(c.predecessor!==undefined&&typeof c.predecessor!=="string") invalid(".predecessor","expected string when supplied");
  });
  return p as DirectProposal;
}
async function settlement(root:string,operation:string) {
  checkOperation(operation);const id=txId(operation);
  let tx:DirectTransaction;
  try {tx=JSON.parse(await fs.readFile(path.join(root,".lifecycle/data/.transactions",id,"execution.json"),"utf8"));} catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
  const current=await directState(root);
  if(tx.contract!=="mdlm-direct-transaction@1"||tx.operation!==operation||tx.id!==id||!tx.outputs.every(d=>current.data.some(existing=>isDeepStrictEqual(existing,d)))) fail("Settlement does not authenticate the published transaction");
  return {tx,result:{ok:true,contract:"mdlm-proposal-result@2",operation,outcome:"accepted",transaction:id,revisions:tx.outputs.map(d=>d.revision_id),proposalDigest:tx.proposalDigest} as DirectProposalResult};
}
export async function inspectDirectSettlement(root:string,operation:string){return (await settlement(root,operation))?.result??{ok:true,contract:"mdlm-proposal-result@2",operation,outcome:"not-published"};}
function outputData(context:DirectContext,proposal:DirectProposal,promptSkills:string[]):DatumEnvelope[]{
  if(!["requirements","verification-activity"].includes(context.action.capability)&&proposal.candidates.length!==1)fail("This action publishes exactly one authored datum; generated supporting data remain atomic");
  const identities=new Map<string,{id:string;revision:number;revision_id:string}>();
  for(const c of proposal.candidates){
    if(identities.has(c.localId)||!context.action.types.includes(c.type))fail("Duplicate local identity or undeclared output type");
    const prior=c.predecessor?context.data.find(d=>d.revision_id===c.predecessor):undefined;
    if(c.predecessor&&(!prior||prior.type!==c.type||context.data.some(d=>d.id===prior.id&&d.revision>prior.revision)))fail("Revision requires its exact latest predecessor of the same type");
    const expectedInput=context.action.revises?.[c.type];
    if(expectedInput&&c.predecessor!==context.inputs[expectedInput]?.[0])fail("Candidate must revise the exact declared subject lineage");
    const id=prior?.id??`${c.type}-${createHash("sha256").update(`${proposal.operation}\0${c.localId}`).digest("hex").slice(0,12).toUpperCase()}`;
    const rev=(prior?.revision??0)+1;identities.set(c.localId,{id,revision:rev,revision_id:`${id}-r${String(rev).padStart(5,"0")}`});
  }
  const resolve=(v:unknown):any=>{if(typeof v==="string"&&v.startsWith("$")){const match=/^\$([a-zA-Z0-9_-]+)(\.id)?$/.exec(v);if(!match)return v;const id=identities.get(match[1]!);if(!id)fail("Unknown candidate local reference");return match[2]?id.id:id.revision_id;}if(Array.isArray(v))return v.map(resolve);if(object(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,resolve(x)]));return v;};
  return proposal.candidates.map(c=>{
    const resolved=resolveType(context.pkg,c.type);if(!resolved.ok)fail(JSON.stringify(resolved.diagnostics));
    if(resolved.type.kernelManagedPayloadPaths.some(k=>k in c.payload))fail("Candidate may not author kernel-managed payload");
    const links=resolve(c.links) as DatumEnvelope["links"];
    validateFixedContextLinks(links,fixedLinks(context,c.type));
    const fixed=context.action.fixed_payload?.[c.type]??{};
    for(const [k,v]of Object.entries(fixed))if(k in c.payload&&!isDeepStrictEqual(c.payload[k],v))fail("Candidate fixed payload differs from package contract");
    return {...identities.get(c.localId)!,type:c.type,payload:{...resolve(c.payload),...fixed},links,body:c.body,created_by:{transaction:"mdlm-direct-transaction@1",process_ref:`${context.package.reference}#${context.package.digest}`,prompt_ref:context.action.prompt_ref,loaded_skill_refs:promptSkills,policy_refs:[]}};
  });
}
export async function submitDirectProposal(root:string,source:string,authorities:string[]=[]){
  const proposal=parseDirectProposal(source);const proposalDigest=directDigest(source);
  if(!isDeepStrictEqual(proposal.evidence?.authority??[],authorities))fail("Stakeholder authority must match the explicitly supplied command authority");
  return withRepositoryLock(root,lock,async()=>{
    const saved=await settlement(root,proposal.operation);if(saved){if(saved.tx.proposalDigest!==proposalDigest)fail("Operation already published different candidate bytes");return saved.result;}
    const current=await directState(root);if(!isDeepStrictEqual(proposal.package,current.package))fail("Proposal package changed; refresh guidance");if(proposal.snapshot!==current.snapshot)fail(`Proposal snapshot does not match lifecycle repository ${current.repository} and its current data; it was drafted in another repository, an earlier state or by an earlier MDLM release. Redraft it from fresh guidance in this repository`);
    const context=directContext(current,proposal.action,proposal.subject);
    if(proposal.inputs&&!isDeepStrictEqual(proposal.inputs,context.inputs))fail("Proposal exact inputs changed");
    const prompt=await resolvePrompt(current.pkg,context.action.prompt_ref);if(!prompt.prompt||prompt.diagnostics.length)fail("Package prompt unavailable");
    // Cheap authored-schema refusal precedes historical, authority and receipt checks; publication still validates the final data.
    const candidates=outputData(context,proposal,prompt.prompt.skills.map(s=>s.reference));
    const schemaDiagnostics=candidates.flatMap((d,index)=>{const resolved=resolveType(context.pkg,d.type);return resolved.ok?payloadSchemaDiagnostics(authorablePayloadSchema(resolved.type),d.payload,`outputs[${index}].payload`):resolved.diagnostics;});
    if(schemaDiagnostics.length)fail(JSON.stringify(schemaDiagnostics));
    if (proposal.evidence?.historicalResult !== undefined && (context.action.capability !== "independent-result" || typeof proposal.evidence.historicalResult !== "string" || proposal.evidence.receipt !== undefined)) fail("Historical applicability requires independent-result evidence.historicalResult alone");
    for (const product of context.data.filter(d => d.type === independentBinding(context.pkg)?.implementation_type && [context.subject, ...Object.values(context.inputs).flat()].includes(d.revision_id))) {
      if (["review", "acceptance"].includes(context.action.capability)) await validateCurrentHistoricalResults(context, product);
    }
    const authority=await validateDirectAuthority(context,proposal,source);
    const finalized=await finalizeDirectDomain({...context,proposal,outputs:candidates});
    if((["verification-result","independent-result"].includes(context.action.capability) || (context.action.capability === "observation" && !independentBinding(context.pkg)))){
      if(finalized.outputs.length!==1)fail("Evidence assessment publishes one result");
      const target=executionSubject(context);const d=finalized.outputs[0]!;const activity=d.links.find(l=>l.type==="evaluates")?.target;const historical = proposal.evidence?.historicalResult === undefined ? undefined : await historicalApplicability(current, target, activity ?? "", proposal.evidence.historicalResult);
      const receipt=historical?.verified ?? await receiptFor(current,proposal.evidence?.receipt??"",target,activity);
      if (historical) d.payload.historical_observation = {...historical.provenance, applied_at: new Date().toISOString()};
      d.payload.outcome=receipt.outcome;d.payload.receipt=receipt.receipt;
      if(context.action.capability==="observation"&&receipt.outcome!=="pass"&&!["revise","drop"].includes(String(d.payload.recommendation)))fail("Failed execution allows revise or drop only");
      if(context.action.capability==="verification-result"&&((receipt.outcome==="pass")!==(d.payload.correction_target==="none")))fail("Result correction target must match execution outcome");
      if (context.action.capability === "independent-result") {
        if (!activity || !receipt.saved.receipt.binding.independentVerification || receipt.saved.receipt.binding.independentVerification.activityRevision !== activity) fail("Result must select the exact executed activity");
        d.payload.case_results = receipt.saved.receipt.result?.caseResults ?? [];
        d.payload.artifacts = (receipt.saved.receipt.result?.artifacts ?? []).map(({contentBase64, ...artifact}) => artifact);
        if ((receipt.outcome === "pass") !== (d.payload.correction_target === "none")) fail("Result correction target must match captured execution outcome");
        if (d.links.some(l=>l.type === "supersedes")) fail("Result supersession is derived automatically");
        const previous = currentVerificationResults(current, target.revision_id, activity);
        for (const result of previous) {
          const prior = await readVerificationReceiptBlob(current.root, String(result.payload.receipt).slice(9));
          if (prior.oid === receipt.saved.oid || !prior.receipt.result || prior.receipt.result.startedAt >= receipt.saved.receipt.result!.startedAt) fail("A result must use a fresh execution after the current result; old passing evidence cannot replace a later failure");
        }
        d.links.push(...previous.map(r=>({type:"supersedes",target:r.revision_id})));
      }
      finalized.managedOutputs.push(d);
    }
    const tx:DirectTransaction={contract:"mdlm-direct-transaction@1",id:txId(proposal.operation),operation:proposal.operation,action:actionRef(context.action),proposalDigest,package:current.package,snapshot:current.snapshot,...(proposal.subject?{subject:proposal.subject}:{}),inputs:context.inputs,outputs:finalized.outputs,...(proposal.evidence?{evidence:proposal.evidence}:{}),...(authority?{authority}: {})};
    const published=await publishTransactionData(root,current.pkg,current.parsed,current.data,finalized.outputs,tx.id,tx,finalized.managedOutputs.map(datum=>({capability:"requirement-trace@2" as const,datum})),async()=>{const fresh=await directState(root);return fresh.snapshot===current.snapshot?{ok:true as const,value:undefined,diagnostics:[] as []}:{ok:false as const,diagnostics:[{code:"proposal-conflict",message:"Repository changed before publication"}]};});
    if(!published.ok)fail(JSON.stringify(published.diagnostics));
    return {ok:true,contract:"mdlm-proposal-result@2",operation:proposal.operation,outcome:"accepted",transaction:tx.id,revisions:tx.outputs.map(d=>d.revision_id),proposalDigest};
  });
}
async function git(root:string,args:string[]){return(await exec("git",["-C",root,...args],{env:repositoryGitEnvironment(),maxBuffer:16*1024*1024})).stdout.trim();}
function executionSubject(context:DirectContext){const types=[(context.pkg.kernelCapabilities["requirement-trace@4"]??context.pkg.kernelCapabilities["requirement-trace@3"]??context.pkg.kernelCapabilities["requirement-trace@2"])?.implementation_type,Object.values(context.pkg.actions).find(a=>a.capability==="prototype")?.types[0]];const d=context.data.find(d=>types.includes(d.type)&&([context.subject,...Object.values(context.inputs).flat()].includes(d.revision_id)));if(!d)fail("Execution requires one exact implementation/prototype");return d;}
export function executionBinding(current:Pick<State,"pkg"|"package"|"data">,implementation:DatumEnvelope,operation:string,activity?:string):VerificationBinding{
  if (independentBinding(current.pkg)) {if (!activity) fail("Independent execution requires --activity <exact-verification-activity>"); return independentExecutionBinding(current,implementation,activity,operation);}
  const exploratory=implementation.type===Object.values(current.pkg.actions).find(a=>a.capability==="prototype")?.types[0];
  const action=Object.values(current.pkg.actions).find(a=>a.capability===(exploratory?"prototype":"implementation"));
  const link=Object.keys(action?.links?.[implementation.type]??{}).find(l=>l===(exploratory?"explores":"implements"))??(exploratory?"explores":"implements");
  const context=implementation.links.filter(l=>l.type===link);if(context.length!==1)fail("Execution needs one exact requirements/experiment context");
  const p=implementation.payload;return {operation,package:current.package,inputs:[{name:exploratory?"trial":"implementation",revisions:[implementation.revision_id]},{name:exploratory?"experiment":"requirements",revisions:[context[0]!.target]}],repositoryPath:p.repository_path as string,sourceCommit:p.source_commit as string,image:p.verification_image as string,command:p.verification_command as string[],scriptPath:p.verification_script as string,...(p.acceptance_scope === "partial" ? {formalFiles:p.formal_files as string[]} : {})};
}
async function receiptFor(current:State,locator:string,implementation:DatumEnvelope,activity?:string){if(!/^git-blob:[a-f0-9]{40}$/.test(locator))fail("Evidence requires an exact receipt blob");const saved=await readVerificationReceiptBlob(current.root,locator.slice(9));const b=saved.receipt.binding;checkOperation(b.operation);const registered=await git(current.root,["rev-parse","--verify",`${verificationRef(b)}/attempt-${saved.receipt.attempt}-receipt`]);if(registered!==saved.oid)fail("Receipt is not registered to the original operation");const expected=executionBinding(current,implementation,b.operation,activity??b.independentVerification?.activityRevision);const verified=await validateVerificationReceipt(expected,saved);await requireCoherentVerificationResult(expected,saved.receipt.result!);return verified;}
async function availableReceipts(current:State,implementation:DatumEnvelope){const refs=await git(current.root,["for-each-ref","--format=%(objectname)","refs/mdlm/execution"]);const results:string[]=[];for(const oid of new Set(refs.split("\n").filter(Boolean))){try{await receiptFor(current,`git-blob:${oid}`,implementation);results.push(`git-blob:${oid}`);}catch{}}return results;}
export async function runDirectExecution(root:string,subject:string,operation:string,activity?:string){checkOperation(operation);return withRepositoryLock(root,lock,async()=>{const current=await directState(root);const implementation=current.data.find(d=>d.revision_id===subject);if(!implementation||!Object.values(current.pkg.actions).some(a=>["implementation","prototype"].includes(a.capability)&&a.types.includes(implementation.type)))fail("Unknown exact execution subject or unsupported type");const saved=await runVerificationReceipt(root,executionBinding(current,implementation,operation,activity),false);return{ok:true,contract:"mdlm-execution-result@1",operation,value:{...saved,evidence:`git-blob:${saved.oid}`}};});}
export async function inspectDirectExecution(root:string,operation:string){checkOperation(operation);const current=await directState(root);const oid=await git(root,["rev-parse","--verify","--quiet",`refs/mdlm/execution/${operation}/latest`]).catch(e=>{if(e.code===1)return undefined;throw e;});if(!oid)return{ok:true,contract:"mdlm-execution-result@1",operation,value:{state:"not-started"}};const saved=await readVerificationReceiptBlob(root,oid);if(saved.receipt.binding.operation!==operation||!isDeepStrictEqual(saved.receipt.binding.package,current.package))fail("Execution settlement binding changed");return{ok:true,contract:"mdlm-execution-result@1",operation,value:{...saved,...(saved.receipt.state==="completed"?{evidence:`git-blob:${oid}`}:{})}};}
export async function inspectDirectReview(root:string,action:string,subject?:string){const current=await directState(root);return {ok:true,...await buildDirectReviewContext(directContext(current,action,subject))};}
export async function registerDirectReviewFiles(root:string,source:string,verdict:string){return withRepositoryLock(root,lock,async()=>{const p=parseDirectProposal(source);const current=await directState(root);if(!isDeepStrictEqual(p.package,current.package)||p.snapshot!==current.snapshot)fail("Review registration package or snapshot changed");const context=directContext(current,p.action,p.subject);const value=await registerDirectReview(root,context,source,verdict);if((await directState(root)).snapshot!==current.snapshot)fail("Review context changed during registration");return{ok:true,value};});}

async function receiptDetails(current:State,implementation:DatumEnvelope){return Promise.all((await availableReceipts(current,implementation)).map(async evidence=>({evidence,...await readVerificationReceiptBlob(current.root,evidence.slice(9))})));}

export async function inspectVerificationContext(root:string,subject:string){const current=await directState(root);return {ok:true,...verificationAuthoringContext(current,subject),snapshot:current.snapshot};}
export async function inspectVerificationStatus(root:string,subject:string){const current=await directState(root);const product=current.data.find(d=>d.revision_id===subject);if(product && product.type===independentBinding(current.pkg)?.implementation_type)await validateCurrentHistoricalResults(current,product);return {ok:true,...verificationStatus(current,subject),package:current.package,snapshot:current.snapshot};}

/** Recover captured evidence without executing or changing lifecycle data. Destination is exclusive. */
export async function exportDirectExecution(root:string,operation:string,destination:string) {
  const settled=await inspectDirectExecution(root,operation);
  const value=settled.value as {receipt?:{state:string;result?:{artifacts?:{path:string;sha256:string;bytes:number;contentBase64:string}[];rawReportBase64?:string;stdoutBase64:string;stderrBase64:string}}};
  if(value.receipt?.state!=="completed" || !value.receipt.result) fail("Only a completed execution has exportable evidence");
  const result=value.receipt.result;
  const files=(result.artifacts??[]).map(artifact=>{
    const bytes=Buffer.from(artifact.contentBase64,"base64");
    if(!artifact.path || artifact.path.includes("\\") || path.posix.isAbsolute(artifact.path) || artifact.path.split("/").some(p=>!p || p==="." || p==="..") || bytes.length!==artifact.bytes || createHash("sha256").update(bytes).digest("hex")!==artifact.sha256) fail("Captured artifact binding is invalid");
    return {path:`artifacts/${artifact.path}`,bytes};
  });
  files.push({path:"stdout",bytes:Buffer.from(result.stdoutBase64,"base64")},{path:"stderr",bytes:Buffer.from(result.stderrBase64,"base64")});
  if(result.rawReportBase64!==undefined) files.push({path:"report.json",bytes:Buffer.from(result.rawReportBase64,"base64")});
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.mkdir(destination);
  for(const file of files) {const target=path.join(destination,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.bytes,{flag:"wx"});}
  return {ok:true,contract:"mdlm-execution-export@1",operation,path:destination,files:files.map(file=>({path:file.path,bytes:file.bytes.length,sha256:createHash("sha256").update(file.bytes).digest("hex")}))};
}
