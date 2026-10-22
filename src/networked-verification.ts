import type { DatumEnvelope, ProcessPackage } from "./index.js";
import { DEPLOYMENT_CAPABILITY } from "./aws-cdk-deployment.js";
import { checked, execute } from "./docker-verification.js";

// ADR-0009 section 2. A verification activity linked to one deployment runs on a
// per-run --internal network whose only way out is a kernel-started proxy that
// tunnels to the deployment's endpoint and nothing else.

/** Kernel-pinned proxy runtime. The proxy is kernel code, so its image is not a package choice. */
export const PROXY_IMAGE = "node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";
export const NETWORKED_TIMEOUT_MS = 300_000;
const PROXY_PORT = 3128;

/** The exact deployment a networked activity runs against, read from its published record. */
export interface VerificationDeployment {
  revision: string;
  receipt: string;
  endpoint: string;
  version: string;
  probePath: string;
}
export interface DeploymentProbe {url: string; status: number | null; expectedVersion: string; matched: boolean; bodyBase64: string}
export interface ProxyConnection {host: string; port: number; allowed: boolean; bytesSent: number; bytesReceived: number; openedAt: string; closedAt: string}
export interface NetworkedRun {
  deployment: string;
  receipt: string;
  endpoint: string;
  version: string;
  runId: string;
  proxyImage: string;
  allowlist: string[];
  probes: {before?: DeploymentProbe; after?: DeploymentProbe};
  connections: ProxyConnection[];
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/** The activity's `verified-against` link selects at most one completed deployment of this exact product commit. */
export function verificationDeployment(pkg: ProcessPackage, data: DatumEnvelope[], product: DatumEnvelope, activity: DatumEnvelope): VerificationDeployment | undefined {
  const links = activity.links.filter(link => link.type === "verified-against");
  if (!links.length) return undefined;
  const type = pkg.kernelCapabilities[DEPLOYMENT_CAPABILITY]?.type;
  if (!type) throw new Error(`A verified-against activity requires the package's ${DEPLOYMENT_CAPABILITY} capability`);
  if (links.length !== 1) throw new Error("A verification activity is verified against at most one exact deployment");
  const deployment = data.find(d => d.revision_id === links[0]!.target);
  if (!deployment || deployment.type !== type) throw new Error(`verified-against must name an exact ${type} revision`);
  const p = deployment.payload;
  if (p.outcome !== "pass" || typeof p.endpoint !== "string" || typeof p.receipt !== "string" || typeof p.probe_path !== "string") throw new Error(`Deployment ${deployment.revision_id} did not complete successfully`);
  const deployed = data.find(d => d.revision_id === deployment.links.find(link => link.type === "deploys")?.target);
  if (deployed?.id !== product.id || p.deployed_version !== product.payload.source_commit) throw new Error(`Deployment ${deployment.revision_id} does not deploy product commit ${String(product.payload.source_commit)}`);
  parseEndpoint(p.endpoint);
  return {revision: deployment.revision_id, receipt: p.receipt, endpoint: p.endpoint, version: String(p.deployed_version), probePath: p.probe_path};
}

/** The one host:port the proxy may tunnel to. */
export function parseEndpoint(endpoint: string): {host: string; port: number} {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error(`Deployment endpoint '${endpoint}' is not a URL`); }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error(`Deployment endpoint '${endpoint}' must be an HTTP(S) URL without credentials`);
  return {host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80))};
}
export const probeUrl = (deployment: VerificationDeployment) => `${deployment.endpoint.replace(/\/+$/, "")}${deployment.probePath}`;

/** Recompute a probe's match from its recorded bytes, as deployment receipts do. */
export const probeMatches = (probe: DeploymentProbe | undefined, deployment: VerificationDeployment) => !!probe && probe.url === probeUrl(deployment)
  && probe.expectedVersion === deployment.version && typeof probe.status === "number" && probe.status >= 200 && probe.status <= 299
  && Buffer.from(probe.bodyBase64, "base64").toString("utf8").includes(deployment.version) && probe.matched === true;

// CONNECT-only egress proxy. It logs host, port, byte counts and times, never request or response bytes.
const proxySource = String.raw`
const net = require("node:net"), allow = new Set(process.env.MDLM_ALLOW.split(","));
const log = entry => process.stdout.write(JSON.stringify(entry) + "\n");
const server = net.createServer(client => {
  let head = Buffer.alloc(0);
  const onData = chunk => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) { if (head.length > 8192) client.destroy(); return; }
    client.removeListener("data", onData);
    client.pause();
    const openedAt = new Date().toISOString(), line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
    const match = /^CONNECT ([^\s:]+|\[[^\]]+\]):(\d+) HTTP\/1\.[01]$/.exec(line);
    const host = match ? match[1].replace(/^\[|\]$/g, "") : "", port = match ? Number(match[2]) : 0;
    if (!match || !allow.has(host + ":" + port)) {
      client.end(match ? "HTTP/1.1 403 Forbidden\r\n\r\n" : "HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      return log({host, port, allowed: false, bytesSent: 0, bytesReceived: 0, openedAt, closedAt: openedAt});
    }
    let sent = 0, received = 0, connected = false, done = false;
    const upstream = net.connect(port, host, () => {
      connected = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = head.subarray(end + 4);
      if (rest.length) { sent += rest.length; upstream.write(rest); }
      client.on("data", data => { sent += data.length; });
      upstream.on("data", data => { received += data.length; });
      client.pipe(upstream); upstream.pipe(client);
    });
    // The client's close ends the tunnel; an upstream close only ends the client's side, so buffered bytes still arrive.
    client.on("close", () => {
      if (done) return; done = true; upstream.destroy();
      log({host, port, allowed: true, bytesSent: sent, bytesReceived: received, openedAt, closedAt: new Date().toISOString()});
    });
    upstream.on("error", () => { if (!connected) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
    upstream.on("close", () => client.end());
  };
  client.on("data", onData);
  client.on("error", () => client.destroy());
});
server.listen(${PROXY_PORT}, () => log({event: "listening"}));
`;

