import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { DatumEnvelope, ProcessPackage } from "./index.js";
import { deploymentBinding, describeStack, hostFailure, hostOptions, listStackResources, nonEmpty, parseDeploymentConfig, readDeploymentReceiptBlob, stackTags,
  type DeploymentBinding, type DeploymentConfig, type DeploymentResult, type InventoryEntry } from "./aws-cdk-deployment.js";
import { execute } from "./docker-verification.js";
import { repositoryGitEnvironment } from "./git-environment.js";
import { refuseSecretValues, type SecretFinding } from "./secret-scan.js";

// ADR-0009 section 4. Teardown deletes one deployment's stack and proves it is gone:
// the stack is DELETE_COMPLETE, the tag query for its deployment is empty, and every
// top-level resource in its inventory reports not found. Orphan checks only report.
const HOST_TIMEOUT_MS = 30 * 60_000;
type Host = {env: NodeJS.ProcessEnv; cwd: string};

/** V1 top-level resource types the kernel can check and delete, and how each appears in an ARN. */
const TOP_LEVEL: Record<string, {arn: RegExp; build: (region: string, account: string, id: string) => string; get: (id: string) => string[]; remove: (id: string) => string[]; missing: RegExp; found?: (output: any, id: string) => boolean}> = {
  "AWS::Lambda::Function": {arn: /^arn:aws[a-z-]*:lambda:([^:]+):\d{12}:function:([^:]+)$/, build: (r, a, id) => `arn:aws:lambda:${r}:${a}:function:${id}`, get: id => ["lambda", "get-function", "--function-name", id], remove: id => ["lambda", "delete-function", "--function-name", id], missing: /ResourceNotFoundException/},
  "AWS::ApiGatewayV2::Api": {arn: /^arn:aws[a-z-]*:apigateway:([^:]+)::\/apis\/([^/]+)$/, build: (r, _a, id) => `arn:aws:apigateway:${r}::/apis/${id}`, get: id => ["apigatewayv2", "get-api", "--api-id", id], remove: id => ["apigatewayv2", "delete-api", "--api-id", id], missing: /NotFoundException/},
  "AWS::DynamoDB::Table": {arn: /^arn:aws[a-z-]*:dynamodb:([^:]+):\d{12}:table\/([^/]+)$/, build: (r, a, id) => `arn:aws:dynamodb:${r}:${a}:table/${id}`, get: id => ["dynamodb", "describe-table", "--table-name", id], remove: id => ["dynamodb", "delete-table", "--table-name", id], missing: /ResourceNotFoundException/},
  "AWS::Logs::LogGroup": {arn: /^arn:aws[a-z-]*:logs:([^:]+):\d{12}:log-group:(.+?)(?::\*)?$/, build: (r, a, id) => `arn:aws:logs:${r}:${a}:log-group:${id}`, get: id => ["logs", "describe-log-groups", "--log-group-name-prefix", id], remove: id => ["logs", "delete-log-group", "--log-group-name", id],
    missing: /ResourceNotFoundException/, found: (output, id) => (output?.logGroups ?? []).some((group: {logGroupName?: string}) => group.logGroupName === id)},
};
/** Untaggable or bookkeeping children that AWS deletes with their allowlisted parent. */
const CHILD_TYPES = new Set(["AWS::ApiGatewayV2::Stage", "AWS::ApiGatewayV2::Route", "AWS::ApiGatewayV2::Integration", "AWS::Lambda::Permission", "AWS::CDK::Metadata"]);
export const DELETABLE_RESOURCE_TYPES = Object.keys(TOP_LEVEL);

export function parseResourceArn(arn: string): {type: string; id: string; region: string} | undefined {
  for (const [type, {arn: pattern}] of Object.entries(TOP_LEVEL)) {
    const match = pattern.exec(arn);
    if (match) return {type, id: match[2]!, region: match[1]!};
  }
  return undefined;
}

export function packageDeploymentConfig(pkg: ProcessPackage): DeploymentConfig {
  const binding = deploymentBinding(pkg);
  if (!binding?.action) throw new Error("Selected package does not support aws-cdk-deployment@1");
  return parseDeploymentConfig(pkg.actions[binding.action]?.fixed_payload?.[binding.type]);
}
export function requireApmProfile(config: DeploymentConfig, awsProfile: string) {
  if (awsProfile !== `apm-${config.apm_project}`) throw new Error(`Deployment requires --aws-profile apm-${config.apm_project} from aws-permissions-manager`);
}

