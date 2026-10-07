# Upstream Watch

A dependency-free Codex plugin that notices relevant upstream Git changes while you work. It fetches a selected branch into a dedicated tracking ref, compares changed paths with your contribution and dirty tracked files, and gives Codex bounded metadata for review.

No automatic merges, source edits, commits, pushes, model API requests, background service, or scheduled jobs. Requires Node.js 20+ and Git. Path overlap is a review candidate, not proof that someone fixed the same problem.

## Install

```sh
codex plugin marketplace add mertcandrks/codex-upstream-watch
codex plugin add upstream-watch@mertcandrks-plugins
```

Review and trust the plugin hooks through the supported Codex hook interface (`/hooks` in CLI). Installation does not automatically trust hooks. Start a fresh Codex conversation to verify loading in your client.

Invoke the `upstream-check` skill and choose the repository, remote and branch. Setup creates a local `.codex/upstream-watch.json` in the workspace:

```json
{ "enabled": true, "repo": "./", "remote": "origin", "branch": "main" }
```

Use a relative repository path if the workspace is not itself a Git repository. Keep this configuration untracked. Set `enabled` to `false` or disable the plugin to stop checks.

## Behavior and Privacy

Checks run on session start, prompts and supported tool events, at most once per 30 minutes per configured target. A manual `--check` bypasses the cooldown. Async results appear at the next supported conversation point, not as an independent notification. Git credentials use your existing Git setup; no credential files are read by this plugin. Git hooks and fsmonitor are disabled for its Git invocations, interactive credential prompts are disabled, and failures do not echo raw command output.

Reports include commit hashes and at most eight overlapping paths, not diffs, tokens, account exports, remote URLs or commit subjects. Common secret-file paths are suppressed. State contains only upstream hashes/timestamps in `PLUGIN_DATA` (temporary cache for manual runs). Fetching still updates Git objects and `refs/upstream-watch/*`; it does not update your working branch, index or `FETCH_HEAD`.

Changes in new untracked files, renamed-file semantic matches, or an open unmerged PR are not automatically detected. The skill can investigate candidates using existing Git/GitHub tools. Network availability, repository history and client hook support affect operation.

## Tests

```sh
node --test tests/check-upstream.test.cjs
```

## Distribution

This repository is a public Git-backed Codex marketplace, not an official universal-directory listing. OpenAI currently excludes hook-containing plugins from that public directory: [packaging documentation](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks).

AI development disclosure: implementation and tests were generated and edited by an AI coding assistant with the publisher's permission; no human manually edited the code.
