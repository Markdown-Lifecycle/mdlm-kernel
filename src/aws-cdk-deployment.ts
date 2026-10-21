import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { DatumEnvelope, ProcessPackage } from "./index.js";
import type { DirectAction } from "./direct-contract.js";
import { archiveSource, authenticateProductSource, checked, execute } from "./docker-verification.js";
import { repositoryGitEnvironment } from "./git-environment.js";

// ADR-0009 section 1. Synth runs product code in the sandbox; only a validated
// assembly reaches the host CDK CLI, which alone uses the operator's APM profile.
export const DEPLOYMENT_CAPABILITY = "aws-cdk-deployment@1";
export const DEPLOYMENT_MANAGED_FIELDS = ["outcome", "receipt", "stack", "outputs", "endpoint", "deployed_version", "expires_at"] as const;
const SYNTH_TIMEOUT_MS = 300_000;
const HOST_TIMEOUT_MS = 30 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_BODY_LIMIT = 4096;

/** Package-owned deployment settings, fixed by the deployment action for its record type. */
export interface DeploymentConfig {
  synth_image: string;
  cdk_cli_version: string;
  cdk_app_path: string;
  region: string;
  apm_project: string;
  stack_slots: string[];
  output_allowlist: string[];
  endpoint_output: string;
  probe_path: string;
  max_lifetime_minutes: number;
}
export interface DeploymentBinding {
  contract: "mdlm-deployment@1";
  operation: string;
  package: unknown;
  action: string;
  product: string;
  repositoryPath: string;
  sourceCommit: string;
  config: DeploymentConfig;
  stack: string;
  awsProfile: string;
}
type Phase = "source" | "synth" | "validation" | "access" | "deploy" | "stack" | "probe";
export interface DeploymentResult {
  outcome: "pass" | "error";
  phase: Phase;
  /** True once the host CDK CLI was started; recovery is then teardown, never a second deploy. */
  deployAttempted: boolean;
  diagnostic?: string;
  startedAt: string;
  finishedAt: string;
  source?: {commit: string; tree: string; appPath: string; synthImage: string; synthImageId: string | null; hostCdkVersion: string};
  synth?: {exitCode: number | null; stdoutBase64: string; stderrBase64: string};
  assembly?: {templateSha256: string; assets: {id: string; packaging: string; path: string; sha256: string}[]};
  access?: {apmProject: string; callerArn: string; account: string};
  deploy?: {exitCode: number | null; stdoutBase64: string; stderrBase64: string};
  stack?: {account: string; region: string; name: string; id: string; status: string; lastUpdatedTime: string};
  outputs?: Record<string, string>;
  endpoint?: string;
  probe?: {url: string; status: number | null; expectedVersion: string; matched: boolean; bodyBase64: string};
  deployedVersion?: string;
  expiresAt?: string;
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
const relative = (value: unknown): value is string => nonEmpty(value) && !value.startsWith("/") && !value.includes("\\") && value.split("/").every(part => part && part !== "." && part !== "..");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export function deploymentBinding(pkg: ProcessPackage) { return pkg.kernelCapabilities[DEPLOYMENT_CAPABILITY]; }

/** The single source of truth for what a package must fix before the kernel deploys anything. */
export function parseDeploymentConfig(value: unknown): DeploymentConfig {
  const fail = (message: string): never => { throw new Error(`Deployment configuration ${message}`); };
  if (!object(value)) fail("must be the deployment action's fixed payload object");
  const c = value as Record<string, unknown>;
  if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(String(c.synth_image))) fail("synth_image must be pinned with @sha256:<64 lowercase hex digits>");
  if (!/^\d+\.\d+\.\d+$/.test(String(c.cdk_cli_version))) fail("cdk_cli_version must be an exact x.y.z version");
  if (c.cdk_app_path !== "." && !relative(c.cdk_app_path)) fail("cdk_app_path must be '.' or a relative path within the product");
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(String(c.region))) fail("region must name one AWS region");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(c.apm_project))) fail("apm_project must name one APM project");
  const names = (field: string, pattern: RegExp) => {
    const list = c[field];
    if (!Array.isArray(list) || !list.length || new Set(list).size !== list.length || list.some(item => !pattern.test(String(item)))) fail(`${field} must list distinct names`);
    return list as string[];
  };
  names("stack_slots", /^[A-Za-z][A-Za-z0-9-]{0,127}$/);
  const outputs = names("output_allowlist", /^[A-Za-z0-9]{1,255}$/);
  if (!outputs.includes(String(c.endpoint_output))) fail("endpoint_output must be an allowlisted output");
  if (!/^\/[\x21-\x7e]*$/.test(String(c.probe_path))) fail("probe_path must be an absolute URL path");
  if (!Number.isInteger(c.max_lifetime_minutes) || (c.max_lifetime_minutes as number) < 1) fail("max_lifetime_minutes must be a positive integer");
  return value as unknown as DeploymentConfig;
}