const exec = promisify(execFile);
const git = async (root: string, args: string[]) => (await exec("git", ["-C", root, ...args], {env: repositoryGitEnvironment(), maxBuffer: 64 * 1024 * 1024})).stdout.trim();

/** What this repository knows about its deployments: published DPLs by deployment operation, with their recorded stack and inventory, and deployments already torn down. */
export interface DeploymentRegistry {repository: string; deployments: Map<string, {revision: string; stackId?: string; account?: string; inventory: InventoryEntry[]}>; tornDown: Set<string>}
export async function deploymentRegistry(state: {root: string; pkg: ProcessPackage; data: DatumEnvelope[]; repository: string}): Promise<DeploymentRegistry> {
  const type = deploymentBinding(state.pkg)?.type, deployments: DeploymentRegistry["deployments"] = new Map(), tornDown = new Set<string>();
  for (const datum of state.data.filter(d => d.type === type && /^git-blob:[a-f0-9]{40}$/.test(String(d.payload.receipt)))) {
    const {binding, result} = (await readDeploymentReceiptBlob(state.root, String(datum.payload.receipt).slice(9))).receipt;
    deployments.set(binding.operation, {revision: datum.revision_id, ...(result?.stack ? {stackId: result.stack.id} : {}), ...(result?.access ? {account: result.access.account} : {}), inventory: result?.inventory ?? []});
  }
  // ADR-0009 section 5: completed dry-run deployment records count the same way as published records.
  for (const record of await dryRunRecords(state.root)) {
    if (record.state !== "completed") continue;
    deployments.set(record.id, {revision: record.id, ...(record.result?.stack ? {stackId: record.result.stack.id} : {}), ...(record.result?.access ? {account: record.result.access.account} : {}), inventory: record.result?.inventory ?? []});
  }
  const refs = await git(state.root, ["for-each-ref", "--format=%(objectname)", "refs/mdlm/teardown"]);
  for (const oid of new Set(refs.split("\n").filter(Boolean))) {
    const receipt = (await readTeardownReceiptBlob(state.root, oid)).receipt;
    // Only a stack teardown proves a whole deployment gone; deleting one orphan resource does not.
    if (receipt.result?.outcome === "pass" && receipt.result.deployment && receipt.binding.target.kind !== "orphan-resource") tornDown.add(receipt.result.deployment);
  }
  return {repository: state.repository, deployments, tornDown};
}

type DryRunRecord = {contract: string; id: string; state: string; binding: DeploymentBinding; result?: DeploymentResult};
async function dryRunRecords(root: string): Promise<DryRunRecord[]> {
  const directory = path.join(root, ".lifecycle/work/deployments");
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const files = names.filter(name => /^dry-[0-9a-f-]{36}\.json$/.test(name));
  const records = await Promise.all(files.map(name => fs.readFile(path.join(directory, name), "utf8").then(source => JSON.parse(source) as DryRunRecord)));
  // A record counts only under its own file name.
  return records.filter((record, index) => record?.contract === "mdlm-deployment-dry-run@1" && `${record.id}.json` === files[index]);
}

/** Why a tagged stack or resource is an orphan, or undefined when a live deployment in this repository owns it. */
export function orphanReason(tags: Record<string, string>, registry: DeploymentRegistry, now = Date.now()): string | undefined {
  const deployment = tags["mdlm:deployment"], expires = tags["mdlm:expires-at"];
  if (!deployment) return "it has no mdlm:deployment tag";
  if (!registry.deployments.has(deployment)) return `mdlm:deployment '${deployment}' names no deployment record in this repository`;
  if (registry.tornDown.has(deployment)) return `deployment '${deployment}' already has a teardown`;
  if (!expires || !(Date.parse(expires) > now)) return `mdlm:expires-at '${expires ?? ""}' has passed`;
  return undefined;
}

export interface Orphan {kind: "stack" | "resource"; arn: string; slot?: string; status?: string; deployment?: string; reason: string}
export interface OrphanReport {checkedAt: string; orphans: Orphan[]}

