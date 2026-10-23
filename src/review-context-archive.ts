import type { DirectReviewContext } from "./direct-review-context.js";

type VerifierSource = NonNullable<DirectReviewContext["verifierSources"]>[number];
type Files = VerifierSource["files"];
export type SavedReviewContext = DirectReviewContext & {ok: boolean; command: string; diagnostics: unknown[]};
export interface ReviewContextArchive {
  contract: "mdlm-review-context-archive@1";
  context: Omit<SavedReviewContext, "verifierSources">;
  verifierSources?: (Omit<VerifierSource, "files"> & {filesRef: number})[];
  verifierSourceTrees: Files[];
}
type Content = Pick<Files[number], "content" | "encoding">;
export interface ReviewContentArchive extends Omit<ReviewContextArchive, "contract" | "verifierSourceTrees"> {
  contract: "mdlm-review-context-archive@2";
  verifierSourceTrees: (Omit<Files[number], "content" | "encoding"> & {contentRef: number})[][];
  verifierContents: Content[];
}

/** Transport only. Native review context and registration hashes stay expanded. */
export function archiveReviewContext(context: SavedReviewContext): ReviewContextArchive {
  const {verifierSources, ...rest} = context;
  const verifierSourceTrees: Files[] = [], indices = new Map<string, number>();
  const sources = verifierSources?.map(({files, ...source}) => {
    const key = JSON.stringify(files);
    let filesRef = indices.get(key);
    if (filesRef === undefined) {
      filesRef = verifierSourceTrees.length;
      indices.set(key, filesRef);
      verifierSourceTrees.push(files);
    }
    return {...source, filesRef};
  });
  return {contract: "mdlm-review-context-archive@1", context: rest, ...(sources ? {verifierSources: sources} : {}), verifierSourceTrees};
}

/** Share exact representations, not just blob names or decoded byte equality. */
export function archiveReviewContents(context: SavedReviewContext): ReviewContentArchive {
  const archive = archiveReviewContext(context);
  const verifierContents: Content[] = [], indices = new Map<string, number>();
  const verifierSourceTrees = archive.verifierSourceTrees.map(files => files.map(({content, encoding, ...file}) => {
    const payload = {content, ...(encoding !== undefined ? {encoding} : {})};
    const key = JSON.stringify(payload);
    let contentRef = indices.get(key);
    if (contentRef === undefined) {
      contentRef = verifierContents.length;
      indices.set(key, contentRef);
      verifierContents.push(payload);
    }
    return {...file, contentRef};
  }));
  return {...archive, contract: "mdlm-review-context-archive@2", verifierSourceTrees, verifierContents};
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Resolve only embedded lists, never source paths, Git repositories or manifests. */
export function expandReviewContextArchive(value: unknown): SavedReviewContext {
  if (object(value) && value.contract === "mdlm-review-context-archive@2") {
    if (!Array.isArray(value.verifierContents) || value.verifierContents.some(content => !object(content) || typeof content.content !== "string" || (content.encoding !== undefined && content.encoding !== "base64"))) throw new Error("Invalid embedded verifier contents");
    const contents = value.verifierContents;
    if (!Array.isArray(value.verifierSourceTrees)) throw new Error("Review context archive has no embedded verifier trees");
    const trees = value.verifierSourceTrees.map(files => {
      if (!Array.isArray(files)) throw new Error("Invalid embedded verifier file list");
      return files.map(file => {
        if (!object(file) || "content" in file || "encoding" in file || !Number.isSafeInteger(file.contentRef) || Number(file.contentRef) < 0 || Number(file.contentRef) >= contents.length) throw new Error("Invalid or missing embedded verifier content reference");
        const {contentRef, ...entry} = file;
        const content = contents[Number(contentRef)] as Content;
        return {...entry, content: content.content, ...(content.encoding !== undefined ? {encoding: content.encoding} : {})};
      });
    });
    return expandReviewContextArchive({...value, contract: "mdlm-review-context-archive@1", verifierSourceTrees: trees});
  }
  if (!object(value) || value.contract !== "mdlm-review-context-archive@1") throw new Error("Unsupported review context archive contract");
  if (!object(value.context) || value.context.contract !== "mdlm-direct-review-context@1" || "verifierSources" in value.context) throw new Error("Invalid expanded review context header");
  if (!Array.isArray(value.verifierSourceTrees)) throw new Error("Review context archive has no embedded verifier trees");
  const trees = value.verifierSourceTrees;
  for (const files of trees) {
    if (!Array.isArray(files) || files.some(file => !object(file) || typeof file.path !== "string" || typeof file.blob !== "string" || typeof file.content !== "string" || (file.encoding !== undefined && file.encoding !== "base64"))) throw new Error("Invalid embedded verifier file list");
  }
  let sources: VerifierSource[] | undefined;
  if (value.verifierSources !== undefined) {
    if (!Array.isArray(value.verifierSources)) throw new Error("Invalid verifier source occurrences");
    sources = value.verifierSources.map(source => {
      if (!object(source) || typeof source.activity !== "string" || typeof source.sourceCommit !== "string" || "files" in source || !Number.isSafeInteger(source.filesRef) || Number(source.filesRef) < 0 || Number(source.filesRef) >= trees.length) throw new Error("Invalid or missing embedded verifier tree reference");
      const {filesRef, ...occurrence} = source;
      return {...occurrence, files: trees[Number(filesRef)]} as VerifierSource;
    });
  }
  return {...value.context, ...(sources ? {verifierSources: sources} : {})} as SavedReviewContext;
}