/** Capability checks at package load, so a misconfigured package never reaches AWS. */
export function deploymentCapabilityDiagnostics(pkg: ProcessPackage, managedPaths: string[]): string[] {
  const binding = deploymentBinding(pkg)!;
  const problems: string[] = [];
  if (!binding.implementation_type || !pkg.types[binding.implementation_type]) problems.push("AWS CDK deployment requires a declared implementation_type");
  for (const field of DEPLOYMENT_MANAGED_FIELDS) if (!managedPaths.includes(field)) problems.push(`AWS CDK deployment requires managed ${field}`);
  const action = binding.action ? pkg.actions[binding.action] : undefined;
  if (!action || action.capability !== "deployment" || !action.types.includes(binding.type)) problems.push("AWS CDK deployment must name a deployment action that publishes its record type");
  else try { parseDeploymentConfig(action.fixed_payload?.[binding.type]); } catch (error) { problems.push((error as Error).message); }
  return problems;
}

function deploymentAction(pkg: ProcessPackage): {action: DirectAction; type: string; implementationType: string; config: DeploymentConfig} {
  const binding = deploymentBinding(pkg);
  if (!binding?.action) throw new Error(`Selected package does not support ${DEPLOYMENT_CAPABILITY}`);
  const action = pkg.actions[binding.action]!;
  return {action, type: binding.type, implementationType: binding.implementation_type!, config: parseDeploymentConfig(action.fixed_payload?.[binding.type])};
}

export function deploymentRunBinding(state: {pkg: ProcessPackage; package: unknown; data: DatumEnvelope[]}, productId: string, operation: string, options: {stack: string; awsProfile: string}): DeploymentBinding {
  const {action, implementationType, config} = deploymentAction(state.pkg);
  const product = state.data.find(d => d.revision_id === productId);
  if (!product || product.type !== implementationType) throw new Error(`Deployment subject must be an exact ${implementationType} revision`);
  if (!nonEmpty(product.payload.repository_path) || !/^[a-f0-9]{40}$/.test(String(product.payload.source_commit))) throw new Error("Deployment subject must name a product repository and exact source commit");
  if (!config.stack_slots.includes(options.stack)) throw new Error(`Stack '${options.stack}' is not one of the package's stack slots: ${config.stack_slots.join(", ")}`);
  // ADR-0009 section 3: the kernel uses only the package-named APM profile.
  if (options.awsProfile !== `apm-${config.apm_project}`) throw new Error(`Deployment requires --aws-profile apm-${config.apm_project} from aws-permissions-manager`);
  return {contract: "mdlm-deployment@1", operation, package: state.package, action: `${action.id}@${action.version}`, product: product.revision_id,
    repositoryPath: String(product.payload.repository_path), sourceCommit: String(product.payload.source_commit), config, stack: options.stack, awsProfile: options.awsProfile};
}

