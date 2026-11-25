# Session log healer

Checks DSH v4 session logs and repairs recoverable frame layouts while preserving every original record.

## What it does

- After startup, scans `session.v4.jsonl.zstd` files under the active JSONL persistence backend's session root. It repeats the scan after the configured interval, measured from completion of the previous scan.
- Acquires the persistence backend's actual session write lease before reading a file. A session owned by a live writer is skipped, including when its file has not changed recently.
- Scans and decompresses **every frame separately**. It never treats plaintext from the first frame or a successful prefix as the complete session.
- Validates UTF-8 without replacement characters, JSONL, the v4 session header, and the installed DSH format catalog with strict recovery and current-format validation. The canonical file also has to pass DSH's actual zstd read path.
- Repairs a header frame containing multiple complete records. A final record missing its newline is repairable only when the whole JSON record and full session validation succeed; the only plaintext change is one added newline.
- Writes and verifies a unique temporary file in the session directory, syncs it, creates a synced backup with an exclusive filename, checks the original snapshot again, and replaces the live file by rename while retaining the write lease.
- Cancels in-flight work on unload and waits for the scan to release its lease. Pending work cannot commit after cancellation.

Legal empty zstd frames and empty raw blocks are accepted without rewriting. Valid logs are left byte-identical.

## What is reported as manual

Files with an undecodable frame, an incomplete compressed tail, invalid UTF-8, incomplete/invalid JSON, missing header fields, unsupported required events, or invalid session relationships are not overwritten. Recovering a complete prefix by deleting undecodable records is outside this plugin's automatic repair policy.

Transient checksum errors are retried a bounded number of times using public per-frame decoders. If a retry succeeds and the session is already valid, the original file remains unchanged. This plugin does not repair the underlying Node runtime or guarantee recovery from permanently damaged compressed bytes.

An append or replacement detected after the snapshot is taken causes the file to be skipped. A failed staging write, backup write, or rename leaves the original live file in place. A complete backup remains available when replacement fails.

## Configuration

The existing default row in `cordis.patch.yml` works without changes:

```yaml
- insert:
    - id: dsh-session-log-healer
      name: '@local/dsh-session-log-healer'
      config:
        # Default: ctx.sessionPersistence.root.
        # Optional: that root or a subdirectory within it.
        root: 'C:/Users/You/.dsh/sessions'
        startupDelayMs: 3000
        intervalMs: 86400000
        scanActive: true
```

`startupDelayMs` must be a finite safe integer of at least zero; `intervalMs` must be a finite safe integer of at least one. Numeric configuration strings are accepted. Long delays, including a thirty-day interval of `2592000000`, use supported timer chunks instead of overflowing to a 1 ms interval.

`scanActive: true` additionally skips files changed within the last ten minutes. Setting it to `false` includes recently changed files, but **never bypasses the actual write lease**.

The default root follows DSH's configured persistence root. Custom roots must remain within that backend's root. Junction aliases are mapped back to the backend's literal root path so the Windows semaphore name matches DSH's writer.

## Compatibility and limits

- Requires Node.js 24 or newer with zstd support and the DSH v4 JSONL zstd backend. Verified with DSH's Node `24.21.0`, CLI Node `26.13.1`, and persistence package `0.2.2-rc.3`.
- Uses the installed backend's `acquireLease()` and `readZstdPrefix()` methods, plus the installed session format catalog. These backend methods are present in the verified build but are internal compatibility hooks. If the backend or full validator is unavailable, startup fails before automatic writes are scheduled.
- Skips compressed files larger than 512 MiB. Decoded plaintext is bounded to 512 MiB and frame count to one million. Directory/file symlinks encountered during traversal are not followed.
- Backups are named `*.corrupt-<timestamp>-<uuid>.bak`; this version does not overwrite an existing backup or prune old backups.
- Temporary files and backups are synced before replacement. POSIX directory entries are also synced. Windows uses Node's same-directory rename; no forced power-loss durability or custom Windows ACL preservation claim is made.
- Reload the plugin after updating its files. A running instance retains the previously loaded JavaScript until it is reloaded.

## Regression checks

From the plugin directory, run:

```powershell
node --test test/*.test.mjs
```

These checks use generated temporary session files and test backend/catalog doubles. They cover complete-frame retention, write failures, concurrent changes, lease contention, cancellation, format checks, and scheduling. Cleanup verifies that its target remains inside the temporary parent directory before removing it. The separate local DSH integration verification uses the actual installed format validator, read path, native write lease, synthetic writer processes, and Cordis lifecycle; it does not start a DSH service or scan real session logs.
