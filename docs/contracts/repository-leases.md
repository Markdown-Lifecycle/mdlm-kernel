# Repository lease and lock-wait contract

`src/repository-lock.ts` owns this protocol. Any kernel that mutates the same
lifecycle repository must follow it byte for byte, so two kernel versions (or
two implementations) running against one repository exclude each other.
Leases serialize mutation only. They never authorize publication; the
[direct-work contract](direct-work.md) still validates every proposal.

## Refs

| Scope | Ref | Taken by |
| --- | --- | --- |
| Transaction | `refs/mdlm/transaction-lock` | `proposal submit`, `execution run`, `review register`, `upgrade apply` |
| Publication | `refs/mdlm/publication-lock` | The final move of a transaction's data into `.lifecycle/data/` |

Read-only commands, including `proposal settlement` and `execution settlement`,
take no lease.

## Lease blob

A lease is a Git blob in the lifecycle repository's object store, pointed to
directly by the scope's ref. Its bytes are one compact JSON object followed by
a single `\n`:

```json
{"expiresAt":1760952000000,"pid":4242,"token":"5f0c6c1e-3a0b-4f39-9a51-1d2e8f0f6a77"}
```

- `expiresAt`: number, milliseconds since the Unix epoch after which the
  lease is abandoned.
- `pid`: number, the holder's operating-system process ID.
- `token`: string, a random UUID unique to one acquisition.

Keys appear in this order and the blob is written with
`git hash-object -w --stdin`.

## Acquire, renew, release

All ref changes are compare-and-swap `git update-ref` calls.

1. **Acquire.** Write a fresh blob, then create the ref only if it is absent
   (`update-ref <ref> <blob> 0000…`).
2. **Take over an abandoned lease.** If the ref exists, read its blob. The lease
   is abandoned when the blob is not parseable JSON, any field above is missing
   or has the wrong type, `kill(pid, 0)` reports no such process on this host,
   the current time is at or after `expiresAt`, or the holder is this same
   process and recorded that token as released after its delete kept failing. A waiter replaces an abandoned
   lease by swapping the ref from the observed blob to its own. A permission
   error from `kill` means the holder may be alive, so the lease is live.
3. **Renew.** To fence a commit, the holder writes a new blob with a later
   `expiresAt` and the same `token`, and swaps the ref from its previous blob.
   If that swap fails, the lease was lost and the holder aborts without
   committing. Today the publication lease is renewed before every data move,
   and `upgrade apply` renews its transaction lease before installing. The
   other transaction-lease holders do not renew.
4. **Release.** Delete the ref only if it still points to the holder's blob
   (`update-ref -d <ref> <blob>`). A ref that already points elsewhere is left
   alone.

## Scope order

A kernel that needs both scopes takes the transaction lease first and the
publication lease inside it, and never the reverse. Only `proposal submit`
takes both; the other mutating commands take the transaction lease alone.

## Bounded wait and refusal

At each scope, a kernel retries acquisition until it either holds the lease or
a bounded wait elapses. The wait is a kernel policy,
`repositoryLockWaitMilliseconds` in `src/repository-lock.ts`. It is not a
service-level guarantee: callers must not depend on its value, and a kernel may
change it. A lease released within the wait must be acquired; a kernel may not
refuse merely because a lease was briefly held.

When the wait elapses against a live lease, the command refuses. For
`proposal submit` this is `{ok:false, diagnostics:[{code:"direct-proposal-invalid", ...}]}`
with a nonzero exit, and the message names the contended ref. Refusal publishes
nothing, leaves the peer's lease untouched, releases any lease this command
held, and leaves settlement at `not-published`. The same proposal bytes may be
submitted again later and are accepted if still valid. A caller's own timeout
is not a kernel refusal; check settlement before acting on an uncertain outcome.

## Completed-replay precedence

`proposal submit` decides in this order once it holds the transaction lease:

1. If the operation already has a published transaction, return it: the
   identical accepted result when the proposal bytes have the same digest,
   otherwise refuse the reused operation. This happens before any stale-snapshot
   or package check and never waits for the publication lease.
2. Otherwise, reject a stale package or snapshot.
3. Otherwise, validate and publish under the publication lease.

A completed replay therefore still waits for, and can be refused by, transaction
contention. Its settlement remains `accepted` either way.
