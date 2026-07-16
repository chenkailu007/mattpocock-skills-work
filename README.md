# Matt Pocock Skills for ChatGPT Work

This repository packages the promoted skills from
[`mattpocock/skills`](https://github.com/mattpocock/skills) as a
ChatGPT Work plugin marketplace.

## Install on a new host

The product is ChatGPT Work. The current command-line executable is still
named `codex`.

```sh
codex plugin marketplace add chenkailu007/mattpocock-skills-work --ref main
codex plugin add mattpocock-skills@mattpocock-work
```

Start a new ChatGPT Work task after installation.

## Refresh an installed copy

```sh
codex plugin marketplace upgrade mattpocock-work
codex plugin add mattpocock-skills@mattpocock-work
```

## Provenance

[`upstream.lock.json`](./upstream.lock.json) records the exact upstream
commit, commit time, upstream plugin version, selected skills, and adapter
version used to generate the current plugin.

The scheduled workflow checks upstream daily. When upstream changes, it
regenerates the plugin, validates the complete bundle, and opens or updates a
reviewable pull request.

Generated files under `plugins/mattpocock-skills/` must not be edited by hand.
Change `scripts/sync-upstream.mjs` instead.