/** Host commands see only the profile name, never inherited key material or another profile. */
function hostEnvironment(binding: DeploymentBinding): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {PATH: process.env.PATH ?? "", AWS_PROFILE: binding.awsProfile, AWS_REGION: binding.config.region, AWS_DEFAULT_REGION: binding.config.region, CDK_DISABLE_VERSION_CHECK: "1"};
  for (const name of ["HOME", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"]) if (process.env[name]) env[name] = process.env[name];
  return env;
}

function hostFailure(label: string, result: {exitCode: number | null; problem?: string; stderr: Buffer}): string {
  return `${label} failed: ${result.problem ?? `exit ${result.exitCode}: ${result.stderr.toString("utf8").trim().slice(0, 2000)}`}`;
}

/** Run `cdk synth` for one exact commit in a disposable `--network none` container without credentials. */
async function synthesize(binding: DeploymentBinding, directory: string, result: DeploymentResult): Promise<string> {
  const archive = await archiveSource(binding.repositoryPath, binding.sourceCommit, "Product");
  const archivePath = path.join(directory, "source.tar"), snapshot = path.join(directory, "source"), evidence = path.join(directory, "evidence");
  await fs.writeFile(archivePath, archive);
  await fs.mkdir(snapshot);
  await checked("tar", ["-xpf", archivePath, "-C", snapshot, "--no-same-owner"]);
  await fs.chmod(snapshot, 0o755);
  if (!(await fs.stat(path.join(snapshot, binding.config.cdk_app_path)).catch(() => undefined))?.isDirectory()) throw new Error(`CDK app path '${binding.config.cdk_app_path}' is not a committed directory`);
  await fs.mkdir(evidence, {mode: 0o777});
  await fs.chmod(evidence, 0o777);
  const container = `mdlm-deployment-synth-${randomUUID()}`;
  let attempted = false;
  try {
    attempted = true;
    await checked("docker", ["create", "--name", container, "--network", "none", "--read-only",
      "--user", process.getuid?.() ? `${process.getuid()}:${process.getgid!()}` : "65534:65534",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "128", "--shm-size=128m", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
      "--mount", `type=bind,source=${snapshot},target=/product,readonly`,
      "--mount", `type=bind,source=${evidence},target=/evidence`,
      "--env", "HOME=/tmp", "--env", "CDK_DISABLE_VERSION_CHECK=1",
      "--env", `MDLM_PRODUCT_COMMIT=${binding.sourceCommit}`, "--env", `MDLM_STACK_NAME=${binding.stack}`, "--env", `CDK_DEFAULT_REGION=${binding.config.region}`,
      "--workdir", path.posix.join("/product", binding.config.cdk_app_path),
      "--entrypoint", "cdk", binding.config.synth_image, "synth", "--quiet", "--no-notices", "--output", "/evidence/cdk.out"], SYNTH_TIMEOUT_MS);
    result.source!.synthImageId = (await checked("docker", ["inspect", "--format", "{{.Image}}", container])).toString("utf8").trim();
    await checked("docker", ["start", container], SYNTH_TIMEOUT_MS);
    const wait = await execute("docker", ["wait", container], SYNTH_TIMEOUT_MS);
    const logs = await execute("docker", ["logs", container], 30_000);
    const state = JSON.parse((await checked("docker", ["inspect", "--format", "{{json .State}}", container])).toString("utf8")) as {Running: boolean; ExitCode: number; Error: string; OOMKilled: boolean};
    result.synth = {exitCode: state.Running ? null : state.ExitCode, stdoutBase64: logs.stdout.toString("base64"), stderrBase64: logs.stderr.toString("base64")};
    if (wait.problem || wait.exitCode !== 0) throw new Error(wait.problem ?? "Docker wait failed during synth.");
    if (state.Error || state.OOMKilled || state.Running || state.ExitCode !== 0) throw new Error(`cdk synth did not finish successfully (exit ${state.ExitCode}${state.Error ? `: ${state.Error}` : ""}).`);
  } finally {
    if (attempted) await execute("docker", ["rm", "--force", "--volumes", container], 30_000);
  }
  return path.join(evidence, "cdk.out");
}

async function walk(root: string, at = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(path.join(root, at), {withFileTypes: true})) {
    const name = at ? `${at}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Cloud assembly contains a symlink: ${name}`);
    if (entry.isDirectory()) files.push(...await walk(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Cloud assembly contains a non-regular file: ${name}`);
  }
  return files.sort();
}

/** Only materialized in-assembly file assets may reach the host. Anything the CDK CLI would build or run there is refused. */
export async function validateCloudAssembly(assembly: string, expected: {stack: string; region: string}): Promise<NonNullable<DeploymentResult["assembly"]>> {
  const refuse = (message: string): never => { throw new Error(`Cloud assembly refused: ${message}`); };
  const files = await walk(assembly);
  const inside = (field: string, value: unknown) => {
    if (!relative(value)) refuse(`${field} '${String(value)}' must be a relative path inside the assembly`);
    return value as string;
  };
  const json = async (file: string) => { try { return JSON.parse(await fs.readFile(path.join(assembly, file), "utf8")) as unknown; } catch { return refuse(`${file} is not readable JSON`); } };
  const fileDigest = (name: string) => fs.readFile(path.join(assembly, name)).then(sha256);
  if (!files.includes("manifest.json")) refuse("manifest.json is missing");
  const manifest = await json("manifest.json");
  if (!object(manifest) || !object(manifest.artifacts)) refuse("manifest.json has no artifacts");
  const stacks: [string, Record<string, any>][] = [], assets: NonNullable<DeploymentResult["assembly"]>["assets"] = [];
  for (const [id, artifact] of Object.entries((manifest as Record<string, any>).artifacts as Record<string, unknown>)) {
    if (!object(artifact)) refuse(`artifact '${id}' is malformed`);
    const a = artifact as Record<string, any>;
    for (const entries of Object.values(object(a.metadata) ? a.metadata : {})) {
      if (Array.isArray(entries) && entries.some(entry => object(entry) && entry.type === "aws:cdk:asset")) refuse(`artifact '${id}' declares a legacy asset that the host would build`);
    }
    if (a.type === "aws:cloudformation:stack") stacks.push([id, a]);
    else if (a.type === "cdk:asset-manifest") {
      const file = inside(`artifact '${id}' file`, a.properties?.file);
      if (!files.includes(file)) refuse(`asset manifest '${file}' is missing`);
      const assetManifest = await json(file);
      if (!object(assetManifest)) refuse(`asset manifest '${file}' is malformed`);
      const m = assetManifest as Record<string, any>;
      if (object(m.dockerImages) && Object.keys(m.dockerImages).length) refuse(`asset manifest '${file}' declares Docker image assets`);
      for (const [assetId, asset] of Object.entries(object(m.files) ? m.files as Record<string, any> : {})) {
        const source = object(asset) ? asset.source : undefined;
        if (!object(source)) refuse(`file asset '${assetId}' has no source`);
        if (source.executable !== undefined) refuse(`file asset '${assetId}' declares an executable source`);
        const assetPath = inside(`file asset '${assetId}' path`, source.path);
        const packaging = source.packaging ?? "file";
        if (!["file", "zip"].includes(packaging)) refuse(`file asset '${assetId}' uses unsupported packaging '${String(packaging)}'`);
        let digest: string;
        if (files.includes(assetPath)) digest = await fileDigest(assetPath);
        else {
          const members = files.filter(name => name.startsWith(`${assetPath}/`));
          if (!members.length || packaging !== "zip") refuse(`file asset '${assetId}' is not materialized in the assembly`);
          // A directory digest covers every member path and its bytes in a fixed order.
          digest = sha256((await Promise.all(members.map(async name => `${name.slice(assetPath.length + 1)}\0${await fileDigest(name)}\n`))).join(""));
        }
        assets.push({id: assetId, packaging, path: assetPath, sha256: digest});
      }
    } else if (a.type !== "cdk:tree") refuse(`artifact '${id}' has unsupported type '${String(a.type)}'`);
  }
  if (stacks.length !== 1) refuse(`expected exactly one stack, found ${stacks.length}`);
  const [stackId, stack] = stacks[0]!;
  const name = stack.properties?.stackName ?? stackId;
  if (name !== expected.stack) refuse(`stack '${String(name)}' differs from the selected slot '${expected.stack}'`);
  const environment = /^aws:\/\/[^/]+\/([^/]+)$/.exec(String(stack.environment))?.[1];
  if (environment !== expected.region && environment !== "unknown-region") refuse(`stack environment '${String(stack.environment)}' differs from region '${expected.region}'`);
  const template = inside("stack templateFile", stack.properties?.templateFile);
  if (!files.includes(template)) refuse(`stack template '${template}' is missing`);
  return {templateSha256: await fileDigest(template), assets: assets.sort((a, b) => a.id.localeCompare(b.id))};
}

async function describeStack(binding: DeploymentBinding): Promise<Record<string, any> | undefined> {
  const described = await execute("aws", ["cloudformation", "describe-stacks", "--stack-name", binding.stack, "--region", binding.config.region, "--output", "json"], 60_000, hostEnvironment(binding));
  if (described.exitCode !== 0 && !described.problem && /does not exist/.test(described.stderr.toString("utf8"))) return undefined;
  if (described.problem || described.exitCode !== 0) throw new Error(hostFailure("aws cloudformation describe-stacks", described));
  const stack = (JSON.parse(described.stdout.toString("utf8")) as {Stacks?: Record<string, any>[]}).Stacks?.[0];
  return stack?.StackStatus === "DELETE_COMPLETE" ? undefined : stack;
}

async function probe(url: string, expected: string): Promise<NonNullable<DeploymentResult["probe"]>> {
  const base = {url, expectedVersion: expected};
  try {
    const response = await fetch(url, {redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)});
    const body = Buffer.from(await response.arrayBuffer());
    return {...base, status: response.status, matched: response.ok && body.toString("utf8").includes(expected), bodyBase64: body.subarray(0, PROBE_BODY_LIMIT).toString("base64")};
  } catch {
    return {...base, status: null, matched: false, bodyBase64: ""};
  }
}

/** One deployment attempt. It never retries; the caller persists the started marker first. */
export async function executeDeployment(binding: DeploymentBinding): Promise<DeploymentResult> {
  const result: DeploymentResult = {outcome: "error", phase: "source", deployAttempted: false, startedAt: new Date().toISOString(), finishedAt: ""};
  const directory = await fs.mkdtemp(path.join(tmpdir(), "mdlm-deployment-"));
  const env = hostEnvironment(binding);
  try {
    const source = await authenticateProductSource(binding);
    const version = await execute("cdk", ["--version"], 60_000, env);
    if (version.problem || version.exitCode !== 0) throw new Error(hostFailure("Host cdk --version", version));
    const hostCdkVersion = version.stdout.toString("utf8").trim().split(/\s+/)[0] ?? "";
    if (hostCdkVersion !== binding.config.cdk_cli_version) throw new Error(`Host CDK CLI ${hostCdkVersion || "(unknown)"} differs from the package's pinned ${binding.config.cdk_cli_version}`);
    result.source = {commit: source.sourceCommit, tree: source.sourceTree, appPath: binding.config.cdk_app_path, synthImage: binding.config.synth_image, synthImageId: null, hostCdkVersion};

    result.phase = "synth";
    const assembly = await synthesize(binding, directory, result);
    result.phase = "validation";
    result.assembly = await validateCloudAssembly(assembly, {stack: binding.stack, region: binding.config.region});

    result.phase = "access";
    const identity = await execute("aws", ["sts", "get-caller-identity", "--output", "json"], 60_000, env);
    if (identity.problem || identity.exitCode !== 0) throw new Error(hostFailure("aws sts get-caller-identity", identity));
    const caller = JSON.parse(identity.stdout.toString("utf8")) as {Account?: string; Arn?: string};
    if (!/^\d{12}$/.test(String(caller.Account)) || !nonEmpty(caller.Arn)) throw new Error("aws sts get-caller-identity returned no account and caller ARN");
    result.access = {apmProject: binding.config.apm_project, callerArn: caller.Arn, account: caller.Account!};
    const existing = await describeStack(binding);
    if (existing) throw new Error(`Stack slot '${binding.stack}' already holds stack ${String(existing.StackId)} (${String(existing.StackStatus)}); tear it down before deploying`);

    result.phase = "deploy";
    result.deployAttempted = true;
    const deployed = await execute("cdk", ["deploy", "--app", assembly, "--require-approval", "never", "--ci", "--no-notices", binding.stack], HOST_TIMEOUT_MS, env);
    result.deploy = {exitCode: deployed.exitCode, stdoutBase64: deployed.stdout.toString("base64"), stderrBase64: deployed.stderr.toString("base64")};
    if (deployed.problem || deployed.exitCode !== 0) throw new Error(hostFailure("cdk deploy", deployed));

    result.phase = "stack";
    const stack = await describeStack(binding);
    if (!stack || !/_COMPLETE$/.test(String(stack.StackStatus)) || /ROLLBACK|DELETE/.test(String(stack.StackStatus))) throw new Error(`Stack '${binding.stack}' is not deployed after cdk deploy (${String(stack?.StackStatus ?? "absent")})`);
    const account = /^arn:aws[a-z-]*:cloudformation:[^:]+:(\d{12}):/.exec(String(stack.StackId))?.[1];
    if (account !== result.access.account) throw new Error("Deployed stack account differs from the caller identity");
    result.stack = {account, region: binding.config.region, name: binding.stack, id: String(stack.StackId), status: String(stack.StackStatus), lastUpdatedTime: String(stack.LastUpdatedTime ?? stack.CreationTime)};
    const outputs = new Map((Array.isArray(stack.Outputs) ? stack.Outputs as {OutputKey?: string; OutputValue?: string}[] : []).map(o => [o.OutputKey, o.OutputValue]));
    result.outputs = Object.fromEntries(binding.config.output_allowlist.filter(name => typeof outputs.get(name) === "string").map(name => [name, outputs.get(name)!]));
    const endpoint = result.outputs[binding.config.endpoint_output];
    if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error(`Allowlisted endpoint output '${binding.config.endpoint_output}' is missing or not an HTTP(S) URL`);
    result.endpoint = endpoint;
    result.expiresAt = new Date(Date.now() + binding.config.max_lifetime_minutes * 60_000).toISOString();

    result.phase = "probe";
    result.probe = await probe(`${endpoint.replace(/\/+$/, "")}${binding.config.probe_path}`, binding.sourceCommit);
    if (!result.probe.matched) throw new Error(`Version probe ${result.probe.url} did not return product commit ${binding.sourceCommit} (status ${result.probe.status ?? "unreachable"})`);
    result.deployedVersion = binding.sourceCommit;
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

const exec = promisify(execFile);
async function git(root: string, args: string[]) {
  return (await exec("git", ["-C", root, ...args], {env: repositoryGitEnvironment(), maxBuffer: 64 * 1024 * 1024})).stdout.trim();
}
export interface DeploymentReceipt {binding: DeploymentBinding; attempt: 1; state: "started" | "completed"; result?: DeploymentResult}
export const deploymentRef = (operation: string) => `refs/mdlm/deployment/${operation}`;
export async function readDeploymentReceiptBlob(root: string, oid: string): Promise<{oid: string; receipt: DeploymentReceipt}> {
  if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error("Deployment receipt must name an exact Git blob");
  const receipt = JSON.parse(await git(root, ["cat-file", "blob", oid])) as DeploymentReceipt;
  if (receipt?.binding?.contract !== "mdlm-deployment@1") throw new Error("Git blob is not a deployment receipt");
  return {oid, receipt};
}
async function latestDeployment(root: string, operation: string) {
  const oid = await git(root, ["rev-parse", "--verify", "--quiet", `${deploymentRef(operation)}/latest`]).catch(error => { if (error.code === 1) return undefined; throw error; });
  return oid ? readDeploymentReceiptBlob(root, oid) : undefined;
}

/** A started marker is durable before anything runs. An interrupted deployment is never re-run:
 * its next step is teardown or an orphan check (ADR-0009 section 1). */
export async function runDeploymentReceipt(root: string, binding: DeploymentBinding, execute = executeDeployment) {
  const previous = await latestDeployment(root, binding.operation);
  if (previous) {
    if (!isDeepStrictEqual(previous.receipt.binding, binding)) throw new Error("Deployment operation already exists with different inputs");
    if (previous.receipt.state === "completed") return previous;
    throw new Error("Previous deployment attempt did not complete. It may have changed AWS; tear down the slot and check for orphans. A deployment is never re-run automatically.");
  }
  const persist = async (receipt: DeploymentReceipt, expected: string) => {
    const directory = path.join(root, ".lifecycle/work", "deployment", binding.operation);
    await fs.mkdir(directory, {recursive: true});
    const file = path.join(directory, `1-${receipt.state === "completed" ? "receipt" : "started"}.json`);
    await fs.writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, {flag: "wx"});
    const oid = await git(root, ["hash-object", "-w", file]);
    await git(root, ["update-ref", `${deploymentRef(binding.operation)}/attempt-1-${receipt.state === "completed" ? "receipt" : "started"}`, oid, "0".repeat(40)]);
    await git(root, ["update-ref", `${deploymentRef(binding.operation)}/latest`, oid, expected]);
    return oid;
  };
  const started = await persist({binding, attempt: 1, state: "started"}, "0".repeat(40));
  const result = await execute(binding);
  // D3 (#1129) CALL SITE: scan the synth streams, host CDK CLI output, stack outputs and
  // probe body here and refuse the receipt on a secret-pattern match, before it is written.
  const receipt: DeploymentReceipt = {binding, attempt: 1, state: "completed", result};
  return {oid: await persist(receipt, started), receipt};
}

export async function inspectDeployment(root: string, operation: string) {
  const saved = await latestDeployment(root, operation);
  return saved ? {...saved, ...(saved.receipt.state === "completed" ? {evidence: `git-blob:${saved.oid}`} : {})} : {state: "not-started"};
}

/** Authenticate a cited receipt against the current exact product and package-fixed configuration. */
export async function validateDeploymentReceipt(root: string, state: {pkg: ProcessPackage; package: unknown; data: DatumEnvelope[]}, locator: string, product: string) {
  if (!/^git-blob:[a-f0-9]{40}$/.test(locator)) throw new Error("Deployment evidence requires an exact receipt blob");
  const saved = await readDeploymentReceiptBlob(root, locator.slice(9));
  const {binding, result} = saved.receipt;
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(String(binding.operation))) throw new Error("Deployment receipt names an invalid operation");
  const registered = await git(root, ["rev-parse", "--verify", `${deploymentRef(binding.operation)}/attempt-1-receipt`]).catch(() => "");
  if (registered !== saved.oid || saved.receipt.state !== "completed" || !result) throw new Error("A completed deployment receipt registered to its operation is required");
  const expected = deploymentRunBinding(state, product, binding.operation, {stack: binding.stack, awsProfile: binding.awsProfile});
  if (!isDeepStrictEqual(expected, binding)) throw new Error("Deployment receipt does not match this exact product, package and deployment configuration");
  if (result.outcome === "pass") {
    const source = await authenticateProductSource(binding);
    if (result.source?.commit !== source.sourceCommit || result.source.tree !== source.sourceTree || result.deployedVersion !== binding.sourceCommit || !result.probe?.matched || !result.stack || !result.endpoint) throw new Error("Deployment receipt contradicts its pass outcome");
  }
  return {saved, managed: {
    outcome: result.outcome, receipt: locator,
    ...(result.stack ? {stack: {account: result.stack.account, region: result.stack.region, name: result.stack.name, id: result.stack.id, last_updated_time: result.stack.lastUpdatedTime}} : {}),
    ...(result.outputs ? {outputs: result.outputs} : {}),
    ...(result.endpoint ? {endpoint: result.endpoint} : {}),
    ...(result.deployedVersion ? {deployed_version: result.deployedVersion} : {}),
    ...(result.expiresAt ? {expires_at: result.expiresAt} : {}),
  }};
}
