# Changelog

**English** | [简体中文](CHANGELOG.md)

## 1.1.0 — 2026-11-25

- Decompress and validate every zstd frame, preserving the session header and all event records.
- Acquire DSH's actual session write lease before reading and recheck the file snapshot before replacement.
- Use a unique temporary file, synced writes, a separate backup, and replacement within the same directory.
- Strictly validate UTF-8, JSONL, the v4 session format, and DSH's actual read path.
- Preserve damaged or incomplete files and report them for manual handling.
- Fix timer overflow for long scan intervals, cancel work on unload, and release the write lease.
- Accept legal empty zstd frames and empty raw blocks.
- Add regression tests, open-source documentation, the MIT license, and GitHub Actions.