// Runs inside the proxy container, so the probe takes the verifier's network path.
const probeSource = String.raw`
const [url] = process.argv.slice(1);
fetch(url, {redirect: "manual", signal: AbortSignal.timeout(10000)})
  .then(async response => ({status: response.status, bodyBase64: Buffer.from(await response.arrayBuffer()).subarray(0, 4096).toString("base64")}))
  .catch(() => ({status: null, bodyBase64: ""}))
  .then(result => process.stdout.write(JSON.stringify(result)));
`;

/** One per-run network and proxy. Every created resource is removed by `stop`. */
export class VerificationNetwork {
  readonly network: string;
  readonly proxy: string;
  readonly allowlist: string[];
  private created: ("network" | "proxy")[] = [];

  constructor(readonly deployment: VerificationDeployment, readonly runId: string) {
    const {host, port} = parseEndpoint(deployment.endpoint);
    this.network = `mdlm-verification-net-${runId}`;
    this.proxy = `mdlm-verification-proxy-${runId}`;
    this.allowlist = [`${host}:${port}`];
  }

  /** Verifier container arguments: the internal network, the proxy and the kernel-supplied endpoint. */
  containerArguments(): string[] {
    const proxy = `http://${this.proxy}:${PROXY_PORT}`;
    return ["--network", this.network, "--env", `HTTPS_PROXY=${proxy}`, "--env", `https_proxy=${proxy}`,
      "--env", `MDLM_ENDPOINT=${this.deployment.endpoint}`, "--env", `MDLM_RUN_ID=${this.runId}`];
  }

  async start(): Promise<void> {
    this.created.push("network");
    await checked("docker", ["network", "create", "--internal", this.network]);
    this.created.push("proxy");
    await checked("docker", ["create", "--name", this.proxy, "--network", "bridge", "--read-only",
      "--user", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64",
      "--env", `MDLM_ALLOW=${this.allowlist.join(",")}`, "--entrypoint", "node", PROXY_IMAGE, "-e", proxySource], 120_000);
    await checked("docker", ["network", "connect", this.network, this.proxy]);
    await checked("docker", ["start", this.proxy]);
    for (let attempt = 0; attempt < 100; attempt++) {
      const logs = await execute("docker", ["logs", this.proxy], 10_000);
      if (logs.stdout.toString("utf8").includes(`"event":"listening"`)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Verification egress proxy did not start listening.");
  }

  async probe(): Promise<DeploymentProbe> {
    const url = probeUrl(this.deployment), expectedVersion = this.deployment.version;
    const ran = await execute("docker", ["exec", this.proxy, "node", "-e", probeSource, url], 30_000);
    let observed: {status: number | null; bodyBase64: string} = {status: null, bodyBase64: ""};
    try { if (!ran.problem && ran.exitCode === 0) observed = JSON.parse(ran.stdout.toString("utf8")); } catch { /* unreachable probe */ }
    const body = Buffer.from(observed.bodyBase64, "base64").toString("utf8");
    const status = typeof observed.status === "number" ? observed.status : null;
    return {url, status, expectedVersion, matched: status !== null && status >= 200 && status <= 299 && body.includes(expectedVersion), bodyBase64: observed.bodyBase64};
  }

  async connections(): Promise<ProxyConnection[]> {
    const logs = await execute("docker", ["logs", this.proxy], 30_000);
    return logs.stdout.toString("utf8").split("\n").flatMap(line => {
      try { const entry: unknown = JSON.parse(line); return object(entry) && typeof entry.host === "string" ? [entry as ProxyConnection] : []; } catch { return []; }
    });
  }

  /** Remove the proxy and network; returns a problem description when cleanup failed. */
  async stop(): Promise<string | undefined> {
    const problems: string[] = [];
    if (this.created.includes("proxy")) {
      const removed = await execute("docker", ["rm", "--force", this.proxy], 30_000);
      if (removed.problem || (removed.exitCode !== 0 && !/No such container/.test(removed.stderr.toString("utf8")))) problems.push(`proxy: ${removed.problem ?? removed.stderr.toString("utf8").trim()}`);
    }
    if (this.created.includes("network")) {
      const removed = await execute("docker", ["network", "rm", this.network], 30_000);
      if (removed.problem || (removed.exitCode !== 0 && !/not found/.test(removed.stderr.toString("utf8")))) problems.push(`network: ${removed.problem ?? removed.stderr.toString("utf8").trim()}`);
    }
    return problems.length ? problems.join("; ") : undefined;
  }
}
