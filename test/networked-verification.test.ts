import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { DatumEnvelope, ProcessPackage } from "../src/index.js";
import { parseEndpoint, verificationDeployment } from "../src/networked-verification.js";
import { requireCoherentVerificationResult, runVerificationReceipt, type VerificationBinding } from "../src/verification-receipt.js";

const python = "python@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a";
const docker = (...args: string[]) => execFileSync("docker", args, {encoding: "utf8"}).trim();

it("selects only a completed deployment of the product's exact commit", () => {
  const commit = "a".repeat(40);
  const datum = (revision_id: string, type: string, payload: Record<string, unknown>, links: DatumEnvelope["links"] = []) =>
    ({id: revision_id.replace(/-r\d+$/, ""), revision: Number(revision_id.slice(-5)), revision_id, type, payload, links, body: ""}) as unknown as DatumEnvelope;
  const pkg = {kernelCapabilities: {"aws-cdk-deployment@1": {type: "DPL"}}} as unknown as ProcessPackage;
  const deployed = datum("PRD-1-r00001", "PRD", {source_commit: commit});
  const reselected = datum("PRD-1-r00002", "PRD", {source_commit: commit});
  const dpl = (revision: string, payload: Record<string, unknown>) => datum(revision, "DPL", {outcome: "pass", receipt: `git-blob:${"d".repeat(40)}`, endpoint: "https://abc.execute-api.us-east-1.amazonaws.com/", deployed_version: commit, probe_path: "/version", ...payload}, [{type: "deploys", target: deployed.revision_id}]);
  const data = [deployed, reselected, dpl("DPL-1-r00001", {}), dpl("DPL-2-r00001", {outcome: "error"}), dpl("DPL-3-r00001", {deployed_version: "b".repeat(40)})];
  const activity = (...targets: string[]) => datum("VFY-1-r00001", "VFY", {}, targets.map(target => ({type: "verified-against", target})));

  expect(verificationDeployment(pkg, data, reselected, activity())).toBeUndefined();
  // A later revision of the same product at the same commit can select the activity.
  expect(verificationDeployment(pkg, data, reselected, activity("DPL-1-r00001"))).toEqual({revision: "DPL-1-r00001", receipt: `git-blob:${"d".repeat(40)}`,
    endpoint: "https://abc.execute-api.us-east-1.amazonaws.com/", version: commit, probePath: "/version"});
  expect(() => verificationDeployment(pkg, data, reselected, activity("DPL-2-r00001"))).toThrow("did not complete successfully");
  expect(() => verificationDeployment(pkg, data, reselected, activity("DPL-3-r00001"))).toThrow("does not deploy product commit");
  expect(() => verificationDeployment(pkg, data, datum("PRD-9-r00001", "PRD", {source_commit: commit}), activity("DPL-1-r00001"))).toThrow("does not deploy product commit");
  expect(() => verificationDeployment(pkg, data, reselected, activity("DPL-1-r00001", "DPL-2-r00001"))).toThrow("at most one");
  expect(() => verificationDeployment(pkg, data, reselected, activity("PRD-1-r00001"))).toThrow("exact DPL revision");
  // The allowlist uses URL.hostname form, which the proxy compares CONNECT targets against.
  expect(parseEndpoint("https://[2001:DB8::1]/")).toEqual({host: "[2001:db8::1]", port: 443});
  expect(parseEndpoint("http://ABC.example:8080")).toEqual({host: "abc.example", port: 8080});
  expect(() => verificationDeployment({kernelCapabilities: {}} as unknown as ProcessPackage, data, reselected, activity("DPL-1-r00001"))).toThrow("aws-cdk-deployment@1");
});

// A local stand-in for a deployed product: a version endpoint, a page and a redeploy
// hook on 8080, and the same service on 8081, which the proxy must not reach.
const endpointSource = String.raw`
import http.server, json, os, threading
version = os.environ["VERSION"]
class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = body.encode(); self.send_response(code); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == "/version": self.reply(200, json.dumps({"version": version}))
        elif self.path.startswith("/hello"): self.reply(200, "hello " + self.path)
        else: self.reply(404, "")
    def do_POST(self):
        global version
        if self.path == "/redeploy": version = "0" * 40; self.reply(200, "redeployed")
        else: self.reply(404, "")
    def log_message(self, *args): pass
for port in (8080, 8081):
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
print("ready", flush=True)
threading.Event().wait()
`;

