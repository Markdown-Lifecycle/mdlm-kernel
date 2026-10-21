import { validateChangeDatum } from "./change-assessment.js";
import { traceDatumDiagnostics, requirementTraceBinding } from "./requirement-trace.js";
import { validatePayloadCollections, renderPayloadViews, type RenderedPayloadView } from "./payload-collections.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { parse, stringify } from "yaml";
import { structuralValuesEqual } from "./structural-equality.js";
import { withRepositoryLock } from "./repository-lock.js";
import { processPackageDigest } from "./process-package-digest.js";
import { verifyPublicationAnchors, writePublicationAnchor } from "./publication-anchor.js";
import {
  measure,
  measureAsync,
  recordRepositoryLoad,
  recordWork,
} from "./performance-diagnostics.js";
import {
  evaluateLifecycle,
  loadProcessPackage,
  resolveType,
  type DatumEnvelope,
  type LifecycleRecord,
  type LifecycleSnapshot,
  type ProcessDiagnostic,
  type ProcessPackage,
  type ResolvedType,
} from "./index.js";

export interface CreatedDatum {
  id: string;
  revisionId: string;
  type: string;
  path: string;
}

export interface TransactionPublication {
  created: CreatedDatum[];
  executionPath: string;
}

export type GraphIdentityKind =
  | "stable-datum"
  | "revision";

export interface GraphNode {
  identity: string;
  identityKind: GraphIdentityKind;
  type?: string;
}

export interface GraphLink {
  source: string;
  sourceIdentityKind: "revision";
  sourceType: string;
  type: string;
  target: string;
  targetIdentityKind: GraphIdentityKind;
  inverseLabel: string;
}

export interface BacklinkInspection extends GraphNode {
  links: GraphLink[];
}

export interface GraphTrace {
  root: GraphNode;
  depth: number;
  relation: string | null;
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface DatumProjections {
  views?: RenderedPayloadView[];
  backlinks: GraphLink[];
  states: Record<string, string | string[]>;
  kernelCapabilities: string[];
}

export interface StoredDatum {
  lifecycleDatum: LifecycleRecord;
  projections: DatumProjections;
}

export interface RepositoryIndexSummary {
  rebuilt: boolean;
  data: number;
  path: ".lifecycle/generated/indexes/data.json";
}

export interface RepositoryReportSummary {
  rebuilt: boolean;
  data: number;
  path: ".lifecycle/generated/reports/lifecycle.json";
}

export interface ListedDatum {
  lifecycleDatum: LifecycleRecord;
  projections: DatumProjections;
}

export interface DatumHistory {
  id: string;
  type: string;
  revisions: {
    revision: number;
    revisionId: string;
    classification: "frozen-history" | "editable-work";
    frozenBy: string[];
    processRef: string;
  }[];
}

export type RepositoryResult<T> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; diagnostics: ProcessDiagnostic[] };

export interface ParsedDatum {
  lifecycleDatum: LifecycleRecord;
  relativePath: string;
  sourceDigest: string;
}

// Only the canonical loader can associate an authenticated authoring package.
// Proposed outputs and caller-supplied datum copies never acquire this evidence.
const authenticatedAuthoringPackages = new WeakMap<DatumEnvelope, {pkg: ProcessPackage; source: string}>();
export function authenticatedAuthoringPackage(datum: DatumEnvelope) {
  const evidence = authenticatedAuthoringPackages.get(datum);
  return evidence?.source === JSON.stringify(datum) ? evidence.pkg : undefined;
}

export interface KernelFinalizedOutput {
  capability: "exact-baseline@1" | "docker-verification@1" | "requirement-trace@1" | "requirement-trace@2";
  datum: DatumEnvelope;
}

const stableIdentity = /^[A-Z]{3,8}-[0-9A-HJKMNP-TV-Z]{10,12}$/;
const revisionIdentity = /^([A-Z]{3,8}-[0-9A-HJKMNP-TV-Z]{10,12})-r([0-9]{5})$/;

function validator(schema: Record<string, unknown>): ValidateFunction {
  recordWork("repository.validation.schema-compilations");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = formatsPlugin as unknown as (
    instance: Ajv2020,
  ) => Ajv2020;
  addFormats(ajv);
  return ajv.compile(schema);
}

interface DatumValidatorCache {
  envelope?: ValidateFunction;
  payloads: Map<string, ValidateFunction>;
}

function createDatumValidatorCache(): DatumValidatorCache {
  return { payloads: new Map() };
}

