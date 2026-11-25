# DSH Session Log Healer

**English** | [简体中文](README.md)

[![Tests](https://github.com/micromango/dsh-session-log-healer/actions/workflows/test.yml/badge.svg)](https://github.com/micromango/dsh-session-log-healer/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A session log recovery plugin for DeepSeek Harness (DSH). It checks v4 JSONL zstd logs under the session write lease, preserves every original record, and repairs recoverable compressed frame layouts.

**Version: 1.1.0** · [Technical details](docs/DETAIL.md) · [Changelog](CHANGELOG.en.md)

## Features

- Decompresses every zstd frame separately and preserves every original record.
- Uses the DSH persistence backend's actual session write lease. Sessions owned by a live writer are skipped.
- Strictly validates UTF-8, JSONL, the v4 session header, and the DSH session format. The result must also pass DSH's actual read path.
- Repairs layouts where the session header and events share a compressed frame. A complete final JSON record may receive a missing newline only after the full session passes validation.
- Writes, syncs, and verifies a temporary file, creates a separate backup, checks the original file for changes, and replaces it within the same directory.
- Cancels pending work when the plugin is unloaded and waits for the scan to finish and release its write lease.

Valid logs remain byte-identical. Undecodable frames, permanently damaged checksums, incomplete records, and failed session validation are reported for manual handling; the original file is preserved. Backups are named `*.corrupt-<timestamp>-<uuid>.bak`.

## Requirements

- Node.js **24 or newer**, with built-in zstd support.
- The DSH v4 JSONL zstd persistence backend. Verified with `@deepseek-ai/dsh-session-persistence-jsonl@0.2.2-rc.3` and Node.js `24.21.0` and `26.13.1`.
- The host must provide `acquireLease()`, `readZstdPrefix()`, and the complete v4 session format catalog. These backend methods are internal compatibility hooks. If a required hook or validator is unavailable, the plugin refuses to start before scheduling automatic writes.

The plugin has no runtime dependencies to install separately. It uses Node.js built-in modules and the session format validator supplied by the DSH installation.

## Installation

Open DSH once to initialize the target profile, then fully quit DSH. Clone this repository into a permanent directory. For example, in PowerShell:

```powershell
git clone https://github.com/micromango/dsh-session-log-healer.git C:\dsh-plugins\dsh-session-log-healer
dsh plugin --profile desktop add "link:C:/dsh-plugins/dsh-session-log-healer"
```

`desktop` is the profile used by DSH Desktop. Replace it with your profile name when using another profile. `dsh plugin add` installs the local package and registers its `cordis.patch.yml` as a profile bundle layer. Reopen DSH after installation.

If your installation does not put the `dsh` command on PATH, use the DSH plugin manager to install the cloned directory as a local plugin. The target profile should then contain these entries:

```json
{
  "dependencies": {
    "@local/dsh-session-log-healer": "link:C:/dsh-plugins/dsh-session-log-healer"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-session-log-healer"]
    }
  }
}
```

Merge this fragment into the existing configuration, retaining the existing dependencies and bundle entries. The default Windows desktop profile is located at `%USERPROFILE%\.dsh\profiles\desktop`. If you configured a custom DSH data directory, use its actual profile path.

## Configuration and usage

The plugin scans automatically after loading. By default, it follows the active persistence backend's session root, starts its first scan after 3 seconds, and runs again 24 hours after the previous scan finishes. It skips logs modified within the last 10 minutes and always respects the actual session write lease.

The package's `cordis.patch.yml` supplies the default configuration. Available options are:

| Option | Default | Description |
| --- | --- | --- |
| `root` | Active persistence backend's session root | Must be that root or one of its subdirectories |
| `startupDelayMs` | `3000` | Delay before the first scan; a nonnegative safe integer |
| `intervalMs` | `86400000` | Time between completion of one scan and the next scan; a positive safe integer |
| `scanActive` | `true` | Also skips recently modified files; setting it to `false` still respects the write lease |

Compressed files larger than 512 MiB are skipped. Decoded plaintext is limited to 512 MiB, with at most one million frames. Directory and file symlinks encountered during traversal are not followed. Backups are retained; the plugin does not automatically prune old backups.

After updating the local source, reload the plugin or reopen DSH so the running instance uses the new code. See the [technical details](docs/DETAIL.md) for repair behavior, error handling, and platform limits.

## Development and verification

From the repository directory, run:

```powershell
npm test
```

The regression suite uses temporary generated logs and backend/catalog test doubles. It covers record preservation across multiple frames, write failures, concurrent changes, lease contention, cancellation, strict validation, and scheduling. Before cleanup, it checks that the target directory remains within the temporary parent directory.

GitHub Actions runs these regression tests on Windows and Linux with Node.js 24 and 26. Compatibility with DSH's native write lease and installed session format catalog requires separate verification against the corresponding host.

Report problems through [Issues](https://github.com/micromango/dsh-session-log-healer/issues), or contribute improvements through a pull request. Include the DSH, persistence backend, and Node.js versions, along with a synthetic log that reproduces the issue.

## License

[MIT](LICENSE). This repository provides the source for a community plugin.