const verifierSource = String.raw`import http.client, json, os, pathlib, socket, sys, urllib.parse
endpoint = urllib.parse.urlsplit(os.environ["MDLM_ENDPOINT"])
proxy = urllib.parse.urlsplit(os.environ["HTTPS_PROXY"])
run_id = os.environ["MDLM_RUN_ID"]
def tunnel(port, method, path):
    connection = http.client.HTTPConnection(proxy.hostname, proxy.port, timeout=10)
    connection.set_tunnel(endpoint.hostname, port)
    connection.request(method, path)
    response = connection.getresponse()
    return f"{response.status} {response.read().decode()}"
def attempt(action):
    try: return action()
    except OSError as error: return f"refused: {error}"
reached = attempt(lambda: tunnel(endpoint.port, "GET", f"/hello?run={run_id}"))
other = attempt(lambda: tunnel(8081, "GET", "/hello"))
direct = attempt(lambda: socket.create_connection((endpoint.hostname, endpoint.port), timeout=3) and "connected")
rows = [
    {"case_id": "reach-endpoint", "outcome": "pass" if reached == f"200 hello /hello?run={run_id}" else "fail", "actual_results": [reached, os.environ["MDLM_ENDPOINT"], run_id], "evidence_refs": []},
    {"case_id": "other-port-refused", "outcome": "pass" if other.startswith("refused") and "403" in other else "fail", "actual_results": [other], "evidence_refs": []},
    {"case_id": "no-direct-route", "outcome": "pass" if direct.startswith("refused") else "fail", "actual_results": [direct], "evidence_refs": []},
]
if pathlib.Path("mode.txt").read_text().strip() == "redeploy": attempt(lambda: tunnel(endpoint.port, "POST", "/redeploy"))
(pathlib.Path(os.environ["MDLM_EVIDENCE_DIR"]) / "results.json").write_text(json.dumps({"contract": "mdlm-verification-results@1", "cases": rows}))
sys.exit(1 if any(row["outcome"] == "fail" for row in rows) else 0)
`;

