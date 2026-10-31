# Bounded directory export for device file sync

`createDeviceFileSync().prepare({ paths, signal, recursive?: boolean })` exports a one-time bundle using the existing device-center file sync. `recursive` defaults to `false`; selecting a directory without `true` fails. This adds no archive format, glob expansion, deletion, watching, or continuous synchronization. Receive preview, explicit overwrite, Bot revision/lease checks and import behavior remain the existing file-sync flow.

Paths are portable project-relative paths, including the selected directory prefix in each exported file name. `.` and absolute paths are rejected; select named directories or individual files. Selected roots and directory children are sorted by JavaScript string order, then traversed depth first. Overlapping selections and case-folded duplicate paths fail. Directories are traversal containers; empty directories are not transferred. A selection with no transferable regular files fails rather than creating an unusable empty bundle.

Explicitly selected denied paths fail. During recursive traversal, `.git` and `node_modules` are pruned as `ignored`. The existing sensitive path rules are pruned as `sensitive`, including `.env*`, credential/token/secret names, private key formats and private configuration directories. The `.env*` rule also applies to explicitly selected and received paths. Pruning is name based, not content inspection or `.gitignore` interpretation. An excluded directory counts as one exclusion; its descendants are not visited or counted. Symbolic links and Windows junctions fail the entire preparation, including links bearing an excluded name. Other unsupported file types, hard-linked regular files, unsafe names and changed directory/file identities also fail.

When exclusions occur, `DeviceFileBundle.manifest` additionally contains:

```ts
exclusions?: { path: string; reason: "ignored" | "sensitive" }[];
totalExcluded?: number;
```

Both fields are absent when nothing was excluded. `exclusions` is a deterministic prefix with at most 128 entries and at most 8192 UTF-8 bytes for its JSON array. `totalExcluded` counts all pruned entries, including those omitted from the bounded summary. Excluded file contents are never opened or included. Receiving/staging validates and preserves the bounded summary; exclusions are informational and never authorize destination operations.

The existing 128-file and 8 MiB decoded-content limits apply incrementally, with each file's size checked against the remaining byte budget before allocation/read. Recursive scanning has a separate 4096 visited-entry budget, counting selected paths plus every enumerated directory entry, including excluded entries. Directory enumeration uses a bounded list before sorting; exceeding any budget rejects the whole preparation. Existing staging-count and 32 MiB global staged-byte limits remain in force. No partial bundle is returned on failure.

Cancellation and service closure are checked throughout asynchronous traversal and file reading. Directory handles close on every exit. Every traversed path retains the existing project boundary, sensitive-name, symlink/junction and identity checks. These checks do not provide operating-system isolation against a hostile local account racing filesystem operations.

Regression coverage: `tests/unit/device-center-file-sync.test.ts`, including deterministic Unicode paths, exclusions and bounded summaries, explicit denial, Windows junction/POSIX symlink rejection, duplicate/overlap handling, scan/file/byte budgets and asynchronous cancellation.
