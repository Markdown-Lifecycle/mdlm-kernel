import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { repositoryGitEnvironment } from "./git-environment.js";
import type { ProcessDiagnostic } from "./index.js";

// ADR 0010: each accepted publication is anchored by a kernel-written Git ref outside its saved copies.
const exec = promisify(execFile);
const transactionRoot = ".lifecycle/data/.transactions";
const anchorPrefix = "refs/mdlm/publication/";
interface TransactionFile { path: string; bytes: Buffer }

async function git(root: string, args: string[], input?: string) {
  const pending = exec("git", ["-C", root, ...args], {env: repositoryGitEnvironment(), maxBuffer: 64 * 1024 * 1024});
  if (input !== undefined) pending.child.stdin!.end(input);
  return (await pending).stdout;
}
/** Every file below one transaction directory, by sorted relative path. */
async function transactionFiles(directory: string): Promise<TransactionFile[]> {
  const files: TransactionFile[] = [];
  async function visit(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(directory, relative), {withFileTypes: true})) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push({path: child, bytes: await fs.readFile(path.join(directory, child))});
      else throw new Error(`Transaction file '${child}' must be a regular file`);
    }
  }
  await visit("");
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function anchorSource(transaction: string, files: readonly TransactionFile[]): string {
  return `${JSON.stringify({contract: "mdlm-publication-anchor@1", transaction,
    files: files.map(file => ({path: file.path, sha256: createHash("sha256").update(file.bytes).digest("hex")}))})}\n`;
}
/** The Git object ID of a blob, in the repository's object format, without writing it. */
function blobId(bytes: Buffer | string, format: string): string {
  const content = Buffer.from(bytes);
  return createHash(format === "sha256" ? "sha256" : "sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
async function transactionIds(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(root, transactionRoot), {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function objectFormat(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "--show-object-format"])).trim();
}

/** Called inside the publication lock, before the staged directory becomes the published transaction. */
export async function writePublicationAnchor(root: string, transaction: string, stagedDirectory: string): Promise<void> {
  const oid = (await git(root, ["hash-object", "-w", "--stdin"], anchorSource(transaction, await transactionFiles(stagedDirectory)))).trim();
  // A crash before the rename leaves an anchor without a transaction; a later publication of the same operation replaces it.
  await git(root, ["update-ref", `${anchorPrefix}${transaction}`, oid]);
}

/** Anchors an unanchored repository once from committed history; never-committed transactions are anchored as found. */
async function migrate(root: string, transactions: readonly string[], format: string): Promise<ProcessDiagnostic[]> {
  const committed = new Map<string, string>();
  // Only an unborn HEAD means nothing was committed; any other Git failure refuses.
  const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => "")).trim();
  const tree = head ? await git(root, ["ls-tree", "-r", "-z", head, "--", transactionRoot]) : "";
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
    if (match) committed.set(match[2]!, match[1]!);
  }
  const diagnostics: ProcessDiagnostic[] = [], anchors: string[] = [];
  for (const transaction of transactions) {
    const directory = `${transactionRoot}/${transaction}`;
    const files = await transactionFiles(path.join(root, directory));
    const tracked = [...committed.keys()].filter(file => file.startsWith(`${directory}/`));
    const working = new Map(files.map(file => [`${directory}/${file.path}`, blobId(file.bytes, format)]));
    const differing = tracked.length === 0 ? [] : [...new Set([...tracked, ...working.keys()])].sort().filter(file => committed.get(file) !== working.get(file));
    for (const file of differing) diagnostics.push({code: "publication-anchor-migration-refused", path: file, message: "Committed publication differs from HEAD; anchoring refuses to accept it as published"});
    anchors.push(`create ${anchorPrefix}${transaction} ${(await git(root, ["hash-object", "-w", "--stdin"], anchorSource(transaction, files))).trim()}\n`);
  }
  if (diagnostics.length) return diagnostics;
  // One atomic ref transaction. A concurrent migration's identical anchors are verified by the caller.
  await git(root, ["update-ref", "--stdin"], anchors.join("")).catch(() => undefined);
  return [];
}

/** Refuse any transaction whose saved files differ from its anchor or that has none. */
export async function verifyPublicationAnchors(root: string): Promise<ProcessDiagnostic[]> {
  const transactions = await transactionIds(root);
  if (!transactions.length) return [];
  const format = await objectFormat(root);
  const anchored = async () => new Map((await git(root, ["for-each-ref", "--format=%(refname) %(objectname)", anchorPrefix])).split("\n").filter(Boolean)
    .map(line => line.split(" ") as [string, string]).map(([ref, oid]) => [ref.slice(anchorPrefix.length), oid]));
  let anchors = await anchored();
  if (anchors.size === 0) {
    const refused = await migrate(root, transactions, format);
    if (refused.length) return refused;
    anchors = await anchored();
  }
  const diagnostics: ProcessDiagnostic[] = [];
  for (const transaction of transactions) {
    const directory = `${transactionRoot}/${transaction}`;
    const oid = anchors.get(transaction);
    if (!oid) { diagnostics.push({code: "publication-anchor-missing", path: directory, message: "Published transaction has no publication anchor"}); continue; }
    let files: TransactionFile[];
    try { files = await transactionFiles(path.join(root, directory)); }
    catch (error) { diagnostics.push({code: "publication-anchor-mismatch", path: directory, message: error instanceof Error ? error.message : String(error)}); continue; }
    if (blobId(anchorSource(transaction, files), format) === oid) continue;
    let recorded: {files?: {path: string; sha256: string}[]} = {};
    try { recorded = JSON.parse(await git(root, ["cat-file", "blob", oid])); } catch { /* an unreadable anchor names the whole directory */ }
    const expected = new Map((recorded.files ?? []).map(file => [file.path, file.sha256]));
    const actual = new Map(files.map(file => [file.path, createHash("sha256").update(file.bytes).digest("hex")]));
    const differing = [...new Set([...expected.keys(), ...actual.keys()])].sort().filter(file => expected.get(file) !== actual.get(file));
    for (const file of differing.length ? differing.map(file => `${directory}/${file}`) : [directory]) {
      diagnostics.push({code: "publication-anchor-mismatch", path: file, message: "Published transaction file differs from its publication anchor"});
    }
  }
  return diagnostics;
}