async function taggedResources(host: Host, region: string, filters: Record<string, string>, arns?: string[]): Promise<{arn: string; tags: Record<string, string>}[]> {
  const query = await execute("aws", ["resourcegroupstaggingapi", "get-resources", "--region", region, "--output", "json",
    ...(arns ? ["--resource-arn-list", ...arns] : ["--tag-filters", ...Object.entries(filters).map(([key, value]) => `Key=${key},Values=${value}`)])], 120_000, host);
  if (query.problem || query.exitCode !== 0) throw new Error(hostFailure("aws resourcegroupstaggingapi get-resources", query));
  const mappings = (JSON.parse(query.stdout.toString("utf8")) as {ResourceTagMappingList?: {ResourceARN?: string; Tags?: unknown}[]}).ResourceTagMappingList ?? [];
  return mappings.map(m => ({arn: String(m.ResourceARN), tags: stackTags(m)}));
}

/** Every stack in the slot pool and every resource tagged with this repository that no live deployment owns.
 * A slot stack tagged for another lifecycle repository is that repository's to judge. */
export async function findOrphans(config: DeploymentConfig, registry: DeploymentRegistry, host: Host): Promise<OrphanReport> {
  const checkedAt = new Date().toISOString(), now = Date.parse(checkedAt), orphans: Orphan[] = [];
  for (const slot of config.stack_slots) {
    const stack = await describeStack(slot, config.region, host);
    if (!stack) continue;
    const tags = stackTags(stack);
    if (tags["mdlm:repository"] !== undefined && tags["mdlm:repository"] !== registry.repository) continue;
    const reason = orphanReason(tags, registry, now);
    if (reason) orphans.push({kind: "stack", arn: String(stack.StackId), slot, status: String(stack.StackStatus), ...(tags["mdlm:deployment"] ? {deployment: tags["mdlm:deployment"]} : {}), reason});
  }
  for (const resource of await taggedResources(host, config.region, {"mdlm:repository": registry.repository})) {
    if (/^arn:aws[a-z-]*:cloudformation:/.test(resource.arn)) continue;
    const reason = orphanReason(resource.tags, registry, now);
    if (reason) orphans.push({kind: "resource", arn: resource.arn, ...(resource.tags["mdlm:deployment"] ? {deployment: resource.tags["mdlm:deployment"]} : {}), reason});
  }
  // The inventory covers resources the tag query cannot see: once a live deployment's stack is gone, any surviving top-level resource is an orphan.
  for (const [deployment, known] of registry.deployments) {
    if (registry.tornDown.has(deployment) || !known.stackId || !known.account) continue;
    const stack = await describeStack(known.stackId, config.region, host, true);
    if (stack && stack.StackStatus !== "DELETE_COMPLETE") continue;
    for (const entry of known.inventory.filter(entry => TOP_LEVEL[entry.type])) {
      const arn = TOP_LEVEL[entry.type]!.build(config.region, known.account, entry.physicalId);
      if (orphans.some(o => o.arn === arn) || !await resourceExists(host, config.region, entry.type, entry.physicalId)) continue;
      // A reused physical name may now belong to another deployment; a resource carrying a deployment tag is judged by its tags alone.
      if ((await taggedResources(host, config.region, {}, [arn])).some(r => r.tags["mdlm:deployment"])) continue;
      orphans.push({kind: "resource", arn, deployment, reason: `an inventoried resource of deployment '${deployment}' outlived its stack`});
    }
  }
  return {checkedAt, orphans};
}

async function resourceExists(host: Host, region: string, type: string, id: string): Promise<boolean> {
  const check = TOP_LEVEL[type]!;
  const read = await execute("aws", [...check.get(id), "--region", region, "--output", "json"], 60_000, host);
  if (!read.problem && read.exitCode === 0) return check.found ? check.found(JSON.parse(read.stdout.toString("utf8")), id) : true;
  if (!read.problem && check.missing.test(read.stderr.toString("utf8"))) return false;
  throw new Error(hostFailure(`aws ${check.get(id).slice(0, 2).join(" ")}`, read));
}

export type TeardownTarget =
  | {kind: "deployment"; revision: string; receipt: string; deployment: string; stack: string; stackId?: string; account?: string; inventory: InventoryEntry[]}
  | {kind: "orphan-stack"; slot: string}
  | {kind: "orphan-resource"; arn: string};