function schemaDiagnostics(
  errors: ErrorObject[] | null | undefined,
  pathPrefix: string,
  code: string,
): ProcessDiagnostic[] {
  return (errors ?? []).map((error) => {
    const property = error.keyword === "additionalProperties"
      ? error.params.additionalProperty
      : error.keyword === "required"
        ? error.params.missingProperty
        : undefined;
    const fieldPath = typeof property === "string"
      ? `/${property.replaceAll("~", "~0").replaceAll("/", "~1")}`
      : "";
    return {
      code,
      path: `${pathPrefix}${error.instancePath}${fieldPath}`,
      message: `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    };
  });
}

/** Check one payload against an exact schema without lifecycle context. */
export function payloadSchemaDiagnostics(schema: Record<string, unknown>, payload: unknown, pathPrefix: string): ProcessDiagnostic[] {
  const validate = validator(schema);
  return validate(payload) ? [] : schemaDiagnostics(validate.errors, pathPrefix, "datum-payload");
}

export function renderLifecycleDatum(datum: DatumEnvelope): string {
  const { body, ...frontmatter } = datum;
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`;
}

function parseDatum(
  source: string,
  relativePath: string,
  sourceDigest: string,
): RepositoryResult<ParsedDatum> {
  if (!source.startsWith("---\n")) {
    return {
      ok: false,
      diagnostics: [{
        code: "datum-frontmatter",
        path: relativePath,
        message: "Lifecycle Datum Markdown must begin with YAML frontmatter",
      }],
    };
  }
  const closing = source.indexOf("\n---\n", 4);
  if (closing < 0) {
    return {
      ok: false,
      diagnostics: [{
        code: "datum-frontmatter",
        path: relativePath,
        message: "Lifecycle Datum Markdown must close its YAML frontmatter",
      }],
    };
  }
  try {
    const metadata = parse(source.slice(4, closing)) as unknown;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new Error("frontmatter must be an object");
    }
    const datum = {
      ...(metadata as Record<string, unknown>),
      body: source.slice(closing + 5),
    } as unknown as DatumEnvelope;
    return {
      ok: true,
      value: {
        relativePath,
        sourceDigest,
        lifecycleDatum: {
          datum,
          storage: { editable: true, frozen: false },
          integrity: {
            parseable: true,
            schema_valid: true,
            identity_valid: true,
            references_valid: true,
            hash_valid: true,
          },
        },
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "datum-frontmatter",
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function frozenRevisionMemberships(
  processPackage: ProcessPackage,
  lifecycleData: LifecycleRecord[],
): Map<string, string[]> {
  const memberships = new Map<string, string[]>();
  const baselineType = processPackage.kernelCapabilities["exact-baseline@1"]?.type;
  if (!baselineType) return memberships;
  for (const baseline of lifecycleData) {
    if (baseline.datum.type !== baselineType) continue;
    const snapshot = baseline.datum.payload.snapshot;
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      continue;
    }
    if (!memberships.has(baseline.datum.revision_id)) {
      memberships.set(baseline.datum.revision_id, []);
    }
    for (const field of ["definition_members", "evidence"] as const) {
      const identities = baseline.datum.payload[field];
      if (!Array.isArray(identities)) continue;
      for (const identity of identities) {
        if (typeof identity !== "string") continue;
        const containing = memberships.get(identity) ?? [];
        if (!containing.includes(baseline.datum.revision_id)) {
          containing.push(baseline.datum.revision_id);
        }
        memberships.set(identity, containing);
      }
    }
  }
  for (const containing of memberships.values()) containing.sort();
  return memberships;
}

function payloadPathValue(
  payload: Record<string, unknown>,
  field: string,
): unknown {
  return field.split(".").reduce<unknown>((value, segment) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)[segment]
      : undefined, payload);
}

export function deriveDatumStorage(
  processPackage: ProcessPackage,
  datum: DatumEnvelope,
  frozenByBaseline: boolean,
): LifecycleRecord["storage"] {
  const resolved = resolveType(processPackage, datum.type);
  const lifecycle = resolved.ok ? resolved.type.lifecycle : {};
  const terminalField = typeof lifecycle.terminal_payload_field === "string"
    ? lifecycle.terminal_payload_field
    : undefined;
  const terminalValues = Array.isArray(lifecycle.terminal_values)
    ? lifecycle.terminal_values
    : [];
  const frozenByTerminalOutcome = lifecycle.freeze_when === "terminal-outcome" &&
    terminalField !== undefined &&
    terminalValues.includes(payloadPathValue(datum.payload, terminalField));
  const frozen = frozenByBaseline || frozenByTerminalOutcome;
  return { editable: !frozen, frozen };
}

export function provisionalLifecycleRecord(
  datum: DatumEnvelope,
): LifecycleRecord {
  return {
    datum,
    storage: { editable: true, frozen: false },
    integrity: {
      parseable: true,
      schema_valid: true,
      identity_valid: true,
      references_valid: true,
      hash_valid: true,
    },
  };
}

export function deriveLifecycleRecordStorage(
  processPackage: ProcessPackage,
  records: LifecycleRecord[],
): LifecycleRecord[] {
  const memberships = frozenRevisionMemberships(processPackage, records);
  return records.map((record) => ({
    ...record,
    storage: deriveDatumStorage(
      processPackage,
      record.datum,
      memberships.has(record.datum.revision_id),
    ),
  }));
}

function applyStorageFacts(
  processPackage: ProcessPackage,
  parsed: ParsedDatum[],
): void {
  const derived = deriveLifecycleRecordStorage(
    processPackage,
    parsed.map((item) => item.lifecycleDatum),
  );
  parsed.forEach((item, index) => {
    item.lifecycleDatum = derived[index]!;
  });
}

function stableLineage(parsed: ParsedDatum[], stableId: string): ParsedDatum[] {
  return parsed
    .filter((item) => item.lifecycleDatum.datum.id === stableId)
    .sort((left, right) =>
      left.lifecycleDatum.datum.revision - right.lifecycleDatum.datum.revision
    );
}

async function markdownPaths(root: string): Promise<string[]> {
  const dataRoot = path.join(root, ".lifecycle/data");
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        paths.push(path.relative(root, entryPath));
      }
    }
  }
  await visit(dataRoot);
  return paths.sort();
}

export async function verifyRepositoryDataSources(
  root: string,
  expected: readonly ParsedDatum[],
): Promise<RepositoryResult<undefined>> {
  const changed = await measureAsync("repository.integrity", async () => {
    const currentPaths = await markdownPaths(root);
    const currentPathSet = new Set(currentPaths);
    const expectedByPath = new Map(
      expected.map((item) => [item.relativePath, item.sourceDigest]),
    );
    const differingPath = [...new Set([
      ...currentPaths,
      ...expectedByPath.keys(),
    ])].sort().find((relativePath) => !expectedByPath.has(relativePath) ||
      !currentPathSet.has(relativePath));
    if (differingPath) return differingPath;

    const digests = await Promise.all(currentPaths.map(async (relativePath) => {
      try {
        const source = await fs.readFile(path.join(root, relativePath));
        return {
          relativePath,
          digest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { relativePath, digest: undefined };
        }
        throw error;
      }
    }));
    return digests.find(({ relativePath, digest }) =>
      digest !== expectedByPath.get(relativePath)
    )?.relativePath;
  });
  return changed
    ? {
      ok: false,
      diagnostics: [{
        code: "transaction-repository-changed",
        path: changed,
        message: "Authoritative Lifecycle Data changed after repository inspection",
      }],
    }
    : { ok: true, value: undefined, diagnostics: [] };
}

const publicationLockRef = "refs/mdlm/publication-lock";

function referenceParts(reference: string): [string, number] | undefined {
  const match = /^(.*)@([1-9][0-9]*)$/.exec(reference);
  return match?.[1] && match[2] ? [match[1], Number(match[2])] : undefined;
}

function targetDatum(
  lifecycleData: LifecycleRecord[],
  target: string,
): LifecycleRecord | undefined {
  return revisionIdentity.test(target)
    ? lifecycleData.find((datum) => datum.datum.revision_id === target)
    : lifecycleData.find((datum) => datum.datum.id === target);
}

function graphNode(
  processPackage: ProcessPackage,
  lifecycleData: LifecycleRecord[],
  identity: string,
): GraphNode | undefined {
  if (revisionIdentity.test(identity)) {
    const datum = lifecycleData.find((item) => item.datum.revision_id === identity);
    return datum
      ? { identity, identityKind: "revision", type: datum.datum.type }
      : undefined;
  }
  if (stableIdentity.test(identity)) {
    const datum = lifecycleData.find((item) => item.datum.id === identity);
    return datum
      ? { identity, identityKind: "stable-datum", type: datum.datum.type }
      : undefined;
  }
  return undefined;
}

function linkDiagnostics(
  processPackage: ProcessPackage,
  resolvedType: ResolvedType,
  links: DatumEnvelope["links"],
  lifecycleData: LifecycleRecord[],
  processRef: string,
): ProcessDiagnostic[] {
  const diagnostics: ProcessDiagnostic[] = [];
  const contracts = new Map(resolvedType.outgoingLinks.map((contract) => [
    String(contract.id),
    contract,
  ]));
  for (const [index, link] of links.entries()) {
    const contract = contracts.get(link.type);
    if (!contract) {
      diagnostics.push({
        code: "unknown-outgoing-link",
        path: `links[${index}].type`,
        message: `Resolved type '${resolvedType.id}' does not declare outgoing link '${link.type}'`,
      });
      continue;
    }
    const target = targetDatum(lifecycleData, link.target);
    if (!target) {
      const validIdentity = stableIdentity.test(link.target) || revisionIdentity.test(link.target);
      diagnostics.push({
        code: validIdentity ? "unknown-link-target" : "invalid-link-target-identity",
        path: `links[${index}].target`,
        message: validIdentity
          ? `Unknown link target '${link.target}'`
          : `Link target '${link.target}' is not a Stable Datum or exact Revision identity`,
      });
      continue;
    }
    const targets = Array.isArray(contract.targets) ? contract.targets : [];
    const compatible = targets.some((targetContract) => {
      if (typeof targetContract !== "object" || targetContract === null) return false;
      const value = targetContract as Record<string, unknown>;
      if (value.kind !== "datum" || !target) return false;
      const identity = value.identity;
      const identityMatches = identity === "either" ||
        (identity === "revision" && revisionIdentity.test(link.target)) ||
        (identity === "stable" && stableIdentity.test(link.target));
      return identityMatches && Array.isArray(value.types) &&
        value.types.includes(target.datum.type);
    });
    if (!compatible) {
      diagnostics.push({
        code: "incompatible-link-target",
        path: `links[${index}].target`,
        message: `Link '${link.type}' cannot target '${link.target}'`,
      });
    }
  }
  for (const contract of resolvedType.outgoingLinks) {
    const id = String(contract.id);
    const count = links.filter((link) => link.type === id).length;
    const cardinality = typeof contract.cardinality === "object" &&
        contract.cardinality !== null
      ? contract.cardinality as Record<string, unknown>
      : {};
    const minimum = typeof cardinality.minimum === "number" ? cardinality.minimum : 0;
    const maximum = typeof cardinality.maximum === "number"
      ? cardinality.maximum
      : Number.POSITIVE_INFINITY;
    if (count < minimum || count > maximum) {
      diagnostics.push({
        code: "link-cardinality",
        path: `links.${id}`,
        message: `Link '${id}' requires ${minimum}..${Number.isFinite(maximum) ? maximum : "many"} targets, received ${count}`,
      });
    }
  }
  return diagnostics;
}

function validateDatum(
  processPackage: ProcessPackage,
  datum: DatumEnvelope,
  lifecycleData: LifecycleRecord[],
  validators: DatumValidatorCache,
): ProcessDiagnostic[] {
  const resolved = resolveType(processPackage, datum.type);
  if (!resolved.ok) return resolved.diagnostics;
  const envelopeValidator = validators.envelope ??=
    validator(processPackage.envelopeSchema);
  let payloadValidator = validators.payloads.get(resolved.type.id);
  if (!payloadValidator) {
    payloadValidator = validator(resolved.type.payloadSchema);
    validators.payloads.set(resolved.type.id, payloadValidator);
  }
  const diagnostics = [
    ...(envelopeValidator(datum)
      ? []
      : schemaDiagnostics(envelopeValidator.errors, "datum", "datum-envelope")),
    ...(payloadValidator(datum.payload)
      ? []
      : schemaDiagnostics(payloadValidator.errors, "payload", "datum-payload")),
  ];
  if (diagnostics.length === 0) diagnostics.push(...validatePayloadCollections(resolved.type, datum, lifecycleData));
  if (
    !datum.id.startsWith(`${datum.type}-`) ||
    datum.revision_id !== `${datum.id}-r${String(datum.revision).padStart(5, "0")}`
  ) {
    diagnostics.push({
      code: "datum-identity",
      path: "revision_id",
      message: "Lifecycle Datum identity must match its type, Stable ID, and revision number",
    });
  }
  diagnostics.push(...linkDiagnostics(
    processPackage,
    resolved.type,
    datum.links,
    lifecycleData,
    datum.created_by.process_ref,
  ));
  diagnostics.push(...traceDatumDiagnostics(processPackage, datum, lifecycleData.map((record) => record.datum)));
  const trace = requirementTraceBinding(processPackage);
  if (trace?.decomposition_type) diagnostics.push(...validateChangeDatum(lifecycleData.map(r => r.datum), trace, datum));
  return diagnostics;
}

/** Validate one proposed Lifecycle Datum through the repository's canonical seam. */
export function lifecycleDatumDiagnostics(
  processPackage: ProcessPackage,
  datum: DatumEnvelope,
  lifecycleData: LifecycleRecord[],
): ProcessDiagnostic[] {
  return validateDatum(
    processPackage,
    datum,
    lifecycleData,
    createDatumValidatorCache(),
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

interface CapturedTransactionSource { source: string }
function directProvenance(item: ParsedDatum, pkg: ProcessPackage, packageDigest: string, sources: ReadonlyMap<string,CapturedTransactionSource>): boolean {
  const datum = item.lifecycleDatum.datum;
  const id = /^\.lifecycle\/data\/\.transactions\/([^/]+)\//.exec(item.relativePath)?.[1];
  if (!id) return false;
  try {
    const tx = JSON.parse(sources.get(id)?.source ?? "");
    const [actionId, actionVersion] = String(tx.action).split("@");
    const action = pkg.actions[actionId!];
    const identity = `${pkg.manifest.id}@${pkg.manifest.version}`;
    const trace = pkg.kernelCapabilities["requirement-trace@4"] ?? pkg.kernelCapabilities["requirement-trace@3"] ?? pkg.kernelCapabilities["requirement-trace@2"] ?? pkg.kernelCapabilities["requirement-trace@1"];
    const generatedScope = action?.capability === "implementation" && datum.type === trace?.scope_type && Array.isArray(tx.outputs) && datum.links.some(link => link.type === "belongs-to" && tx.outputs.some((output: DatumEnvelope) => output.type === trace.implementation_type && output.revision_id === link.target));
    return datum.created_by.transaction === "mdlm-direct-transaction@1" && tx.contract === "mdlm-direct-transaction@1" && tx.id === id &&
      typeof tx.operation === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(tx.operation) &&
      id === `direct-${createHash("sha256").update(tx.operation).digest("hex")}` &&
      typeof tx.proposalDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(tx.proposalDigest) &&
      tx.package?.reference === identity && tx.package?.digest === packageDigest &&
      datum.created_by.process_ref === `${identity}#${packageDigest}` && !!action && Number(actionVersion) === action.version &&
      (action.types.includes(datum.type) || generatedScope) && datum.created_by.prompt_ref === action.prompt_ref &&
      (!action.authority || !!tx.authority) && Array.isArray(tx.outputs) &&
      tx.outputs.filter((d: unknown) => structuralValuesEqual(d,datum)).length === 1;
  } catch { return false; }
}

function sourceDigest(source: Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

async function captureTransactionSources(
  root: string,
  parsed: readonly ParsedDatum[],
): Promise<Map<string, CapturedTransactionSource> | undefined> {
  const transactionFor = (item: ParsedDatum) =>
    /^\.lifecycle\/data\/\.transactions\/([^/]+)\//
      .exec(item.relativePath)?.[1];
  if (parsed.some((item) => transactionFor(item) === undefined)) return undefined;
  const transactions = [...new Set(parsed.map(transactionFor).filter(
    (transaction): transaction is string => transaction !== undefined,
  ))].sort();
  try {
    return new Map(await Promise.all(transactions.map(async (transaction) => {
      const executionPath = path.join(
        ".lifecycle/data/.transactions",
        transaction,
        "execution.json",
      );
      const source = await fs.readFile(path.join(root, executionPath), "utf8");
      return [transaction, { source }] as const;
    })));
  } catch {
    return undefined;
  }
}

export async function readRepositoryData(
  root: string,
  processPackage: ProcessPackage,
): Promise<RepositoryResult<ParsedDatum[]>> {
  const relativePaths = await measureAsync(
    "repository.discovery",
    () => markdownPaths(root),
  );
  recordRepositoryLoad(relativePaths.length);
  const sources = await Promise.all(relativePaths.map(async (relativePath) => ({
    relativePath,
    source: await fs.readFile(path.join(root, relativePath)),
  })));
  const selectedDigest = await processPackageDigest(processPackage.root);
  recordWork("repository.parse.records", relativePaths.length);
  const parsedResults = await measureAsync(
    "repository.parse",
    () => Promise.all(sources.map(async ({ relativePath, source }) =>
      parseDatum(
        source.toString("utf8"),
        relativePath,
        sourceDigest(source),
      )
    )),
  );
  const parsed: ParsedDatum[] = [];
  const diagnostics: ProcessDiagnostic[] = [];
  for (const result of parsedResults) {
    if (!result.ok) diagnostics.push(...result.diagnostics);
    else parsed.push(result.value);
  }
  diagnostics.push(...await verifyPublicationAnchors(root));
  const capturedTransactions = await captureTransactionSources(root, parsed);
  const authoringPackages = new Map<string, {pkg: ProcessPackage; digest: string}>();
  authoringPackages.set(`${processPackage.manifest.id}@${processPackage.manifest.version}#${selectedDigest}`, {pkg: processPackage, digest: selectedDigest});
  for (const item of parsed) {
    const ref = item.lifecycleDatum.datum.created_by.process_ref;
    if (authoringPackages.has(ref)) continue;
    const match = /^([a-z][a-z0-9-]*@[0-9]+\.[0-9]+\.[0-9]+)#(sha256:[a-f0-9]{64})$/.exec(ref);
    if (!match) continue;
    const packageRoot = path.join(root, ".lifecycle/packages", match[1]!);
    const loaded = await loadProcessPackage(packageRoot);
    if (!loaded.ok) continue;
    const actualDigest = await processPackageDigest(packageRoot);
    if (`${loaded.package.manifest.id}@${loaded.package.manifest.version}` === match[1] && actualDigest === match[2]) authoringPackages.set(ref, {pkg: loaded.package, digest: actualDigest});
  }
  for (const item of parsed) {
    const authoring = authoringPackages.get(item.lifecycleDatum.datum.created_by.process_ref);
    const valid = !!authoring && directProvenance(item, authoring.pkg, authoring.digest, capturedTransactions ?? new Map());
    item.lifecycleDatum.integrity.transaction_valid = valid;
    if (!valid) diagnostics.push({code:"direct-transaction-provenance-invalid",path:item.relativePath,message:"Lifecycle datum requires its exact authenticated direct publication transaction"});
  }
  applyStorageFacts(processPackage, parsed);
  const lifecycleData = parsed.map((item) => item.lifecycleDatum);
  recordWork("repository.validation.records", parsed.length);
  await measureAsync("repository.validation", async () => {
    const validators = createDatumValidatorCache();
    const historicalValidators = new Map<ProcessPackage, ReturnType<typeof createDatumValidatorCache>>();
    for (const item of parsed) {
      const authoring = authoringPackages.get(item.lifecycleDatum.datum.created_by.process_ref);
      if (authoring && authoring.pkg !== processPackage) {
        let cache = historicalValidators.get(authoring.pkg);
        if (!cache) {cache = createDatumValidatorCache(); historicalValidators.set(authoring.pkg, cache);}
        diagnostics.push(...validateDatum(authoring.pkg, item.lifecycleDatum.datum, lifecycleData, cache).map(d => ({...d, path: `${item.relativePath}#${d.path ?? ""}`})));
      }
      diagnostics.push(...validateDatum(
        processPackage,
        item.lifecycleDatum.datum,
        lifecycleData,
        validators,
      ).map(
        (diagnostic) => ({
          ...diagnostic,
          path: `${item.relativePath}#${diagnostic.path ?? ""}`,
        }),
      ));
    }
  });
  if (diagnostics.length === 0) for (const item of parsed) {
    authenticatedAuthoringPackages.set(item.lifecycleDatum.datum, {
      pkg: authoringPackages.get(item.lifecycleDatum.datum.created_by.process_ref)!.pkg,
      source: JSON.stringify(item.lifecycleDatum.datum),
    });
  }
  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, value: parsed, diagnostics: [] };
}

export async function repositoryLifecycleSnapshot(
  root: string,
  processPackage: ProcessPackage,
  processRef: string,
  phaseId?: string,
): Promise<RepositoryResult<LifecycleSnapshot>> {
  const loaded = await readRepositoryData(root, processPackage);
  return loaded.ok
    ? repositoryLifecycleSnapshotData(loaded.value, processRef, phaseId)
    : loaded;
}

export function repositoryLifecycleSnapshotData(
  parsed: ParsedDatum[],
  processRef: string,
  phaseId?: string,
): RepositoryResult<LifecycleSnapshot> {
  return {
    ok: true,
    value: {
      processRef,
      records: parsed.map((item) => item.lifecycleDatum),
      dependencyComparisons: [],
    },
    diagnostics: [],
  };
}

function payloadPathPresent(
  payload: Record<string, unknown>,
  payloadPath: string,
): boolean {
  let value: unknown = payload;
  for (const part of payloadPath.split(".")) {
    const asObject = typeof value === "object" && value !== null &&
        !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    if (!asObject || !Object.hasOwn(asObject, part)) return false;
    value = asObject[part];
  }
  return true;
}

export async function publishTransaction(
  root: string,
  processPackage: ProcessPackage,
  expectedData: DatumEnvelope[],
  data: DatumEnvelope[],
  executionId: string,
  executionRecord: unknown,
  kernelFinalizedOutputs: readonly KernelFinalizedOutput[] = [],
  beforeCommit?: () => Promise<RepositoryResult<undefined>>,
): Promise<RepositoryResult<TransactionPublication>> {
  const loaded = await readRepositoryData(root, processPackage);
  if (!loaded.ok) return loaded;
  return publishTransactionData(
    root,
    processPackage,
    loaded.value,
    expectedData,
    data,
    executionId,
    executionRecord,
    kernelFinalizedOutputs,
    async () => {
      const sources = await verifyRepositoryDataSources(root, loaded.value);
      if (!sources.ok || !beforeCommit) return sources;
      return beforeCommit();
    },
  );
}

export async function publishTransactionData(
  root: string,
  processPackage: ProcessPackage,
  parsed: ParsedDatum[],
  expectedData: DatumEnvelope[],
  data: DatumEnvelope[],
  executionId: string,
  executionRecord: unknown,
  kernelFinalizedOutputs: readonly KernelFinalizedOutput[] = [],
  beforeCommit?: () => Promise<RepositoryResult<undefined>>,
): Promise<RepositoryResult<TransactionPublication>> {
  const currentData = parsed.map((item) => item.lifecycleDatum.datum)
    .sort((left, right) => left.revision_id.localeCompare(right.revision_id));
  const expected = expectedData.slice()
    .sort((left, right) => left.revision_id.localeCompare(right.revision_id));
  if (!structuralValuesEqual(currentData, expected)) {
    return {
      ok: false,
      diagnostics: [{
        code: "transaction-repository-changed",
        path: ".lifecycle/data",
        message: "Lifecycle Data changed after Transaction inputs were validated; no outputs were published",
      }],
    };
  }
  const diagnostics: ProcessDiagnostic[] = [];
  const existing = parsed;
  const proposedIds = new Set<string>();
  const proposedRevisions = new Set<string>();
  for (const datum of data) {
    if (proposedRevisions.has(datum.revision_id)) {
      diagnostics.push({
        code: "transaction-output-identity-collision",
        path: datum.revision_id,
        message: `Transaction outputs repeat exact Revision '${datum.revision_id}'`,
      });
    }
    proposedRevisions.add(datum.revision_id);
    const lineage = existing.filter((item) =>
      item.lifecycleDatum.datum.id === datum.id
    );
    if (lineage.length === 0) {
      if (datum.revision !== 1 || proposedIds.has(datum.id)) {
        diagnostics.push({
          code: "transaction-output-lineage-invalid",
          path: datum.revision_id,
          message: `New Stable Datum '${datum.id}' must begin with exactly one Revision 1`,
        });
      }
      proposedIds.add(datum.id);
    } else {
      const type = lineage[0]?.lifecycleDatum.datum.type;
      const expectedRevision = Math.max(...lineage.map((item) =>
        item.lifecycleDatum.datum.revision
      )) + 1;
      const editable = lineage.find((item) => item.lifecycleDatum.storage.editable);
      if (type !== datum.type || datum.revision !== expectedRevision || editable) {
        diagnostics.push({
          code: editable ? "editable-revision-exists" : "transaction-output-lineage-invalid",
          path: datum.revision_id,
          message: editable
            ? `Stable Datum '${datum.id}' already has editable Revision '${editable.lifecycleDatum.datum.revision_id}'`
            : `Transaction output Revision '${datum.revision_id}' does not continue the exact '${type}' lineage at Revision ${expectedRevision}`,
        });
      }
    }
    const resolved = resolveType(processPackage, datum.type);
    if (!resolved.ok) diagnostics.push(...resolved.diagnostics);
    else {
      for (const managedPath of resolved.type.kernelManagedPayloadPaths) {
        if (
          !kernelFinalizedOutputs.some((output) => output.datum === datum) &&
          payloadPathPresent(datum.payload, managedPath)
        ) {
          diagnostics.push({
            code: "kernel-managed-payload",
            path: `payload.${managedPath}`,
            message: `Transaction output may not author kernel-managed payload path '${managedPath}'`,
          });
        }
      }
    }
  }
  const lifecycleData = deriveLifecycleRecordStorage(processPackage, [
    ...existing.map((item) => item.lifecycleDatum),
    ...data.map(provisionalLifecycleRecord),
  ]);
  const validators = createDatumValidatorCache();
  for (const [index, datum] of data.entries()) {
    diagnostics.push(...validateDatum(
      processPackage,
      datum,
      lifecycleData,
      validators,
    ).map((diagnostic) => ({
      ...diagnostic,
      path: `outputs[${index}]${diagnostic.path ? `.${diagnostic.path}` : ""}`,
    })));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const transactionRoot = ".lifecycle/data/.transactions";
  const transactionRelativePath = `${transactionRoot}/${executionId}`;
  const executionRelativePath = `${transactionRelativePath}/execution.json`;
  const finalDirectory = path.join(root, transactionRelativePath);
  const temporaryDirectory = path.join(
    root,
    ".lifecycle",
    `.transaction-${executionId}.${randomUUID()}.tmp`,
  );
  const created = data.map((datum) => ({
    id: datum.id,
    revisionId: datum.revision_id,
    type: datum.type,
    path: `${transactionRelativePath}/${datum.type}/${datum.id}/r${String(datum.revision).padStart(5, "0")}.md`,
  }));
  try {
    await fs.mkdir(temporaryDirectory, { recursive: true });
    for (let index = 0; index < data.length; index += 1) {
      const temporaryPath = path.join(
        temporaryDirectory,
        created[index]!.path.slice(transactionRelativePath.length + 1),
      );
      await fs.mkdir(path.dirname(temporaryPath), { recursive: true });
      await fs.writeFile(temporaryPath, renderLifecycleDatum(data[index]!), {
        flag: "wx",
      });
    }
    await fs.writeFile(
      path.join(temporaryDirectory, "execution.json"),
      `${JSON.stringify(executionRecord, null, 2)}\n`,
      { flag: "wx" },
    );
    await fs.mkdir(path.dirname(finalDirectory), { recursive: true });
    const commitFailure = await withRepositoryLock(
      root,
      publicationLockRef,
      async (renewLock) => {
        const commitReady = await beforeCommit?.();
        if (commitReady && !commitReady.ok) return commitReady;
        await writePublicationAnchor(root, executionId, temporaryDirectory);
        await renewLock();
        await fs.rename(temporaryDirectory, finalDirectory);
        return undefined;
      },
    );
    if (commitFailure) return commitFailure;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "transaction-output-collision"
          : "transaction-publication-failed",
        path: transactionRelativePath,
        message: `Transaction was not published: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
  return {
    ok: true,
    value: { created, executionPath: executionRelativePath },
    diagnostics: [],
  };
}

function durableGraphLinks(
  processPackage: ProcessPackage,
  lifecycleData: LifecycleRecord[],
): GraphLink[] {
  const links: GraphLink[] = [];
  for (const source of lifecycleData) {
    const resolved = resolveType(processPackage, source.datum.type);
    if (!resolved.ok) continue;
    const contracts = new Map(resolved.type.outgoingLinks.map((contract) => [
      String(contract.id),
      contract,
    ]));
    for (const link of source.datum.links) {
      const contract = contracts.get(link.type);
      const target = graphNode(processPackage, lifecycleData, link.target);
      if (!contract || !target) continue;
      links.push({
        source: source.datum.revision_id,
        sourceIdentityKind: "revision",
        sourceType: source.datum.type,
        type: link.type,
        target: link.target,
        targetIdentityKind: target.identityKind,
        inverseLabel: String(contract.inverse_label),
      });
    }
  }
  return links.sort((left, right) =>
    left.source.localeCompare(right.source) ||
    left.type.localeCompare(right.type) ||
    left.target.localeCompare(right.target)
  );
}

export async function inspectBacklinks(
  root: string,
  processPackage: ProcessPackage,
  identity: string,
): Promise<RepositoryResult<BacklinkInspection>> {
  const loaded = await readRepositoryData(root, processPackage);
  if (!loaded.ok) return loaded;
  const lifecycleData = loaded.value.map((item) => item.lifecycleDatum);
  const target = graphNode(processPackage, lifecycleData, identity);
  if (!target) {
    return {
      ok: false,
      diagnostics: [{
        code: "unknown-graph-identity",
        path: identity,
        message: `Unknown graph identity '${identity}'`,
      }],
    };
  }
  return {
    ok: true,
    value: {
      ...target,
      links: durableGraphLinks(processPackage, lifecycleData).filter((link) =>
        link.target === identity
      ),
    },
    diagnostics: [],
  };
}

export async function traceGraph(
  root: string,
  processPackage: ProcessPackage,
  identity: string,
  relation: string | undefined,
  depth: number,
): Promise<RepositoryResult<GraphTrace>> {
  const loaded = await readRepositoryData(root, processPackage);
  if (!loaded.ok) return loaded;
  const lifecycleData = loaded.value.map((item) => item.lifecycleDatum);
  const rootNode = graphNode(processPackage, lifecycleData, identity);
  if (!rootNode) {
    return {
      ok: false,
      diagnostics: [{
        code: "unknown-graph-identity",
        path: identity,
        message: `Unknown graph identity '${identity}'`,
      }],
    };
  }
  const availableLinks = durableGraphLinks(processPackage, lifecycleData)
    .filter((link) => relation === undefined || link.type === relation);
  const sourceStableIds = new Map(lifecycleData.map((item) => [
    item.datum.revision_id,
    item.datum.id,
  ]));
  const nodes = new Map<string, GraphNode>([[identity, rootNode]]);
  const links = new Map<string, GraphLink>();
  let frontier = new Set([identity]);
  for (let level = 0; level < depth && frontier.size > 0; level += 1) {
    const next = new Set<string>();
    for (const link of availableLinks) {
      const sourceStableId = sourceStableIds.get(link.source);
      if (
        !frontier.has(link.source) &&
        !frontier.has(link.target) &&
        (sourceStableId === undefined || !frontier.has(sourceStableId))
      ) continue;
      links.set(`${link.source}\0${link.type}\0${link.target}`, link);
      for (const adjacent of [link.source, link.target]) {
        if (nodes.has(adjacent)) continue;
        const node = graphNode(processPackage, lifecycleData, adjacent);
        if (node) {
          nodes.set(adjacent, node);
          next.add(adjacent);
        }
      }
    }
    frontier = next;
  }
  return {
    ok: true,
    value: {
      root: rootNode,
      depth,
      relation: relation ?? null,
      nodes: [...nodes.values()].sort((left, right) =>
        left.identity.localeCompare(right.identity)
      ),
      links: [...links.values()],
    },
    diagnostics: [],
  };
}

function projections(
  processPackage: ProcessPackage,
  lifecycleData: LifecycleRecord[],
  subject: LifecycleRecord,
  processReference: string,
): DatumProjections {
  const projected = projectionsForLifecycleData(
    processPackage,
    lifecycleData,
    processReference,
  ).get(subject.datum.revision_id);
  if (!projected) {
    throw new Error(
      `Could not project Lifecycle Datum '${subject.datum.revision_id}'`,
    );
  }
  return projected;
}

function projectionsForLifecycleData(
  processPackage: ProcessPackage,
  lifecycleData: LifecycleRecord[],
  processReference: string,
): Map<string, DatumProjections> {
  return measure("repository.report-projections", () => {
    const statesByRevision = new Map<string, Record<string, string | string[]>>();
    const evaluation = evaluateLifecycle(processPackage, {processRef: processReference, records:lifecycleData, dependencyComparisons:[]});
    for (const subject of lifecycleData) {
      const states = evaluation.artifacts[subject.datum.revision_id]?.states;
      if (states) statesByRevision.set(subject.datum.revision_id,states);
    }
    const graphLinks = durableGraphLinks(processPackage, lifecycleData);
    return new Map(lifecycleData.map((subject) => {
      const revisionId = subject.datum.revision_id;
      const backlinks = graphLinks.filter((link) =>
        link.target === subject.datum.id || link.target === revisionId
      );
      const resolved = resolveType(processPackage, subject.datum.type);
      return [revisionId, {
        ...(resolved.ok && resolved.type.payloadViews.length > 0 ? { views: renderPayloadViews(resolved.type, subject.datum.payload) } : {}),
        backlinks,
        states: statesByRevision.get(revisionId) ?? {},
        kernelCapabilities: resolved.ok
          ? resolved.type.kernelCapabilities
          : [],
      }];
    }));
  });
}

async function publishGeneratedJson(
  filePath: string,
  value: unknown,
): Promise<boolean> {
  try {
    const existing = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (structuralValuesEqual(existing, value)) return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  return true;
}

export async function rebuildRepositoryIndex(
  root: string,
  processPackage: ProcessPackage,
  packageReference: string,
): Promise<RepositoryResult<RepositoryIndexSummary>> {
  const loaded = await readRepositoryData(root, processPackage);
  if (!loaded.ok) return loaded;
  return rebuildRepositoryIndexData(root, packageReference, loaded.value);
}

export async function rebuildRepositoryIndexData(
  root: string,
  packageReference: string,
  parsed: ParsedDatum[],
): Promise<RepositoryResult<RepositoryIndexSummary>> {
  recordWork("repository.index.records", parsed.length);
  const relativePath = ".lifecycle/generated/indexes/data.json" as const;
  const indexPath = path.join(root, relativePath);
  const value = {
    schemaVersion: 1,
    generatedFrom: {
      package: packageReference,
      source: ".lifecycle/data",
    },
    data: parsed.map((item) => ({
      id: item.lifecycleDatum.datum.id,
      revisionId: item.lifecycleDatum.datum.revision_id,
      type: item.lifecycleDatum.datum.type,
      path: item.relativePath,
    })).sort((left, right) =>
      left.type.localeCompare(right.type) ||
      left.id.localeCompare(right.id) ||
      left.revisionId.localeCompare(right.revisionId)
    ),
  };
  const rebuilt = await publishGeneratedJson(indexPath, value);
  return {
    ok: true,
    value: { rebuilt, data: value.data.length, path: relativePath },
    diagnostics: [],
  };
}

export async function rebuildRepositoryReport(
  root: string,
  processPackage: ProcessPackage,
  processReference: string,
): Promise<RepositoryResult<RepositoryReportSummary>> {
  const loaded = await readRepositoryData(root, processPackage);
  if (!loaded.ok) return loaded;
  return rebuildRepositoryReportData(
    root,
    processPackage,
    processReference,
    loaded.value,
  );
}

export async function rebuildRepositoryReportData(
  root: string,
  processPackage: ProcessPackage,
  processReference: string,
  parsed: ParsedDatum[],
): Promise<RepositoryResult<RepositoryReportSummary>> {
  const listed = listDataFromParsed(parsed, processPackage, processReference);
  if (!listed.ok) return listed;
  recordWork("repository.report.records", listed.value.length);
  const relativePath = ".lifecycle/generated/reports/lifecycle.json" as const;
  const reportPath = path.join(root, relativePath);
  const value = {
    schemaVersion: 1,
    generatedFrom: {
      package: processReference,
      source: ".lifecycle/data",
    },
    data: listed.value,
  };
  const rebuilt = await publishGeneratedJson(reportPath, value);
  return {
    ok: true,
    value: { rebuilt, data: listed.value.length, path: relativePath },
    diagnostics: [],
  };
}

export async function showDatum(
  root: string,
  processPackage: ProcessPackage,
  processReference: string,
  identity: string,
): Promise<RepositoryResult<StoredDatum>> {
  const loaded = await readRepositoryData(root, processPackage);
  if (!loaded.ok) return loaded;
  const candidates = loaded.value.filter((item) =>
    item.lifecycleDatum.datum.id === identity ||
    item.lifecycleDatum.datum.revision_id === identity
  );
  candidates.sort((left, right) =>
    right.lifecycleDatum.datum.revision - left.lifecycleDatum.datum.revision
  );
  const selected = candidates[0];
  if (!selected) {
    return {
      ok: false,
      diagnostics: [{
        code: "unknown-datum",
        path: identity,
        message: `Unknown Lifecycle Datum '${identity}'`,
      }],
    };
  }
  const lifecycleData = loaded.value.map((item) => item.lifecycleDatum);
  return {
    ok: true,
    value: {
      lifecycleDatum: selected.lifecycleDatum,
      projections: projections(
        processPackage,
        lifecycleData,
        selected.lifecycleDatum,
        processReference,
      ),
    },
    diagnostics: [],
  };
}

export async function datumHistory(
  root: string,
  processPackage: ProcessPackage,
  stableId: string,
): Promise<RepositoryResult<DatumHistory>> {
  const loaded = await readRepositoryData(root, processPackage);
  if (!loaded.ok) return loaded;
  const lineage = stableLineage(loaded.value, stableId);
  const first = lineage[0];
  if (!first) {
    return {
      ok: false,
      diagnostics: [{
        code: "unknown-datum",
        path: stableId,
        message: `Unknown Stable Datum '${stableId}'`,
      }],
    };
  }
  const memberships = frozenRevisionMemberships(
    processPackage,
    loaded.value.map((item) => item.lifecycleDatum),
  );
  return {
    ok: true,
    value: {
      id: stableId,
      type: first.lifecycleDatum.datum.type,
      revisions: lineage.map((item) => {
        const datum = item.lifecycleDatum.datum;
        return {
          revision: datum.revision,
          revisionId: datum.revision_id,
          classification: item.lifecycleDatum.storage.frozen
            ? "frozen-history" as const
            : "editable-work" as const,
          frozenBy: memberships.get(datum.revision_id) ?? [],
          processRef: datum.created_by.process_ref,
        };
      }),
    },
    diagnostics: [],
  };
}

export async function listData(
  root: string,
  processPackage: ProcessPackage,
  processReference: string,
): Promise<RepositoryResult<ListedDatum[]>> {
  const loaded = await readRepositoryData(root, processPackage);
  if (!loaded.ok) return loaded;
  return listDataFromParsed(loaded.value, processPackage, processReference);
}

export function listDataFromParsed(
  parsed: ParsedDatum[],
  processPackage: ProcessPackage,
  processReference: string,
): RepositoryResult<ListedDatum[]> {
  const selected = new Map<string, ParsedDatum>();
  for (const item of parsed) {
    const current = selected.get(item.lifecycleDatum.datum.id);
    if (
      !current ||
      current.lifecycleDatum.datum.revision < item.lifecycleDatum.datum.revision
    ) {
      selected.set(item.lifecycleDatum.datum.id, item);
    }
  }
  const lifecycleData = parsed.map((item) => item.lifecycleDatum);
  const projectionByRevision = projectionsForLifecycleData(
    processPackage,
    lifecycleData,
    processReference,
  );
  const result = [...selected.values()].map((item) => ({
    lifecycleDatum: item.lifecycleDatum,
    projections: projectionByRevision.get(
      item.lifecycleDatum.datum.revision_id,
    )!,
  }));
  result.sort((left, right) =>
    left.lifecycleDatum.datum.type.localeCompare(right.lifecycleDatum.datum.type) ||
    left.lifecycleDatum.datum.id.localeCompare(right.lifecycleDatum.datum.id)
  );
  return { ok: true, value: result, diagnostics: [] };
}
