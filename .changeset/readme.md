# Changesets

This folder contains **pending release notes** for Kimaki packages. Each `.md` file describes one user-facing fix or feature that should appear in the next generated changelog.

## What to put here

- Add one descriptive kebab-case `.md` file per logical change, for example `fix-discord-thread-rename.md`.
- Use `patch` for fixes and `minor` for new features.
- Write in present tense, focused on what users see.
- Check GitHub issues first. If the change fixes one, include `Fixes #123` on its own line.

## What not to put here

- Do not add changesets for private packages or packages without a `version` field.
- Do not edit `CHANGELOG.md` directly.
- Do not run the interactive changeset CLI.
- Do not add vague entries like "misc improvements" or "update internals".