export interface TeardownBinding {contract: "mdlm-teardown@1"; operation: string; package: unknown; repository: string; config: DeploymentConfig; awsProfile: string; target: TeardownTarget}
export interface TeardownResult {
  outcome: "pass" | "error";
  phase: "access" | "orphans" | "delete" | "verify";
  /** True once a delete was requested from AWS. */
  deleteAttempted: boolean;
  diagnostic?: string;
  startedAt: string;
  finishedAt: string;
  access?: {apmProject: string; callerArn: string; account: string};
  /** The `mdlm:deployment` value this teardown removes; a passing teardown marks it torn down. */
  deployment?: string;
  stack?: {id: string; status: string};
  delete?: {exitCode: number | null; stdoutBase64: string; stderrBase64: string}[];
  inventory?: InventoryEntry[];
  remaining?: {tagged: string[]; inventory: (InventoryEntry & {reason: string})[]};
  orphans?: OrphanReport;
  secretFindings?: SecretFinding[];
}

/** Resolve what to tear down. A deployment target is one exact published deployment record. */
export async function teardownBinding(state: {root: string; pkg: ProcessPackage; package: unknown; data: DatumEnvelope[]; repository: string}, operation: string,
  options: {awsProfile: string; deployment?: string; orphanStack?: string; orphanResource?: string}): Promise<TeardownBinding> {
  const config = packageDeploymentConfig(state.pkg), base = {contract: "mdlm-teardown@1" as const, operation, package: state.package, repository: state.repository};
  if (options.deployment !== undefined && /^dry-/.test(options.deployment)) {
    // A dry-run deployment, even an interrupted one, is torn down from its record (ADR-0009 section 5).
    const record = (await dryRunRecords(state.root)).find(r => r.id === options.deployment);
    if (!record) throw new Error(`No dry-run deployment '${options.deployment}'`);
    requireApmProfile(record.binding.config, options.awsProfile);
    const deployed = record.result;
    return {...base, config: record.binding.config, awsProfile: options.awsProfile,
      target: {kind: "deployment", revision: record.id, receipt: `dry-run:${record.id}`, deployment: record.binding.operation, stack: record.binding.stack,
        ...(deployed?.stack ? {stackId: deployed.stack.id} : {}), ...(deployed?.access ? {account: deployed.access.account} : {}), inventory: deployed?.inventory ?? []}};
  }
  if (options.deployment !== undefined) {
    const record = state.data.find(d => d.revision_id === options.deployment);
    if (!record || record.type !== deploymentBinding(state.pkg)?.type || !/^git-blob:[a-f0-9]{40}$/.test(String(record.payload.receipt))) throw new Error("Teardown requires one exact published deployment record");
    const {receipt} = await readDeploymentReceiptBlob(state.root, String(record.payload.receipt).slice(9));
    requireApmProfile(receipt.binding.config, options.awsProfile);
    const deployed = receipt.result;
    return {...base, config: receipt.binding.config, awsProfile: options.awsProfile,
      target: {kind: "deployment", revision: record.revision_id, receipt: String(record.payload.receipt), deployment: receipt.binding.operation, stack: receipt.binding.stack,
        ...(deployed?.stack ? {stackId: deployed.stack.id} : {}), ...(deployed?.access ? {account: deployed.access.account} : {}), inventory: deployed?.inventory ?? []}};
  }
  requireApmProfile(config, options.awsProfile);
  if (options.orphanStack !== undefined) {
    if (!config.stack_slots.includes(options.orphanStack)) throw new Error(`Stack '${options.orphanStack}' is not one of the package's stack slots: ${config.stack_slots.join(", ")}`);
    return {...base, config, awsProfile: options.awsProfile, target: {kind: "orphan-stack", slot: options.orphanStack}};
  }
  const parsed = parseResourceArn(String(options.orphanResource));
  if (!parsed) throw new Error(`Only these resource types can be deleted as orphans: ${DELETABLE_RESOURCE_TYPES.join(", ")}. Remove any other resource by hand.`);
  if (!config.resource_allowlist.includes(parsed.type)) throw new Error(`${parsed.type} is not on the package resource allowlist; remove it by hand`);
  if (parsed.region !== config.region) throw new Error(`Orphan resource is not in the package region ${config.region}`);
  return {...base, config, awsProfile: options.awsProfile, target: {kind: "orphan-resource", arn: String(options.orphanResource)}};
}

const capture = (run: {exitCode: number | null; stdout: Buffer; stderr: Buffer}) => ({exitCode: run.exitCode, stdoutBase64: run.stdout.toString("base64"), stderrBase64: run.stderr.toString("base64")});

