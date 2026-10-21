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

const run = promisify(execFile);
const config = {
  synth_image: `cdk-synth@sha256:${"c".repeat(64)}`, cdk_cli_version: "2.1000.0", cdk_app_path: "infra", region: "us-east-1", apm_project: "mdlm-demo",
  stack_slots: ["mdlm-demo-credit", "mdlm-demo-dry-1"], output_allowlist: ["ApiEndpoint"], endpoint_output: "ApiEndpoint", probe_path: "/version", max_lifetime_minutes: 120,
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
  write("asset.abc/index.js", "export const version = " + JSON.stringify(bake ?? process.env.MDLM_PRODUCT_COMMIT) + ";\n");
  write(stack + ".template.json", {Resources: {}, Outputs: {ApiEndpoint: {Value: "x"}, Secret: {Value: "y"}}});
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
  fs.mkdirSync(path.join(state, "stacks"), {recursive: true});
  fs.writeFileSync(path.join(state, "stacks", stack + ".json"), JSON.stringify({StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/" + stack + "/fake", StackName: stack, StackStatus: "CREATE_COMPLETE", CreationTime: "2026-10-21T00:00:00Z", Outputs: [{OutputKey: "ApiEndpoint", OutputValue: endpoint}, {OutputKey: "Secret", OutputValue: "not-allowlisted"}]}));
  console.log("deployed " + stack); process.exit(0);
}
process.exit(2);
`;
const fakeAws = String.raw`
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2);
if (process.env.AWS_PROFILE !== "apm-mdlm-demo" || process.env.AWS_ACCESS_KEY_ID) { console.error("unexpected credentials"); process.exit(255); }
if (args[0] === "sts" && args[1] === "get-caller-identity") { console.log(JSON.stringify({Account: "123456789012", Arn: "arn:aws:sts::123456789012:assumed-role/apm-mdlm-demo/session", UserId: "AROAEXAMPLE:session"})); process.exit(0); }
if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
  const file = path.join(__dirname, "state", "stacks", args[args.indexOf("--stack-name") + 1] + ".json");
  if (!fs.existsSync(file)) { console.error("An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id x does not exist"); process.exit(254); }
  console.log(JSON.stringify({Stacks: [JSON.parse(fs.readFileSync(file, "utf8"))]})); process.exit(0);
}
process.exit(2);
`;

async function fixturePackage(directory: string) {
  await fs.cp(installedProcessPackageRoot("iterative"), directory, {recursive: true});
  const schemaFile = path.join(directory, "meta/action-definition.schema.json");
  const schema = JSON.parse(await fs.readFile(schemaFile, "utf8"));
  schema.properties.capability.enum.push("deployment");
  await fs.writeFile(schemaFile, JSON.stringify(schema, null, 2));
  const lifecycle = {authorship: "authored", freeze_when: "terminal-outcome", terminal_payload_field: "publication", terminal_values: ["recorded"]};
  const text = {type: "string", minLength: 1};
  await fs.writeFile(path.join(directory, "types/PRD.yaml"), stringify({kind: "type-definition", id: "PRD", version: 1, name: "Product", description: "Deployable product", extends: "titled-datum@1", lifecycle,
    payload_schema: {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["publication", "repository_path", "source_commit"], properties: {publication: {const: "recorded"}, repository_path: text, source_commit: {type: "string", pattern: "^[a-f0-9]{40}$"}}},
    outgoing_links: [], kernel_managed_payload_paths: []}));
  await fs.writeFile(path.join(directory, "types/DPL.yaml"), stringify({kind: "type-definition", id: "DPL", version: 1, name: "Deployment", description: "Deployment record", extends: "titled-datum@1", lifecycle,
    payload_schema: {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["publication", ...Object.keys(config), "outcome", "receipt"], properties: {
      publication: {const: "recorded"}, ...Object.fromEntries(Object.keys(config).map(key => [key, {}])),
      outcome: {enum: ["pass", "error"]}, receipt: text, stack: {type: "object"}, outputs: {type: "object"}, endpoint: text, deployed_version: text, expires_at: text}},
    outgoing_links: [{id: "deploys", description: "Exact product deployed", targets: [{kind: "datum", types: ["PRD"], identity: "revision"}], cardinality: {minimum: 1, maximum: 1}, freeze_resolution: "already-exact", inverse_label: "incoming-deploys"}],
    kernel_managed_payload_paths: ["outcome", "receipt", "stack", "outputs", "endpoint", "deployed_version", "expires_at"]}));
  const prompt = "prompts/frame-experiment.md@2";
  await fs.writeFile(path.join(directory, "actions/record-product.yaml"), stringify({kind: "action-definition", id: "record-product", version: 1, capability: "experiment", prompt_ref: prompt, types: ["PRD"], inputs: {}, when: "true", priority: 1, fixed_payload: {PRD: {publication: "recorded"}}}));
  await fs.writeFile(path.join(directory, "actions/deploy-product.yaml"), stringify({kind: "action-definition", id: "deploy-product", version: 1, capability: "deployment", prompt_ref: prompt, types: ["DPL"], inputs: {}, when: "true", priority: 1, fixed_payload: {DPL: {publication: "recorded", ...config}}}));
  const manifestFile = path.join(directory, "manifest.yaml"), manifest = parse(await fs.readFile(manifestFile, "utf8"));
  manifest.id = "mdlm-deployment-fixture";
  manifest.kernel_capabilities["aws-cdk-deployment@1"] = {type: "DPL", implementation_type: "PRD", action: "deploy-product"};
  await fs.writeFile(manifestFile, stringify(manifest));
}

test("deployment run synthesizes in the sandbox, refuses unsafe assemblies, deploys on the host and records a probed receipt", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-deployment-")));
  const fixture = path.join(root, "package"), repository = path.join(root, "lifecycle"), product = path.join(root, "product"), bin = path.join(root, "bin"), state = path.join(bin, "state");
  const server = createServer(async (request, response) => {
    if (request.url !== "/version") return void response.writeHead(404).end();
    response.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({version: await fs.readFile(path.join(state, "deployed-version"), "utf8")}));
  });
  try {
    await fixturePackage(fixture);
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
    for (const [scenario, extra] of [["ok", {}], ["executable", {}], ["docker", {}], ["escape", {}], ["symlink", {}], ["cache", {}], ["nested", {}], ["mismatch", {bake: "0".repeat(40)}]] as const) {
      await fs.writeFile(path.join(product, "infra/fixture.json"), JSON.stringify({scenario, ...extra}));
      git(product, "add", "."); git(product, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", scenario);
      const commit = git(product, "rev-parse", "HEAD"), proposal = await draft("record-product", `product-${scenario}`);
      Object.assign(proposal.candidates[0].payload, {title: `Product ${scenario}`, repository_path: product, source_commit: commit});
      products[scenario] = {commit, revision: await submit(proposal)};
    }
    const deploy = (scenario: string, operation: string, stack = "mdlm-demo-credit", profile = "apm-mdlm-demo") => cli("deployment", "run", products[scenario]!.revision, operation, "--stack", stack, "--aws-profile", profile);
    const deploys = async () => (await fs.readFile(path.join(state, "deploys"), "utf8").catch(() => "")).length;

    // Only the package-named APM profile and a package stack slot are accepted.
    expect((await deploy("ok", "wrong-profile", "mdlm-demo-credit", "default")).json.diagnostics[0].message).toContain("--aws-profile apm-mdlm-demo");
    expect((await deploy("ok", "wrong-slot", "someone-elses-stack")).json.diagnostics[0].message).toContain("not one of the package's stack slots");

    const passed = await deploy("ok", "deploy-ok");
    expect(passed.status, JSON.stringify(passed.json)).toBe(0);
    const result = passed.json.value.receipt.result;
    expect(result, JSON.stringify(result)).toMatchObject({outcome: "pass", phase: "probe", deployAttempted: true,
      source: {commit: products.ok!.commit, appPath: "infra", synthImage: config.synth_image, synthImageId: `sha256:${"1".repeat(64)}`, hostCdkVersion: "2.1000.0"},
      access: {apmProject: "mdlm-demo", account: "123456789012", callerArn: "arn:aws:sts::123456789012:assumed-role/apm-mdlm-demo/session"},
      stack: {account: "123456789012", region: "us-east-1", name: "mdlm-demo-credit", id: "arn:aws:cloudformation:us-east-1:123456789012:stack/mdlm-demo-credit/fake", status: "CREATE_COMPLETE"},
      deployedVersion: products.ok!.commit, probe: {matched: true, status: 200, expectedVersion: products.ok!.commit}});
    expect(result.outputs).toEqual({ApiEndpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/)});
    expect(result.assembly.templateSha256).toMatch(/^[a-f0-9]{64}$/);
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
    ];
    for (const [index, [field, mutate]] of forgeries.entries()) {
      const forged = structuredClone(original); forged.binding.operation = `forged-${index}`; mutate(forged);
      const oid = execFileSync("git", ["-C", repository, "hash-object", "-w", "--stdin"], {input: JSON.stringify(forged), encoding: "utf8"}).trim();
      git(repository, "update-ref", `refs/mdlm/deployment/forged-${index}/attempt-1-receipt`, oid);
      const proposal = await draft("deploy-product", `record-forged-${index}`);
      Object.assign(proposal, {candidates: record.candidates, evidence: {receipt: `git-blob:${oid}`}});
      await fs.writeFile(path.join(root, `forged-${index}.json`), JSON.stringify(proposal));
      expect((await cli("proposal", "submit", path.join(root, `forged-${index}.json`))).json.diagnostics[0].message, field).toContain(`receipt ${field} contradicts`);
    }

    // Assembly validation refuses before any AWS call, so nothing is deployed.
    await fs.rm(path.join(state, "stacks"), {recursive: true});
    for (const [scenario, message] of [["executable", "executable source"], ["docker", "Docker image assets"], ["escape", "inside the assembly"], ["symlink", "symlink"], ["cache", "publisher cache"], ["nested", "at the assembly root"]]) {
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

    // An interrupted attempt leaves its started marker and is never re-run.
    const binding = (await cli("deployment", "settlement", "deploy-ok")).json.value.receipt.binding;
    const interrupted = {...binding, operation: "interrupted"};
    await expect(runDeploymentReceipt(repository, interrupted, async () => { throw new Error("process killed"); })).rejects.toThrow("process killed");
    await expect(runDeploymentReceipt(repository, interrupted, async () => { throw new Error("must not run"); })).rejects.toThrow("never re-run");
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
    action.fixed_payload.DPL.synth_image = "cdk-synth:latest";
    await fs.writeFile(actionFile, stringify(action));
    const loaded = await loadProcessPackage(root);
    expect(loaded.ok).toBe(false);
    expect(JSON.stringify(loaded.diagnostics)).toContain("synth_image must be pinned");
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