it("runs a verifier that reaches only the deployed endpoint and errors when the deployment drifts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdlm-networked-"));
  const endpointContainer = `mdlm-test-endpoint-${randomUUID()}`;
  try {
    const product = join(root, "product"), verifier = join(root, "verifier"), lifecycle = join(root, "lifecycle");
    for (const path of [product, verifier, lifecycle]) { await mkdir(path); execFileSync("git", ["-C", path, "init", "-q"]); }
    const git = (path: string, ...args: string[]) => execFileSync("git", ["-C", path, ...args], {encoding: "utf8"}).trim();
    const commit = (path: string) => { git(path, "add", "."); git(path, "-c", "user.name=MDLM fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"); return git(path, "rev-parse", "HEAD"); };
    await writeFile(join(product, "app.txt"), "deployed product\n");
    const sourceCommit = commit(product);
    await writeFile(join(verifier, "verify.py"), verifierSource);
    await writeFile(join(verifier, "mode.txt"), "observe\n");
    const observeCommit = commit(verifier);
    await writeFile(join(verifier, "mode.txt"), "redeploy\n");
    const redeployCommit = commit(verifier);

    docker("run", "-d", "--name", endpointContainer, "--network", "bridge", "--env", `VERSION=${sourceCommit}`, "--entrypoint", "python", python, "-c", endpointSource);
    for (let attempt = 0; attempt < 100 && !docker("logs", endpointContainer).includes("ready"); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    const address = docker("inspect", "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", endpointContainer);
    const deployment = {revision: "DPL-test-r00001", receipt: `git-blob:${"d".repeat(40)}`, endpoint: `http://${address}:8080/`, version: sourceCommit, probePath: "/version"};
    const binding = (operation: string, verifierCommit: string): VerificationBinding => ({operation, package: {reference: "fixture@1"}, inputs: ["PRD-test-r00001", "VFY-test-r00001"], repositoryPath: product, sourceCommit, image: python, deployment,
      independentVerification: {activityRevision: "VFY-test-r00001", repositoryPath: verifier, sourceCommit: verifierCommit, scriptPath: "verify.py", command: ["python3", "verify.py"], caseIds: ["reach-endpoint", "other-port-refused", "no-direct-route"], resultsPath: "results.json"}});
    // Other runs share this Docker daemon, so look only for this run's proxy and network.
    const leftovers = (runId: string) => [docker("ps", "-aq", "--filter", `name=mdlm-verification-proxy-${runId}`), docker("network", "ls", "-q", "--filter", `name=mdlm-verification-net-${runId}`)].join("");

    // Happy path: the verifier reaches the endpoint through the proxy, and nothing else.
    const passed = (await runVerificationReceipt(lifecycle, binding("networked-pass", observeCommit), false)).receipt.result!;
    expect(passed, JSON.stringify(passed)).toMatchObject({outcome: "pass", started: true, caseResults: [{case_id: "reach-endpoint", outcome: "pass"}, {case_id: "other-port-refused", outcome: "pass"}, {case_id: "no-direct-route", outcome: "pass"}],
      network: {deployment: deployment.revision, receipt: deployment.receipt, endpoint: deployment.endpoint, version: sourceCommit, allowlist: [`${address}:8080`],
        probes: {before: {url: `http://${address}:8080/version`, status: 200, matched: true}, after: {status: 200, matched: true}}}});
    // The kernel supplied the endpoint and a fresh run ID.
    expect(passed.caseResults![0]!.actual_results.slice(1)).toEqual([deployment.endpoint, passed.network!.runId]);
    expect(passed.network!.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({host: address, port: 8080, allowed: true, bytesSent: expect.any(Number), bytesReceived: expect.any(Number)}),
      expect.objectContaining({host: address, port: 8081, allowed: false}),
    ]));
    expect(passed.network!.connections.filter(connection => connection.allowed).every(connection => connection.host === address && connection.port === 8080)).toBe(true);
    await requireCoherentVerificationResult(binding("networked-pass", observeCommit), passed);
    const flipped = structuredClone(passed); flipped.network!.probes.after!.bodyBase64 = Buffer.from("{}").toString("base64");
    await expect(requireCoherentVerificationResult(binding("networked-pass", observeCommit), flipped)).rejects.toThrow("deployment probes");
    const {deployment: _, ...offline} = binding("networked-pass", observeCommit);
    await expect(requireCoherentVerificationResult(offline, passed)).rejects.toThrow("deployment probes");
    expect(leftovers(passed.network!.runId)).toBe("");

    // A redeploy during the run makes the after-probe disagree: the outcome is error, never pass.
    const drifted = (await runVerificationReceipt(lifecycle, binding("networked-drift", redeployCommit), false)).receipt.result!;
    expect(drifted, JSON.stringify(drifted)).toMatchObject({outcome: "error", started: true, exitCode: 0, network: {probes: {before: {matched: true}, after: {status: 200, matched: false}}}});
    expect(drifted.caseResults!.map(row => row.outcome)).toEqual(["pass", "pass", "pass"]);
    expect(drifted.diagnostic).toContain("drifted during the run");

    // A deployment that already reports another version never starts the verifier.
    const stale = (await runVerificationReceipt(lifecycle, binding("networked-stale", observeCommit), false)).receipt.result!;
    expect(stale, JSON.stringify(stale)).toMatchObject({outcome: "error", started: false, phase: "environment", network: {probes: {before: {matched: false}}}});
    expect(stale.network!.probes.after).toBeUndefined();
    expect(stale.diagnostic).toContain("before the run");
    expect(leftovers(drifted.network!.runId) + leftovers(stale.network!.runId)).toBe("");
  } finally {
    execFileSync("docker", ["rm", "--force", endpointContainer], {stdio: "ignore"});
    await rm(root, {recursive: true, force: true});
  }
}, 180_000);
