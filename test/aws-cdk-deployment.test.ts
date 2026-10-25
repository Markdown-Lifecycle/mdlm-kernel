import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { expect, test } from "vitest";
import { installedProcessPackageRoot } from "../src/installed-process-package.js";
import { initializeRepositoryFromProcessPackage } from "../src/repository-initialization.js";
import { loadProcessPackage } from "../src/index.js";
import { runDeploymentReceipt } from "../src/aws-cdk-deployment.js";
import { requireDeploymentDryRun } from "../src/deployment-dry-run.js";

const run = promisify(execFile);
const config = {
  synth_image: `cdk-synth@sha256:${"c".repeat(64)}`, cdk_cli_version: "2.1000.0", cdk_app_path: "infra", region: "us-east-1", apm_project: "mdlm-demo",
  stack_slots: ["mdlm-demo-credit", "mdlm-demo-dry-1"], dry_run_slots: ["mdlm-demo-dry-1"], output_allowlist: ["ApiEndpoint"], endpoint_output: "ApiEndpoint", probe_path: "/version", max_lifetime_minutes: 240,
  resource_allowlist: ["AWS::Lambda::Function", "AWS::ApiGatewayV2::Api", "AWS::DynamoDB::Table", "AWS::Logs::LogGroup"],
};

// Stand-ins on PATH. They keep state beside themselves because the kernel gives host
// commands a minimal environment and the synth container only its own --env values.
const fakeDocker = String.raw`
const fs = require("node:fs"), path = require("node:path"), {spawnSync} = require("node:child_process");
const state = path.join(__dirname, "state", "containers"); fs.mkdirSync(state, {recursive: true});
const [command, ...rest] = process.argv.slice(2), file = name => path.join(state, name + ".json");
if (command === "create") {
  fs.appendFileSync(path.join(__dirname, "state", "docker-create.log"), JSON.stringify(rest) + "\n");
  const c = {mounts: [], env: {}}, valued = ["--name", "--network", "--user", "--cap-drop", "--security-opt", "--pids-limit", "--tmpfs", "--mount", "--env", "--workdir", "--entrypoint"];
  let i = 0;
  for (; i < rest.length && rest[i].startsWith("--"); i++) {
    const flag = rest[i]; if (!valued.includes(flag)) continue; const value = rest[++i];
    if (flag === "--mount") c.mounts.push(Object.fromEntries(value.split(",").map(p => p.split("="))));
    else if (flag === "--env") c.env[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
    else c[flag.slice(2)] = value;
  }
  c.image = rest[i]; c.args = rest.slice(i + 1);
  fs.writeFileSync(file(c.name), JSON.stringify(c)); console.log("fake-container"); process.exit(0);
}
const name = rest.at(-1), c = JSON.parse(fs.readFileSync(file(name), "utf8"));
const host = value => c.mounts.reduce((v, m) => v.startsWith(m.target) ? m.source + v.slice(m.target.length) : v, value);
if (command === "start") {
  const r = spawnSync(c.entrypoint, c.args.map(host), {cwd: host(c.workdir), env: {...c.env, PATH: process.env.PATH}});
  Object.assign(c, {stdout: String(r.stdout), stderr: String(r.stderr), exit: r.status}); fs.writeFileSync(file(name), JSON.stringify(c));
} else if (command === "wait") console.log(c.exit);
else if (command === "logs") { process.stdout.write(c.stdout); process.stderr.write(c.stderr); }
else if (command === "inspect") console.log(rest[1] === "{{.Image}}" ? "sha256:" + "1".repeat(64) : JSON.stringify({Running: false, ExitCode: c.exit, Error: "", OOMKilled: false}));
else if (command === "rm") fs.rmSync(file(name));
`;
const fakeCdk = String.raw`
const fs = require("node:fs"), path = require("node:path");
const state = path.join(__dirname, "state"), args = process.argv.slice(2), bump = name => fs.appendFileSync(path.join(state, name), "x");
if (args[0] === "--version") { console.log("2.1000.0 (build fake)"); process.exit(0); }
if (args[0] === "synth") {
  fs.writeFileSync(path.join(state, "synth-env.json"), JSON.stringify(process.env));
  const out = args[args.indexOf("--output") + 1], {scenario, bake} = JSON.parse(fs.readFileSync("fixture.json", "utf8"));
  const stack = process.env.MDLM_STACK_NAME, write = (name, value) => { fs.mkdirSync(path.dirname(path.join(out, name)), {recursive: true}); fs.writeFileSync(path.join(out, name), typeof value === "string" ? value : JSON.stringify(value)); };
  // The leak scenario's app prints a key and bakes it into the version the probe returns.
  const leaked = scenario === "leak" ? " AKIA" + "LEAKEDKEY0000000" : "";
  if (leaked) console.error("debug" + leaked);
  write("asset.abc/index.js", "export const version = " + JSON.stringify((bake ?? process.env.MDLM_PRODUCT_COMMIT) + leaked) + ";\n");
  const Delete = {DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete"};
  write(stack + ".template.json", {Resources: {
    Fn: {Type: "AWS::Lambda::Function", Properties: {ReservedConcurrentExecutions: 10, LoggingConfig: {LogGroup: {Ref: "Logs"}}}}, Perm: {Type: "AWS::Lambda::Permission", Properties: {FunctionName: {"Fn::GetAtt": ["Fn", "Arn"]}}},
    Api: {Type: "AWS::ApiGatewayV2::Api", Properties: {ProtocolType: "HTTP"}}, Route: {Type: "AWS::ApiGatewayV2::Route", Properties: {ApiId: {Ref: "Api"}}},
    Stage: {Type: "AWS::ApiGatewayV2::Stage", Properties: {ApiId: {Ref: "Api"}, DefaultRouteSettings: {ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10}}},
    Logs: {Type: "AWS::Logs::LogGroup", Properties: {RetentionInDays: 1}, ...Delete}, Table: {Type: "AWS::DynamoDB::Table", Properties: {BillingMode: "PAY_PER_REQUEST"}, ...Delete},
    ...(scenario === "custom" ? {Cleanup: {Type: "Custom::S3AutoDeleteObjects"}} : {})}, Outputs: {ApiEndpoint: {Value: "x"}, Secret: {Value: "y"}}});
  const source = scenario === "executable" ? {executable: ["sh", "-c", "touch /tmp/pwned"]} : {path: scenario === "escape" ? "../outside" : "asset.abc", packaging: "zip"};
  write((scenario === "nested" ? "nested/" : "") + stack + ".assets.json", {version: "36.0.0", files: {abc: {source, destinations: {}}}, dockerImages: scenario === "docker" ? {img: {source: {directory: "asset.abc"}, destinations: {}}} : {}});
  write("manifest.json", {version: "36.0.0", artifacts: {
    [stack]: {type: "aws:cloudformation:stack", environment: "aws://unknown-account/us-east-1", properties: {templateFile: stack + ".template.json", stackName: stack}},
    [stack + ".assets"]: {type: "cdk:asset-manifest", properties: {file: (scenario === "nested" ? "nested/" : "") + stack + ".assets.json"}},
  }});
  if (scenario === "cache") write(".cache/abc.zip", "different bytes than the validated asset");
  if (scenario === "symlink") fs.symlinkSync("/etc/hosts", path.join(out, "asset.abc", "hosts"));
  process.exit(0);
}
if (args[0] === "deploy") {
  bump("deploys"); fs.writeFileSync(path.join(state, "deploy-env.json"), JSON.stringify(process.env));
  fs.writeFileSync(path.join(state, "deploy-cwd.json"), JSON.stringify({cwd: process.cwd(), entries: fs.readdirSync(process.cwd())}));
  const app = args[args.indexOf("--app") + 1], stack = args.at(-1);
  const baked = /"(.*)"/.exec(fs.readFileSync(path.join(app, "asset.abc", "index.js"), "utf8"))[1];
  fs.writeFileSync(path.join(state, "deployed-version"), baked);
  const endpoint = JSON.parse(fs.readFileSync(path.join(state, "config.json"), "utf8")).endpoint;
  // Stack tags propagate to taggable resources, as CloudFormation does; children carry none.
  const db = fs.existsSync(path.join(state, "aws.json")) ? JSON.parse(fs.readFileSync(path.join(state, "aws.json"), "utf8")) : {stacks: [], resources: []};
  const Tags = args.flatMap((arg, i) => arg === "--tags" ? [{Key: args[i + 1].slice(0, args[i + 1].indexOf("=")), Value: args[i + 1].slice(args[i + 1].indexOf("=") + 1)}] : []);
  const StackId = "arn:aws:cloudformation:us-east-1:123456789012:stack/" + stack + "/fake-" + db.stacks.length;
  db.stacks.push({StackId, StackName: stack, StackStatus: "CREATE_COMPLETE", CreationTime: "2026-10-21T00:00:00Z", Tags, Outputs: [{OutputKey: "ApiEndpoint", OutputValue: endpoint}, {OutputKey: "Secret", OutputValue: "not-allowlisted"}]});
  const manifest = JSON.parse(fs.readFileSync(path.join(app, "manifest.json"), "utf8")), template = JSON.parse(fs.readFileSync(path.join(app, manifest.artifacts[stack].properties.templateFile), "utf8"));
  const arns = {"AWS::Lambda::Function": id => "arn:aws:lambda:us-east-1:123456789012:function:" + id, "AWS::ApiGatewayV2::Api": id => "arn:aws:apigateway:us-east-1::/apis/" + id,
    "AWS::DynamoDB::Table": id => "arn:aws:dynamodb:us-east-1:123456789012:table/" + id, "AWS::Logs::LogGroup": id => "arn:aws:logs:us-east-1:123456789012:log-group:" + id};
  for (const [logicalId, {Type}] of Object.entries(template.Resources)) {
    const physicalId = (Type === "AWS::Logs::LogGroup" ? "/aws/lambda/" : "") + stack + "-" + db.stacks.length + "-" + logicalId;
    db.resources.push({stackId: StackId, logicalId, type: Type, physicalId, ...(arns[Type] ? {arn: arns[Type](physicalId), tags: Tags} : {})});
  }
  fs.writeFileSync(path.join(state, "aws.json"), JSON.stringify(db));
  console.log("deployed " + stack + " version " + baked); process.exit(0);
}
process.exit(2);
`;
const fakeAws = String.raw`
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);
if (process.env.AWS_PROFILE !== "apm-mdlm-demo" || process.env.AWS_ACCESS_KEY_ID) { console.error("unexpected credentials"); process.exit(255); }
if (args[0] === "sts" && args[1] === "get-caller-identity") { console.log(JSON.stringify({Account: "123456789012", Arn: "arn:aws:sts::123456789012:assumed-role/apm-mdlm-demo/session", UserId: "AROAEXAMPLE:session"})); process.exit(0); }
const file = path.join(__dirname, "state", "aws.json"), db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {stacks: [], resources: []};
const save = () => fs.writeFileSync(file, JSON.stringify(db)), option = name => args[args.indexOf(name) + 1], done = value => { if (value !== undefined) console.log(JSON.stringify(value)); process.exit(0); };
const missing = (code = "ResourceNotFoundException") => { console.error("An error occurred (" + code + ") when calling the operation: not found"); process.exit(254); };
if (args[0] === "cloudformation") {
  const name = option("--stack-name"), stack = name.startsWith("arn:") ? db.stacks.find(s => s.StackId === name) : db.stacks.find(s => s.StackName === name && s.StackStatus !== "DELETE_COMPLETE");
  if (!stack) { console.error("An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id x does not exist"); process.exit(254); }
  if (args[1] === "describe-stacks") done({Stacks: [stack]});
  if (args[1] === "list-stack-resources") done({StackResourceSummaries: db.resources.filter(r => r.stackId === stack.StackId).map(r => ({LogicalResourceId: r.logicalId, PhysicalResourceId: r.physicalId, ResourceType: r.type, ResourceStatus: "CREATE_COMPLETE"}))});
  if (args[1] === "delete-stack") {
    // With fail-delete present the table survives and the stack ends DELETE_FAILED.
    const failing = fs.existsSync(path.join(__dirname, "state", "fail-delete"));
    db.resources = db.resources.filter(r => r.stackId !== stack.StackId || (failing && r.type === "AWS::DynamoDB::Table"));
    stack.StackStatus = failing ? "DELETE_FAILED" : "DELETE_COMPLETE"; save(); done();
  }
  if (args[1] === "wait") { if (stack.StackStatus === "DELETE_COMPLETE") done(); console.error("Waiter StackDeleteComplete failed: Waiter encountered a terminal failure state"); process.exit(255); }
}
if (args[0] === "resourcegroupstaggingapi" && args[1] === "get-resources" && args.includes("--resource-arn-list")) {
  const wanted = args.slice(args.indexOf("--resource-arn-list") + 1).filter(arg => arg.startsWith("arn:"));
  done({ResourceTagMappingList: db.resources.filter(r => wanted.includes(r.arn) && r.tags).map(r => ({ResourceARN: r.arn, Tags: r.tags}))});
}
if (args[0] === "resourcegroupstaggingapi" && args[1] === "get-resources") {
  const filters = args.filter(arg => arg.startsWith("Key=")).map(arg => /^Key=([^,]+),Values=(.*)$/.exec(arg));
  const tagged = [...db.stacks.filter(s => s.StackStatus !== "DELETE_COMPLETE").map(s => ({arn: s.StackId, tags: s.Tags})), ...db.resources.filter(r => r.arn && r.tags)];
  done({ResourceTagMappingList: tagged.filter(r => filters.every(([, key, value]) => r.tags.some(t => t.Key === key && t.Value === value))).map(r => ({ResourceARN: r.arn, Tags: r.tags}))});
}
const resources = {lambda: ["AWS::Lambda::Function", "--function-name", "ResourceNotFoundException"], apigatewayv2: ["AWS::ApiGatewayV2::Api", "--api-id", "NotFoundException"],
  dynamodb: ["AWS::DynamoDB::Table", "--table-name", "ResourceNotFoundException"], logs: ["AWS::Logs::LogGroup", "--log-group-name", "ResourceNotFoundException"]};
if (resources[args[0]]) {
  const [type, flag, code] = resources[args[0]];
  if (args[1] === "describe-log-groups") done({logGroups: db.resources.filter(r => r.type === type && r.physicalId.startsWith(option("--log-group-name-prefix"))).map(r => ({logGroupName: r.physicalId}))});
  const found = db.resources.find(r => r.type === type && r.physicalId === option(flag));
  if (!found) missing(code);
  if (/^delete-/.test(args[1])) { db.resources.splice(db.resources.indexOf(found), 1); save(); fs.appendFileSync(path.join(__dirname, "state", "resource-deletes"), found.arn + "\n"); }
  done({});
}
process.exit(2);
`;