/** One teardown attempt. Deletion happens by stack ID or exact resource, never by slot name, so a newer stack in the slot is never touched. */
export async function executeTeardown(binding: TeardownBinding, registry: DeploymentRegistry, confirm: (question: string) => Promise<boolean> = async () => false): Promise<TeardownResult> {
  const result: TeardownResult = {outcome: "error", phase: "access", deleteAttempted: false, startedAt: new Date().toISOString(), finishedAt: ""};
  const directory = await fs.mkdtemp(path.join(tmpdir(), "mdlm-teardown-"));
  const host = hostOptions(binding, directory), region = binding.config.region, target = binding.target;
  try {
    const identity = await execute("aws", ["sts", "get-caller-identity", "--output", "json"], 60_000, host);
    if (identity.problem || identity.exitCode !== 0) throw new Error(hostFailure("aws sts get-caller-identity", identity));
    const caller = JSON.parse(identity.stdout.toString("utf8")) as {Account?: string; Arn?: string};
    if (!/^\d{12}$/.test(String(caller.Account)) || !nonEmpty(caller.Arn)) throw new Error("aws sts get-caller-identity returned no account and caller ARN");
    result.access = {apmProject: binding.config.apm_project, callerArn: caller.Arn, account: caller.Account!};

    result.phase = "orphans";
    result.orphans = await findOrphans(binding.config, registry, host);
    let stackId: string | undefined, inventory: InventoryEntry[] = [];
    if (target.kind === "orphan-resource") {
      const orphan = result.orphans.orphans.find(o => o.kind === "resource" && o.arn === target.arn);
      if (!orphan) throw new Error(`${target.arn} is not a reported orphan of this repository`);
      if (orphan.deployment) result.deployment = orphan.deployment;
      const {type, id} = parseResourceArn(target.arn)!;
      inventory = [{logicalId: "", type, physicalId: id}];
      if (!await confirm(`Delete orphan ${type} ${target.arn} (${orphan.reason})?`)) throw new Error("Deletion was not confirmed");
      result.phase = "delete";
      result.deleteAttempted = true;
      const removed = await execute("aws", [...TOP_LEVEL[type]!.remove(id), "--region", region, "--output", "json"], 120_000, host);
      result.delete = [capture(removed)];
      if (removed.problem || (removed.exitCode !== 0 && !TOP_LEVEL[type]!.missing.test(removed.stderr.toString("utf8")))) throw new Error(hostFailure(`aws ${TOP_LEVEL[type]!.remove(id).slice(0, 2).join(" ")}`, removed));
    } else {
      if (target.kind === "orphan-stack") {
        const orphan = result.orphans.orphans.find(o => o.kind === "stack" && o.slot === target.slot);
        if (!orphan) throw new Error(`Stack slot '${target.slot}' holds no orphan of this repository`);
        stackId = orphan.arn;
        if (orphan.deployment) result.deployment = orphan.deployment;
      } else {
        result.deployment = target.deployment;
        if (target.account && target.account !== result.access.account) throw new Error("The APM profile's account differs from the deployment's account");
        stackId = target.stackId;
        inventory = target.inventory;
        if (!stackId) {
          // The deploy may have created a stack it never described (for example a failed cdk deploy).
          const slot = await describeStack(target.stack, region, host);
          if (slot && stackTags(slot)["mdlm:deployment"] === target.deployment && stackTags(slot)["mdlm:repository"] === binding.repository) stackId = String(slot.StackId);
        }
      }
      if (stackId) {
        const before = await describeStack(stackId, region, host, true);
        if (before && before.StackStatus !== "DELETE_COMPLETE") {
          // The live inventory also covers deployments whose receipt recorded none.
          const live = await listStackResources(stackId, region, host);
          inventory = [...inventory, ...live.filter(entry => !inventory.some(known => known.logicalId === entry.logicalId && known.physicalId === entry.physicalId))];
          result.phase = "delete";
          result.deleteAttempted = true;
          const deleted = await execute("aws", ["cloudformation", "delete-stack", "--stack-name", stackId, "--region", region], 120_000, host);
          result.delete = [capture(deleted)];
          if (deleted.problem || deleted.exitCode !== 0) throw new Error(hostFailure("aws cloudformation delete-stack", deleted));
          const waited = await execute("aws", ["cloudformation", "wait", "stack-delete-complete", "--stack-name", stackId, "--region", region], HOST_TIMEOUT_MS, host);
          result.delete.push(capture(waited));
        }
        result.phase = "verify";
        const after = await describeStack(stackId, region, host, true);
        result.stack = {id: stackId, status: String(after?.StackStatus ?? "DELETE_COMPLETE")};
      }
    }

    result.phase = "verify";
    result.inventory = inventory;
    const tagged = target.kind === "orphan-resource" || !result.deployment ? []
      : (await taggedResources(host, region, {"mdlm:repository": binding.repository, "mdlm:deployment": result.deployment})).map(r => r.arn);
    const remaining: NonNullable<TeardownResult["remaining"]>["inventory"] = [];
    for (const entry of inventory) {
      if (CHILD_TYPES.has(entry.type)) continue;
      if (!TOP_LEVEL[entry.type]) remaining.push({...entry, reason: "the kernel cannot check this resource type; remove it by hand"});
      else if (await resourceExists(host, region, entry.type, entry.physicalId)) remaining.push({...entry, reason: "still exists"});
    }
    result.remaining = {tagged, inventory: remaining};
    const problems = [
      ...(result.stack && result.stack.status !== "DELETE_COMPLETE" ? [`stack ${result.stack.id} is ${result.stack.status}`] : []),
      ...tagged.map(arn => `${arn} is still tagged for deployment '${result.deployment}'`),
      ...remaining.map(entry => `${entry.type} ${entry.physicalId}: ${entry.reason}`),
    ];
    if (problems.length) throw new Error(`Teardown is incomplete: ${problems.join("; ")}`);
    result.outcome = "pass";
  } catch (error) {
    result.outcome = "error";
    result.diagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    await fs.rm(directory, {recursive: true, force: true}).catch(() => undefined);
    result.finishedAt = new Date().toISOString();
  }
  return result;
}

