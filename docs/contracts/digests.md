# Digest and snapshot preimages

This page describes how the current kernel computes each identity digest, so
another kernel or tool can reproduce it. It records today's behavior and does
not change it. Any change to a canonicalization or to path handling is separate,
paired compatibility work.

[`test/fixtures/digest-vectors.json`](../../test/fixtures/digest-vectors.json)
holds an input and the expected result for each digest.
`test/digest-vectors.test.ts` checks those vectors against the code, and checks
that a real lifecycle repository reports digests built from these preimages.

All hashes are SHA-256. Values written `sha256:<hex>` carry that prefix. Review
registration values are bare lowercase hex.

## Package digest

`package.digest` (`src/process-package-digest.ts`) hashes the package directory
as it is on disk:

1. Collect every regular file under the package root, recursing into
   directories. Symlinks and other entry types are skipped.
2. Sort the files by relative path, comparing UTF-16 code units (JavaScript's
   default sort). Paths use the platform separator, which is `/` on POSIX.
3. For each file, hash `<relative path>\0<decimal byte length>\0<exact bytes>`,
   with no separator between files.

Only paths relative to the package root count, so moving the package directory
leaves its digest unchanged.

## Snapshot

`snapshot` (`directState` in `src/direct-proposal.ts`) is
`sha256:` + SHA-256 of `JSON.stringify({package, repository, data})`:

- `package`: `{reference, digest, language}`, in that key order.
- `repository`: `git-commit:<sha>`, the single first-parent root commit of
  `HEAD`.
- `data`: every lifecycle datum in `.lifecycle/data/`, committed or not, sorted
  by `revision_id` with `String.prototype.localeCompare`. Each datum is its
  YAML front matter parsed as an object, plus a final `body` key holding the
  Markdown after the closing `---`.

`JSON.stringify` keeps keys in the order they were parsed. Rewriting a stored
datum so its keys (in the datum, `payload` or `created_by`) appear in another
order changes the snapshot, even though the JSON is equivalent. That
invalidation is deliberate and conservative. The vectors include one datum in
two key orders with different digests.

The lifecycle root path is not part of the snapshot, although datum payloads
may themselves hold paths such as `repository_path`. A clone or copy shares the
root commit, so it has the same snapshot whenever its package and data also
match. See the [direct-work contract](direct-work.md).

## Proposal digest

`proposalDigest` is `sha256:` + SHA-256 of the exact UTF-8 proposal bytes as
submitted. Whitespace, a trailing newline and key order all count.

## Transaction identity

A direct transaction's `id` is `direct-` + SHA-256 hex of the operation
identity's UTF-8 bytes. It depends on nothing else.

## Review registration

A registered review (`src/external-review.ts`, `mdlm-registered-review@3`)
binds three bare-hex digests:

- `contextSha256`: the [review binding](#review-binding). Registrations
  written by earlier kernels (`mdlm-registered-review@2`) instead hold the
  SHA-256 of the whole canonical review context, `snapshot` included, and are
  still checked that way.

  The canonical review context is the output of
  `mdlm review context <action> <subject> --json`, with the top-level `ok`,
  `command` and `diagnostics` keys dropped, serialized canonically:
  objects as `{` + entries sorted by key (UTF-16 code units), each
  `JSON.stringify(key):value`, joined by `,` + `}`; arrays as `[` + items
  joined by `,` + `]`; every other value with `JSON.stringify`. Keys whose
  value is `undefined` are omitted, and there is no whitespace. Key order in
  the input therefore does not matter.
- `verdictSha256`: SHA-256 of the exact verdict file bytes.
- `proposalSha256`: SHA-256 of the exact proposal file bytes.

## Review binding

A review binds its own context rather than the whole snapshot
([ADR 0011](../adr/0011-bind-reviews-to-their-context-not-the-snapshot.md)).
The review binding is SHA-256 of the canonical serialization (as above) of
`{contract: "mdlm-review-binding@1", repository, context}`, where
`repository` is the snapshot's `git-commit:<sha>` repository identity and
`context` is the canonical review context without its `snapshot` key. A
review proposal from `mdlm proposal draft` carries it as
`reviewBinding: "sha256:<hex>"`; the registry stores the bare hex as
`contextSha256`. Two snapshots that give a review the same context give the
same binding.

`exportSha256` in a context export receipt hashes the saved file bytes, which
are pretty-printed and may be an archive. It is a different value from
`contextSha256`, even when the file came from the same context.

## Absolute paths

Two identities include the lifecycle repository's absolute path, so a moved or
cloned repository changes them:

- **Review context.** The context's `action` carries each compiled
  expression's `contract.definitionPath`, the absolute path of the package's
  action file. That path is resolved lexically (`path.resolve`), so any
  symlinks in it are kept (for example
  `/srv/mdlm/lane-a/.lifecycle/packages/<ref>/actions/<id>.yaml#when`). That
  path is inside the `contextSha256` preimage, so the same review at another
  path has a different `contextSha256`.
- **Registry key.** The registry file is
  `$MDLM_REVIEW_REGISTRY/<SHA-256 hex of realpath(lifecycle root)>-<operation>.json`.
  A repository at another path finds no registration for the same operation.

A registration made at one path must be used at that exact path. Mapping it to
a fresh lane never rewrites either preimage or an existing proof.