/** With `target`, the package binds a DTG target type and its deployment action fixes no config. */
async function fixturePackage(directory: string, options: {target?: boolean} = {}) {
  await fs.cp(installedProcessPackageRoot("iterative"), directory, {recursive: true});
  const schemaFile = path.join(directory, "meta/action-definition.schema.json");
  const schema = JSON.parse(await fs.readFile(schemaFile, "utf8"));
  schema.properties.capability.enum.push("deployment");
  await fs.writeFile(schemaFile, JSON.stringify(schema, null, 2));
  if (options.target) {
    // The package owns the binding meta-schema, so a target-configured package declares target_type there.
    const bindingFile = path.join(directory, "meta/capability-binding.schema.json"), binding = JSON.parse(await fs.readFile(bindingFile, "utf8"));
    binding.properties.target_type = binding.properties.implementation_type;
    await fs.writeFile(bindingFile, JSON.stringify(binding, null, 2));
  }
  const lifecycle = {authorship: "authored", freeze_when: "terminal-outcome", terminal_payload_field: "publication", terminal_values: ["recorded"]};
  const text = {type: "string", minLength: 1};
  const configSchema = {required: Object.keys(config), properties: Object.fromEntries(Object.keys(config).map(key => [key, {}]))};
  const fixed = options.target ? {required: [], properties: {target: text}} : configSchema;
  await fs.writeFile(path.join(directory, "types/PRD.yaml"), stringify({kind: "type-definition", id: "PRD", version: 1, name: "Product", description: "Deployable product", extends: "titled-datum@1", lifecycle,
    payload_schema: {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["publication", "repository_path", "source_commit"], properties: {publication: {const: "recorded"}, repository_path: text, source_commit: {type: "string", pattern: "^[a-f0-9]{40}$"}}},
    outgoing_links: [], kernel_managed_payload_paths: []}));
  await fs.writeFile(path.join(directory, "types/DPL.yaml"), stringify({kind: "type-definition", id: "DPL", version: 1, name: "Deployment", description: "Deployment record", extends: "titled-datum@1", lifecycle,
    payload_schema: {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["publication", ...fixed.required, "outcome", "receipt"], properties: {
      publication: {const: "recorded"}, ...fixed.properties,
      outcome: {enum: ["pass", "error"]}, receipt: text, stack: {type: "object"}, outputs: {type: "object"}, endpoint: text, deployed_version: text, expires_at: text}},
    outgoing_links: [{id: "deploys", description: "Exact product deployed", targets: [{kind: "datum", types: ["PRD"], identity: "revision"}], cardinality: {minimum: 1, maximum: 1}, freeze_resolution: "already-exact", inverse_label: "incoming-deploys"}],
    kernel_managed_payload_paths: ["outcome", "receipt", "stack", "outputs", "endpoint", "deployed_version", "expires_at", ...(options.target ? ["target"] : [])]}));
  const prompt = "prompts/frame-experiment.md@2";
  await fs.writeFile(path.join(directory, "actions/record-product.yaml"), stringify({kind: "action-definition", id: "record-product", version: 1, capability: "experiment", prompt_ref: prompt, types: ["PRD"], inputs: {}, when: "true", priority: 1, fixed_payload: {PRD: {publication: "recorded"}}}));
  await fs.writeFile(path.join(directory, "actions/deploy-product.yaml"), stringify({kind: "action-definition", id: "deploy-product", version: 1, capability: "deployment", prompt_ref: prompt, types: ["DPL"], inputs: {}, when: "true", priority: 1, fixed_payload: {DPL: {publication: "recorded", ...(options.target ? {} : config)}}}));
  if (options.target) {
    await fs.writeFile(path.join(directory, "types/DTG.yaml"), stringify({kind: "type-definition", id: "DTG", version: 1, name: "Deployment target", description: "Where a product deploys", extends: "titled-datum@1", lifecycle,
      payload_schema: {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["publication", ...configSchema.required], properties: {publication: {const: "recorded"}, ...configSchema.properties}},
      outgoing_links: [], kernel_managed_payload_paths: []}));
    await fs.writeFile(path.join(directory, "actions/record-target.yaml"), stringify({kind: "action-definition", id: "record-target", version: 1, capability: "experiment", prompt_ref: prompt, types: ["DTG"], inputs: {}, when: "true", priority: 1, fixed_payload: {DTG: {publication: "recorded"}}}));
  }
  const manifestFile = path.join(directory, "manifest.yaml"), manifest = parse(await fs.readFile(manifestFile, "utf8"));
  manifest.id = "mdlm-deployment-fixture";
  manifest.kernel_capabilities["aws-cdk-deployment@1"] = {type: "DPL", implementation_type: "PRD", action: "deploy-product", ...(options.target ? {target_type: "DTG"} : {})};
  await fs.writeFile(manifestFile, stringify(manifest));
}