export interface TeardownReceipt {binding: TeardownBinding; attempt: 1; state: "started" | "completed"; result?: TeardownResult}
export const teardownRef = (operation: string) => `refs/mdlm/teardown/${operation}`;
export async function readTeardownReceiptBlob(root: string, oid: string): Promise<{oid: string; receipt: TeardownReceipt}> {
  const receipt = JSON.parse(await git(root, ["cat-file", "blob", oid])) as TeardownReceipt;
  if (receipt?.binding?.contract !== "mdlm-teardown@1") throw new Error("Git blob is not a teardown receipt");
  return {oid, receipt};
}

/** Write-once like a deployment receipt: the started marker is durable first, and an interrupted teardown is never re-run under the same operation. */
export async function runTeardownReceipt(root: string, binding: TeardownBinding, run: (binding: TeardownBinding) => Promise<TeardownResult>) {
  const latest = await git(root, ["rev-parse", "--verify", "--quiet", `${teardownRef(binding.operation)}/latest`]).catch(error => { if (error.code === 1) return ""; throw error; });
  if (latest) {
    const previous = await readTeardownReceiptBlob(root, latest);
    if (!isDeepStrictEqual(previous.receipt.binding, binding)) throw new Error("Teardown operation already exists with different inputs");
    if (previous.receipt.state === "completed") return previous;
    throw new Error("Previous teardown attempt did not complete. Check for orphans and run a new teardown operation.");
  }
  const persist = async (receipt: TeardownReceipt, expected: string) => {
    const directory = path.join(root, ".lifecycle/work", "teardown", binding.operation), name = receipt.state === "completed" ? "receipt" : "started";
    await fs.mkdir(directory, {recursive: true});
    const file = path.join(directory, `1-${name}.json`);
    await fs.writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, {flag: "wx"});
    const oid = await git(root, ["hash-object", "-w", file]);
    await git(root, ["update-ref", `${teardownRef(binding.operation)}/attempt-1-${name}`, oid, "0".repeat(40)]);
    await git(root, ["update-ref", `${teardownRef(binding.operation)}/latest`, oid, expected]);
    return oid;
  };
  const started = await persist({binding, attempt: 1, state: "started"}, "0".repeat(40));
  // Host AWS CLI output is scanned like deployment output before it is stored (ADR-0009 section 3).
  const result = refuseSecretValues(await run(binding), "the AWS CLI output");
  const receipt: TeardownReceipt = {binding, attempt: 1, state: "completed", result};
  return {oid: await persist(receipt, started), receipt};
}