/** A lifecycle repository on the fixture package, a product repository, and fake docker, cdk and aws on PATH. */
async function harness(root: string, options: {target?: boolean} = {}) {
  const fixture = path.join(root, "package"), repository = path.join(root, "lifecycle"), product = path.join(root, "product"), bin = path.join(root, "bin"), state = path.join(bin, "state");
  const server = createServer(async (request, response) => {
    if (request.url !== "/version") return void response.writeHead(404).end();
    response.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({version: await fs.readFile(path.join(state, "deployed-version"), "utf8")}));
  });
  await fixturePackage(fixture, options);
  const initialized = await initializeRepositoryFromProcessPackage(repository, fixture);
  expect(initialized.ok, JSON.stringify(initialized)).toBe(true);
  await fs.mkdir(state, {recursive: true});
  for (const [name, source] of [["docker", fakeDocker], ["cdk", fakeCdk], ["aws", fakeAws]] as const) await fs.writeFile(path.join(bin, name), `#!/usr/bin/env node\n${source}`, {mode: 0o755});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await fs.writeFile(path.join(state, "config.json"), JSON.stringify({endpoint: `http://127.0.0.1:${(server.address() as {port: number}).port}/`}));
  // Any inherited key material must never reach the host CDK CLI or the AWS CLI.
  const env = {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_PROFILE: "someone-else"};
  const cli = async (...args: string[]) => {
    const result = await run(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {cwd: repository, env, maxBuffer: 16 * 1024 * 1024}).catch(error => error);
    return {status: result.code ?? 0, json: JSON.parse(result.stdout)};
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
  const submit = async (proposal: any) => {
    const file = path.join(root, `${proposal.operation}.json`);
    await fs.writeFile(file, JSON.stringify(proposal));
    const result = await cli("proposal", "submit", file);
    expect(result.status, JSON.stringify(result.json)).toBe(0);
    git(repository, "add", "."); git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", proposal.operation);
    return result.json.revisions[0] as string;
  };
  const draft = async (action: string, operation: string) => {
    const file = path.join(root, `${operation}.draft.json`);
    expect((await cli("proposal", "draft", action, "--operation", operation, "--output", file)).status).toBe(0);
    return JSON.parse(await fs.readFile(file, "utf8"));
  };
  await fs.mkdir(path.join(product, "infra"), {recursive: true});
  git(product, "init", "-q");
  const products: Record<string, {commit: string; revision: string}> = {};
  const recordProduct = async (scenario: string, extra: Record<string, unknown> = {}) => {
    await fs.writeFile(path.join(product, "infra/fixture.json"), JSON.stringify({scenario, ...extra}));
    git(product, "add", "."); git(product, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", scenario);
    const commit = git(product, "rev-parse", "HEAD"), proposal = await draft("record-product", `product-${scenario}`);
    Object.assign(proposal.candidates[0].payload, {title: `Product ${scenario}`, repository_path: product, source_commit: commit});
    products[scenario] = {commit, revision: await submit(proposal)};
  };
  return {repository, product, state, server, cli, git, submit, draft, products, recordProduct};
}

test("deployment run synthesizes in the sandbox, refuses unsafe assemblies, deploys on the host and records a probed receipt", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-deployment-")));
  const {repository, product, state, server, cli, git, submit, draft, products, recordProduct} = await harness(root);
  try {
    for (const [scenario, extra] of [["ok", {}], ["executable", {}], ["docker", {}], ["escape", {}], ["symlink", {}], ["cache", {}], ["nested", {}], ["mismatch", {bake: "0".repeat(40)}], ["leak", {}], ["custom", {}]] as const) await recordProduct(scenario, extra);
    const deploy = (scenario: string, operation: string, stack = "mdlm-demo-credit", profile = "apm-mdlm-demo") => cli("deployment", "run", products[scenario]!.revision, operation, "--stack", stack, "--aws-profile", profile);
    const deploys = async () => (await fs.readFile(path.join(state, "deploys"), "utf8").catch(() => "")).length;

    // Only the package-named APM profile and a package stack slot are accepted.
    expect((await deploy("ok", "wrong-profile", "mdlm-demo-credit", "default")).json.diagnostics[0].message).toContain("--aws-profile apm-mdlm-demo");
    expect((await deploy("ok", "wrong-slot", "someone-elses-stack")).json.diagnostics[0].message).toContain("not one of the package's stack slots");
    // A package without target_type keeps its fixed config and takes no --target.
    expect((await cli("deployment", "run", products.ok!.revision, "with-target", "--stack", "mdlm-demo-credit", "--aws-profile", "apm-mdlm-demo", "--target", products.ok!.revision)).json.diagnostics[0].message).toContain("takes no --target");

    const passed = await deploy("ok", "deploy-ok");
    expect(passed.status, JSON.stringify(passed.json)).toBe(0);
    const result = passed.json.value.receipt.result;
    expect(result, JSON.stringify(result)).toMatchObject({outcome: "pass", phase: "probe", deployAttempted: true,
      source: {commit: products.ok!.commit, appPath: "infra", synthImage: config.synth_image, synthImageId: `sha256:${"1".repeat(64)}`, hostCdkVersion: "2.1000.0"},
      access: {apmProject: "mdlm-demo", account: "123456789012", callerArn: "arn:aws:sts::123456789012:assumed-role/apm-mdlm-demo/session"},
      stack: {account: "123456789012", region: "us-east-1", name: "mdlm-demo-credit", id: "arn:aws:cloudformation:us-east-1:123456789012:stack/mdlm-demo-credit/fake-0", status: "CREATE_COMPLETE"},
      deployedVersion: products.ok!.commit, probe: {matched: true, status: 200, expectedVersion: products.ok!.commit}});
    expect(result.outputs).toEqual({ApiEndpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/)});
    expect(result.assembly.templateSha256).toMatch(/^[a-f0-9]{64}$/);
    // The stack carries the required tags, and its resource inventory is recorded for teardown.
    const repositoryId = `git-commit:${git(repository, "rev-list", "--max-parents=0", "HEAD")}`;
    expect(result.tags).toEqual({"mdlm:repository": repositoryId, "mdlm:deployment": "deploy-ok", "mdlm:mode": "credit", "mdlm:expires-at": result.expiresAt});
    expect(result.inventory.map((entry: any) => entry.type).sort()).toEqual(["AWS::ApiGatewayV2::Api", "AWS::ApiGatewayV2::Route", "AWS::ApiGatewayV2::Stage", "AWS::DynamoDB::Table", "AWS::Lambda::Function", "AWS::Lambda::Permission", "AWS::Logs::LogGroup"]);
    expect(result.orphans).toEqual({checkedAt: expect.any(String), orphans: []});
    expect(result.assembly.assets).toEqual([{id: "abc", packaging: "zip", path: "asset.abc", sha256: expect.stringMatching(/^[a-f0-9]{64}$/)}]);
    // Synth ran with no network and no credentials; the host deploy saw only the APM profile.
    const created = (await fs.readFile(path.join(state, "docker-create.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(created.at(-1)!.join(" ")).toContain("--network none");
    expect(Object.keys(JSON.parse(await fs.readFile(path.join(state, "synth-env.json"), "utf8"))).filter(key => key.startsWith("AWS_"))).toEqual([]);
    expect(JSON.parse(await fs.readFile(path.join(state, "synth-env.json"), "utf8")).MDLM_PRODUCT_COMMIT).toBe(products.ok!.commit);
    const deployEnv = JSON.parse(await fs.readFile(path.join(state, "deploy-env.json"), "utf8"));
    expect([deployEnv.AWS_PROFILE, deployEnv.AWS_REGION, deployEnv.AWS_ACCESS_KEY_ID]).toEqual(["apm-mdlm-demo", "us-east-1", undefined]);
    // The host CDK CLI runs in an empty directory, so no cdk.json or plugin beside the caller is loaded.
    const deployCwd = JSON.parse(await fs.readFile(path.join(state, "deploy-cwd.json"), "utf8"));
    expect([deployCwd.cwd === repository, deployCwd.entries]).toEqual([false, []]);
    // The receipt is write-once; settlement and a repeated command never deploy again.
    expect(await deploys()).toBe(1);
    expect((await deploy("ok", "deploy-ok")).json.value.oid).toBe(passed.json.value.oid);
    expect((await cli("deployment", "settlement", "deploy-ok")).json.value.evidence).toBe(passed.json.value.evidence);
    expect(await deploys()).toBe(1);
    // An occupied slot is refused before cdk deploy runs.
    const occupied = (await deploy("ok", "deploy-occupied")).json.value.receipt.result;
    expect([occupied.outcome, occupied.phase, occupied.deployAttempted, occupied.diagnostic]).toEqual(["error", "access", false, expect.stringContaining("already holds stack")]);
    // The pre-deploy orphan check reports the unpublished deployment's stack before refusing the slot.
    expect(occupied.orphans.orphans).toContainEqual(expect.objectContaining({kind: "stack", slot: "mdlm-demo-credit", deployment: "deploy-ok", reason: expect.stringContaining("names no deployment record")}));

    // The kernel fills the deployment record from the authenticated receipt.
    const record = await draft("deploy-product", "record-deployment");
    Object.assign(record.candidates[0].payload, {title: "Credit deployment"});
    record.candidates[0].links = [{type: "deploys", target: products.ok!.revision}];
    record.evidence = {receipt: passed.json.value.evidence};
    const dpl = await submit(record);
    const published = (await cli("show", dpl)).json.lifecycleDatum.datum.payload;
    expect(published).toMatchObject({outcome: "pass", receipt: passed.json.value.evidence, endpoint: result.outputs.ApiEndpoint, deployed_version: products.ok!.commit, outputs: result.outputs, expires_at: result.expiresAt,
      stack: {account: "123456789012", region: "us-east-1", name: "mdlm-demo-credit", id: result.stack.id, last_updated_time: "2026-10-21T00:00:00Z"}});
    const duplicate = await draft("deploy-product", "record-duplicate");
    Object.assign(duplicate, {candidates: record.candidates, evidence: record.evidence});
    await fs.writeFile(path.join(root, "duplicate.json"), JSON.stringify(duplicate));
    expect((await cli("proposal", "submit", path.join(root, "duplicate.json"))).json.diagnostics[0].message).toContain("already published");

    // Registered receipts whose recorded facts contradict the values they would publish are refused.
    const original = (await cli("deployment", "settlement", "deploy-ok")).json.value.receipt;
    const forgeries: [string, (r: any) => void][] = [
      ["outputs", r => { r.result.outputs.Secret = "not-allowlisted"; }],
      ["endpoint", r => { r.result.endpoint = "https://elsewhere.example/"; }],
      ["probe", r => { r.result.probe.bodyBase64 = Buffer.from("{}").toString("base64"); }],
      ["stack", r => { r.result.stack.name = "mdlm-demo-dry-1"; }],
      ["stack", r => { r.result.stack.status = "ROLLBACK_COMPLETE"; }],
      ["tags", r => { r.result.tags["mdlm:expires-at"] = "2099-01-01T00:00:00.000Z"; }],
    ];
    for (const [index, [field, mutate]] of forgeries.entries()) {
      const forged = structuredClone(original); forged.binding.operation = forged.result.tags["mdlm:deployment"] = `forged-${index}`; mutate(forged);
      const oid = execFileSync("git", ["-C", repository, "hash-object", "-w", "--stdin"], {input: JSON.stringify(forged), encoding: "utf8"}).trim();
      git(repository, "update-ref", `refs/mdlm/deployment/forged-${index}/attempt-1-receipt`, oid);
      const proposal = await draft("deploy-product", `record-forged-${index}`);
      Object.assign(proposal, {candidates: record.candidates, evidence: {receipt: `git-blob:${oid}`}});
      await fs.writeFile(path.join(root, `forged-${index}.json`), JSON.stringify(proposal));
      expect((await cli("proposal", "submit", path.join(root, `forged-${index}.json`))).json.diagnostics[0].message, field).toContain(`receipt ${field} contradicts`);
    }

    // Assembly validation refuses before any AWS call, so nothing is deployed.
    await fs.rm(path.join(state, "aws.json"));
    for (const [scenario, message] of [["executable", "executable source"], ["docker", "Docker image assets"], ["escape", "inside the assembly"], ["symlink", "symlink"], ["cache", "publisher cache"], ["nested", "at the assembly root"], ["custom", "template policy: Cleanup (Custom::S3AutoDeleteObjects) is a custom resource"]]) {
      const refused = (await deploy(scenario!, `refuse-${scenario}`)).json.value.receipt.result;
      expect([refused.outcome, refused.phase, refused.deployAttempted], scenario).toEqual(["error", "validation", false]);
      expect(refused.diagnostic).toContain(message);
      expect(refused.access).toBeUndefined();
    }
    expect(await deploys()).toBe(1);

    // A deployed product whose version endpoint reports another commit is a deployment error.
    const drift = (await deploy("mismatch", "deploy-mismatch")).json.value.receipt.result;
    expect([drift.outcome, drift.phase, drift.deployAttempted, drift.probe.matched, drift.deployedVersion]).toEqual(["error", "probe", true, false, undefined]);
    expect(drift.diagnostic).toContain(`did not return product commit ${products.mismatch!.commit}`);
    expect(await deploys()).toBe(2);
    const misattributed = await draft("deploy-product", "record-misattributed");
    misattributed.candidates[0].payload.title = "Wrong product";
    misattributed.candidates[0].links = [{type: "deploys", target: products.ok!.revision}];
    misattributed.evidence = {receipt: (await cli("deployment", "settlement", "deploy-mismatch")).json.value.evidence};
    await fs.writeFile(path.join(root, "misattributed.json"), JSON.stringify(misattributed));
    expect((await cli("proposal", "submit", path.join(root, "misattributed.json"))).json.diagnostics[0].message).toContain("does not match this exact product");

    // A secret in synth output, host CDK CLI output or the probe body refuses the receipt.
    // Only the matching streams are emptied, so the record still says what reached AWS.
    const secret = "AKIA" + "LEAKEDKEY0000000";
    const leakRun = await deploy("leak", "deploy-leak", "mdlm-demo-dry-1");
    const leak = leakRun.json.value.receipt.result;
    expect([leak.outcome, leak.phase, leak.deployAttempted, leak.deploy.exitCode, leak.stack.name, leak.deployedVersion]).toEqual(["error", "probe", true, 0, "mdlm-demo-dry-1", products.leak!.commit]);
    expect(leak.secretFindings).toEqual(expect.arrayContaining(["synth.stderrBase64", "deploy.stdoutBase64", "probe.bodyBase64"].map(field => ({pattern: "aws-access-key-id", field, offset: expect.any(Number)}))));
    expect(leak.secretFindings).toHaveLength(3);
    expect([leak.synth.stderrBase64, leak.deploy.stdoutBase64, leak.probe.bodyBase64]).toEqual(["", "", ""]);
    expect(leak.diagnostic).toContain("aws-access-key-id in deploy.stdoutBase64");
    const leakFile = await fs.readFile(path.join(repository, ".lifecycle/work/deployment/deploy-leak/1-receipt.json"), "utf8");
    for (const copy of [JSON.stringify(leakRun.json), git(repository, "cat-file", "blob", leakRun.json.value.oid), leakFile]) {
      expect(copy).not.toContain(secret);
      expect(copy).not.toContain(Buffer.from(secret).toString("base64").slice(0, 16));
    }
    // The refused receipt still publishes as an error deployment, so teardown can follow it.
    const leakRecord = await draft("deploy-product", "record-leak");
    Object.assign(leakRecord.candidates[0].payload, {title: "Leaking deployment"});
    leakRecord.candidates[0].links = [{type: "deploys", target: products.leak!.revision}];
    leakRecord.evidence = {receipt: leakRun.json.value.evidence};
    const leakDpl = await submit(leakRecord);
    expect((await cli("show", leakDpl)).json.lifecycleDatum.datum.payload).toMatchObject({outcome: "error", stack: {name: "mdlm-demo-dry-1"}});

    // An interrupted attempt leaves its started marker and is never re-run.
    const binding = (await cli("deployment", "settlement", "deploy-ok")).json.value.receipt.binding;
    const interrupted = {...binding, operation: "interrupted"};
    await expect(runDeploymentReceipt(repository, interrupted, async () => { throw new Error("process killed"); })).rejects.toThrow("process killed");
    await expect(runDeploymentReceipt(repository, interrupted, async () => { throw new Error("must not run"); })).rejects.toThrow("never re-run");

    // Orphans: the mismatch deployment was never published, so its stack and tagged resources are orphans;
    // the published leak deployment in dry-1 is not.
    const profile = ["--aws-profile", "apm-mdlm-demo"];
    expect((await cli("deployment", "orphans", "--aws-profile", "default")).json.diagnostics[0].message).toContain("--aws-profile apm-mdlm-demo");
    const report = (await cli("deployment", "orphans", ...profile)).json.value;
    expect(report.orphans.filter((o: any) => o.kind === "stack")).toEqual([{kind: "stack", arn: expect.stringContaining("stack/mdlm-demo-credit/"), slot: "mdlm-demo-credit", status: "CREATE_COMPLETE", deployment: "deploy-mismatch", reason: expect.stringContaining("names no deployment record")}]);
    expect(report.orphans.filter((o: any) => o.kind === "resource").map((o: any) => o.deployment)).toEqual(["deploy-mismatch", "deploy-mismatch", "deploy-mismatch", "deploy-mismatch"]);

    // A deployment teardown deletes by stack ID and passes only when the stack, tag query and inventory checks all pass.
    const teardown = (dpl: string, operation: string) => cli("deployment", "teardown", dpl, operation, ...profile);
    const aws = async () => JSON.parse(await fs.readFile(path.join(state, "aws.json"), "utf8"));
    const torn = await teardown(leakDpl, "teardown-leak");
    expect(torn.status, JSON.stringify(torn.json)).toBe(0);
    const tornResult = torn.json.value.receipt.result;
    expect(tornResult, JSON.stringify(tornResult)).toMatchObject({outcome: "pass", phase: "verify", deleteAttempted: true, deployment: "deploy-leak",
      stack: {id: leak.stack.id, status: "DELETE_COMPLETE"}, remaining: {tagged: [], inventory: []}});
    expect(tornResult.inventory).toHaveLength(7);
    expect(tornResult.orphans.orphans.some((o: any) => o.deployment === "deploy-mismatch")).toBe(true);
    expect((await aws()).resources.filter((r: any) => r.stackId === leak.stack.id)).toEqual([]);
    // The receipt is write-once; repeating the command deletes nothing more.
    const stacksBefore = JSON.stringify((await aws()).stacks);
    expect((await teardown(leakDpl, "teardown-leak")).json.value.oid).toBe(torn.json.value.oid);
    expect(JSON.stringify((await aws()).stacks)).toBe(stacksBefore);

    // A dry run deploys only to a dry-run slot with a 2-hour lifetime, registers no refs and is never deployment evidence.
    const dryRun = (stack: string) => cli("deployment", "dry-run", products.ok!.revision, "--stack", stack, "--aws-profile", "apm-mdlm-demo");
    expect((await dryRun("mdlm-demo-credit")).json.diagnostics[0].message).toContain("not one of the package's dry-run slots");
    const dry = (await dryRun("mdlm-demo-dry-1")).json;
    expect(dry, JSON.stringify(dry)).toMatchObject({ok: true, contract: "mdlm-deployment-dry-run@1", credit: false, id: expect.stringMatching(/^dry-/),
      value: {state: "completed", binding: {contract: "mdlm-deployment-dry-run@1", operation: dry.id, stack: "mdlm-demo-dry-1", config: {max_lifetime_minutes: 120}}, result: {outcome: "pass", stack: {name: "mdlm-demo-dry-1"}, assembly: result.assembly}}});
    expect(git(repository, "for-each-ref", `refs/mdlm/deployment/${dry.id}`)).toBe("");
    expect(git(repository, "status", "--porcelain")).toBe("");
    const dryOid = git(repository, "hash-object", "-w", dry.record);
    git(repository, "update-ref", `refs/mdlm/deployment/${dry.id}/attempt-1-receipt`, dryOid);
    const dryCited = await draft("deploy-product", "record-dry-run");
    Object.assign(dryCited, {candidates: record.candidates, evidence: {receipt: `git-blob:${dryOid}`}});
    await fs.writeFile(path.join(root, "dry-cited.json"), JSON.stringify(dryCited));
    expect((await cli("proposal", "submit", path.join(root, "dry-cited.json"))).json.diagnostics[0].message).toContain("not a deployment receipt");
    // Execution dry runs may target it only for the commit it deployed, and key on its digests.
    expect(await requireDeploymentDryRun(repository, dry.id, {repositoryPath: product, sourceCommit: products.ok!.commit})).toEqual({id: dry.id, assembly: result.assembly});
    await expect(requireDeploymentDryRun(repository, dry.id, {repositoryPath: product, sourceCommit: products.leak!.commit})).rejects.toThrow("not product commit");

    // A dry run is tagged as one, ran the orphan check, is no orphan while its record is live, and tears down from its record.
    expect(dry.value.result.tags).toMatchObject({"mdlm:deployment": dry.id, "mdlm:mode": "dry-run"});
    expect(dry.value.result.orphans.orphans.some((o: any) => o.deployment === "deploy-mismatch")).toBe(true);
    expect((await cli("deployment", "orphans", ...profile)).json.value.orphans.some((o: any) => o.deployment === dry.id)).toBe(false);
    expect((await teardown(dry.id, "teardown-dry")).json.value.receipt.result).toMatchObject({outcome: "pass", deployment: dry.id, stack: {status: "DELETE_COMPLETE"}, remaining: {tagged: [], inventory: []}});

    // The template policy applies to dry runs too: nothing reaches AWS.
    const dryPolicy = (await cli("deployment", "dry-run", products.custom!.revision, "--stack", "mdlm-demo-dry-1", ...profile)).json.value.result;
    expect([dryPolicy.outcome, dryPolicy.phase, dryPolicy.deployAttempted, dryPolicy.access]).toEqual(["error", "validation", false, undefined]);
    expect(dryPolicy.diagnostic).toContain("template policy: Cleanup (Custom::S3AutoDeleteObjects) is a custom resource");


    // --orphan-stack deletes only a reported orphan in the slot pool.
    expect((await cli("deployment", "teardown", "orphan-empty", "--orphan-stack", "mdlm-demo-dry-1", ...profile)).json.value.receipt.result.diagnostic).toContain("holds no orphan");
    expect((await cli("deployment", "teardown", "orphan-elsewhere", "--orphan-stack", "someone-elses-stack", ...profile)).json.diagnostics[0].message).toContain("not one of the package's stack slots");
    const orphanStack = (await cli("deployment", "teardown", "orphan-credit", "--orphan-stack", "mdlm-demo-credit", ...profile)).json.value.receipt.result;
    expect(orphanStack, JSON.stringify(orphanStack)).toMatchObject({outcome: "pass", deployment: "deploy-mismatch", stack: {status: "DELETE_COMPLETE"}, remaining: {tagged: [], inventory: []}});
    expect((await cli("deployment", "orphans", ...profile)).json.value.orphans).toEqual([]);

    // Resources outside a stack: a log group from an unknown deployment, a queue the kernel cannot delete,
    // and an expired resource of a live deployment. The next deploy reports them and still proceeds.
    const tags = (deployment: string, expires: string) => [{Key: "mdlm:repository", Value: repositoryId}, {Key: "mdlm:deployment", Value: deployment}, {Key: "mdlm:mode", Value: "credit"}, {Key: "mdlm:expires-at", Value: expires}];
    const ghostLog = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/ghost", queue = "arn:aws:sqs:us-east-1:123456789012:ghost", expired = "arn:aws:dynamodb:us-east-1:123456789012:table/expired";
    const planted = await aws();
    planted.resources.push({stackId: "none", logicalId: "", type: "AWS::Logs::LogGroup", physicalId: "/aws/lambda/ghost", arn: ghostLog, tags: tags("ghost", "2099-01-01T00:00:00.000Z")},
      {stackId: "none", logicalId: "", type: "AWS::SQS::Queue", physicalId: "ghost", arn: queue, tags: tags("ghost", "2099-01-01T00:00:00.000Z")},
      {stackId: "none", logicalId: "", type: "AWS::DynamoDB::Table", physicalId: "expired", arn: expired, tags: tags("deploy-ok", "2020-01-01T00:00:00.000Z")});
    await fs.writeFile(path.join(state, "aws.json"), JSON.stringify(planted));
    const again = (await deploy("ok", "deploy-again")).json.value;
    expect(again.receipt.result.outcome, JSON.stringify(again.receipt.result)).toBe("pass");
    expect(again.receipt.result.orphans.orphans.map((o: any) => [o.arn, o.reason])).toEqual([[ghostLog, expect.stringContaining("names no deployment record")], [queue, expect.stringContaining("names no deployment record")], [expired, expect.stringContaining("has passed")]]);
    const resourceTeardown = (operation: string, arn: string, ...extra: string[]) => cli("deployment", "teardown", operation, "--orphan-resource", arn, ...extra, ...profile);
    expect((await resourceTeardown("orphan-queue", queue, "--yes")).json.diagnostics[0].message).toContain("Remove any other resource by hand");
    expect((await resourceTeardown("orphan-unconfirmed", ghostLog)).json.diagnostics[0].message).toContain("asks for confirmation");
    const removed = (await resourceTeardown("orphan-ghost-log", ghostLog, "--yes")).json.value.receipt.result;
    expect(removed, JSON.stringify(removed)).toMatchObject({outcome: "pass", deleteAttempted: true, deployment: "ghost", remaining: {tagged: [], inventory: []}});
    expect(await fs.readFile(path.join(state, "resource-deletes"), "utf8")).toBe(`${ghostLog}\n`);

    // A stack that fails to delete leaves the teardown in error, naming what remains.
    const againRecord = await draft("deploy-product", "record-again");
    Object.assign(againRecord.candidates[0].payload, {title: "Second credit deployment"});
    againRecord.candidates[0].links = [{type: "deploys", target: products.ok!.revision}];
    againRecord.evidence = {receipt: again.evidence};
    const againDpl = await submit(againRecord);
    // A published, unexpired deployment's own resources are never orphan resources.
    const liveFunction = (await aws()).resources.find((r: any) => r.stackId === again.receipt.result.stack.id && r.type === "AWS::Lambda::Function").arn;
    expect((await resourceTeardown("orphan-live", liveFunction, "--yes")).json.value.receipt.result.diagnostic).toContain("is not a reported orphan");
    await fs.writeFile(path.join(state, "fail-delete"), "");
    const failed = (await teardown(againDpl, "teardown-again-1")).json.value.receipt.result;
    expect([failed.outcome, failed.stack.status, failed.remaining.inventory.map((e: any) => e.type)]).toEqual(["error", "DELETE_FAILED", ["AWS::DynamoDB::Table"]]);
    expect(failed.remaining.tagged).toEqual([again.receipt.result.stack.id, expect.stringContaining(":table/")]);
    expect(failed.diagnostic).toContain(`stack ${again.receipt.result.stack.id} is DELETE_FAILED`);
    // A failed teardown does not count, so the deployment is not yet an orphan; a new teardown operation retries.
    expect((await cli("deployment", "orphans", ...profile)).json.value.orphans.map((o: any) => o.arn)).toEqual([queue, expired]);
    await fs.rm(path.join(state, "fail-delete"));
    expect((await teardown(againDpl, "teardown-again-2")).json.value.receipt.result).toMatchObject({outcome: "pass", stack: {status: "DELETE_COMPLETE"}});

    // The recorded inventory finds an untagged resource that outlived deploy-ok's stack; deleting it is resource-only
    // and does not mark deploy-ok torn down, so its expired resource keeps its own reason.
    const outlived = await aws(), tablePhysical = result.inventory.find((e: any) => e.type === "AWS::DynamoDB::Table").physicalId;
    outlived.resources.push({stackId: "none", logicalId: "Table", type: "AWS::DynamoDB::Table", physicalId: tablePhysical, arn: `arn:aws:dynamodb:us-east-1:123456789012:table/${tablePhysical}`});
    // A function that reused deploy-ok's physical name for another repository's deployment is judged by its own tags.
    const fnPhysical = result.inventory.find((e: any) => e.type === "AWS::Lambda::Function").physicalId;
    outlived.resources.push({stackId: "elsewhere", logicalId: "Fn", type: "AWS::Lambda::Function", physicalId: fnPhysical, arn: `arn:aws:lambda:us-east-1:123456789012:function:${fnPhysical}`,
      tags: [{Key: "mdlm:repository", Value: "git-commit:other"}, {Key: "mdlm:deployment", Value: "theirs"}]});
    await fs.writeFile(path.join(state, "aws.json"), JSON.stringify(outlived));
    const inventoried = (await cli("deployment", "orphans", ...profile)).json.value.orphans;
    expect(inventoried).toContainEqual({kind: "resource", arn: `arn:aws:dynamodb:us-east-1:123456789012:table/${tablePhysical}`, deployment: "deploy-ok", reason: expect.stringContaining("outlived its stack")});
    expect((await resourceTeardown("orphan-outlived", `arn:aws:dynamodb:us-east-1:123456789012:table/${tablePhysical}`, "--yes")).json.value.receipt.result.outcome).toBe("pass");
    expect((await cli("deployment", "orphans", ...profile)).json.value.orphans.map((o: any) => [o.arn, o.reason])).toEqual([[queue, expect.stringContaining("names no deployment record")], [expired, expect.stringContaining("has passed")]]);
  } finally {
    server.close();
    await fs.rm(root, {recursive: true, force: true});
  }
}, 120_000);

test("a target-configured package deploys, dry-runs, finds orphans and tears down with the exact DTG's config", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-deployment-target-")));
  const {repository, cli, git, submit, draft, products, recordProduct, server} = await harness(root, {target: true});
  try {
    await recordProduct("ok");
    const recordTarget = async (operation: string, overrides: Record<string, unknown> = {}) => {
      const proposal = await draft("record-target", operation);
      Object.assign(proposal.candidates[0].payload, {title: `Target ${operation}`, ...config, ...overrides});
      return submit(proposal);
    };
    const demo = await recordTarget("target-demo");
    // A second target whose resource allowlist omits DynamoDB, so the D5 policy refuses the fixture's table.
    const strict = await recordTarget("target-strict", {resource_allowlist: ["AWS::Lambda::Function", "AWS::ApiGatewayV2::Api", "AWS::Logs::LogGroup"]});
    const profile = ["--aws-profile", "apm-mdlm-demo"];
    const deploy = (operation: string, ...target: string[]) => cli("deployment", "run", products.ok!.revision, operation, "--stack", "mdlm-demo-credit", ...profile, ...target);

    expect((await deploy("no-target")).json.diagnostics[0].message).toContain("pass --target <exact-DTG>");
    expect((await deploy("product-as-target", "--target", products.ok!.revision)).json.diagnostics[0].message).toContain("must be an exact DTG revision");
    const refused = (await deploy("deploy-strict", "--target", strict)).json.value.receipt;
    expect([refused.binding.target, refused.result.phase, refused.result.deployAttempted, refused.result.diagnostic]).toEqual([strict, "validation", false, expect.stringContaining("AWS::DynamoDB::Table")]);

    // The binding records the target revision and only its config fields.
    const passed = (await deploy("deploy-demo", "--target", demo)).json.value;
    expect(passed.receipt.result.outcome, JSON.stringify(passed.receipt.result)).toBe("pass");
    expect([passed.receipt.binding.target, passed.receipt.binding.config]).toEqual([demo, config]);
    const record = await draft("deploy-product", "record-demo");
    Object.assign(record.candidates[0].payload, {title: "Demo deployment"});
    record.candidates[0].links = [{type: "deploys", target: products.ok!.revision}];
    record.evidence = {receipt: passed.evidence};
    const dpl = await submit(record);
    expect((await cli("show", dpl)).json.lifecycleDatum.datum.payload).toMatchObject({outcome: "pass", receipt: passed.evidence, target: demo});

    // A registered receipt whose config differs from the target it names is refused.
    for (const [index, mutate] of ([r => { r.binding.config.max_lifetime_minutes = 60; }, r => { r.binding.target = strict; }] as ((r: any) => void)[]).entries()) {
      const forged = structuredClone(passed.receipt); forged.binding.operation = forged.result.tags["mdlm:deployment"] = `forged-target-${index}`; mutate(forged);
      const oid = execFileSync("git", ["-C", repository, "hash-object", "-w", "--stdin"], {input: JSON.stringify(forged), encoding: "utf8"}).trim();
      git(repository, "update-ref", `refs/mdlm/deployment/forged-target-${index}/attempt-1-receipt`, oid);
      const proposal = await draft("deploy-product", `record-forged-target-${index}`);
      Object.assign(proposal, {candidates: record.candidates, evidence: {receipt: `git-blob:${oid}`}});
      await fs.writeFile(path.join(root, `forged-target-${index}.json`), JSON.stringify(proposal));
      expect((await cli("proposal", "submit", path.join(root, `forged-target-${index}.json`))).json.diagnostics[0].message).toContain("does not match this exact product, package and deployment configuration");
    }

    const dry = (await cli("deployment", "dry-run", products.ok!.revision, "--stack", "mdlm-demo-dry-1", ...profile, "--target", demo)).json;
    expect(dry.value, JSON.stringify(dry)).toMatchObject({state: "completed", binding: {target: demo, config: {max_lifetime_minutes: 120}}, result: {outcome: "pass"}});

    expect((await cli("deployment", "orphans", ...profile)).json.diagnostics[0].message).toContain("pass --target <exact-DTG>");
    expect((await cli("deployment", "orphans", ...profile, "--target", demo)).json.value.orphans).toEqual([]);

    // Teardown reads the config recorded with the deployment, so it takes no --target.
    expect((await cli("deployment", "teardown", dpl, "teardown-with-target", ...profile, "--target", demo)).json.diagnostics[0].message).toContain("omit --target");
    expect((await cli("deployment", "teardown", dpl, "teardown-demo", ...profile)).json.value.receipt.result).toMatchObject({outcome: "pass", stack: {status: "DELETE_COMPLETE"}, remaining: {tagged: [], inventory: []}});
    expect((await cli("deployment", "teardown", dry.id, "teardown-dry", ...profile)).json.value.receipt.result).toMatchObject({outcome: "pass", stack: {status: "DELETE_COMPLETE"}});
    expect((await cli("deployment", "teardown", "orphan-none", "--orphan-stack", "mdlm-demo-credit", ...profile, "--target", demo)).json.value.receipt.result.diagnostic).toContain("holds no orphan");
  } finally {
    server.close();
    await fs.rm(root, {recursive: true, force: true});
  }
}, 120_000);

test("aws-cdk-deployment@1 refuses a package whose deployment configuration is not pinned", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-deployment-package-"));
  try {
    await fixturePackage(root);
    expect((await loadProcessPackage(root)).ok).toBe(true);
    const actionFile = path.join(root, "actions/deploy-product.yaml"), action = parse(await fs.readFile(actionFile, "utf8"));
    for (const [field, value, message] of [["synth_image", "cdk-synth:latest", "synth_image must be pinned"], ["resource_allowlist", ["AWS::EC2::Instance"], "resource_allowlist must list distinct types"]] as const) {
      await fs.writeFile(actionFile, stringify({...action, fixed_payload: {DPL: {...action.fixed_payload.DPL, [field]: value}}}));
      const loaded = await loadProcessPackage(root);
      expect(loaded.ok).toBe(false);
      expect(JSON.stringify(loaded.diagnostics)).toContain(message);
    }
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("aws-cdk-deployment@1 with target_type needs no fixed config and checks the target type carries it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-deployment-package-"));
  try {
    await fixturePackage(root, {target: true});
    const first = await loadProcessPackage(root);
    expect(first.ok, JSON.stringify(first.diagnostics)).toBe(true);
    const typeFile = path.join(root, "types/DTG.yaml"), type = parse(await fs.readFile(typeFile, "utf8"));
    await fs.writeFile(typeFile, stringify({...type, payload_schema: {...type.payload_schema, required: type.payload_schema.required.filter((field: string) => field !== "region")}}));
    const dplFile = path.join(root, "types/DPL.yaml"), dpl = parse(await fs.readFile(dplFile, "utf8"));
    await fs.writeFile(dplFile, stringify({...dpl, kernel_managed_payload_paths: dpl.kernel_managed_payload_paths.filter((field: string) => field !== "target")}));
    const diagnostics = JSON.stringify((await loadProcessPackage(root)).diagnostics);
    expect(diagnostics).toContain("target type DTG must require payload region");
    expect(diagnostics).toContain("requires managed target");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
