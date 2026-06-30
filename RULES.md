# RULES

Operating rules for anyone (human or AI assistant) working in this repository.

## Git

- **Never `git commit` without the user's explicit permission for that specific commit.**
- **Never `git push` without the user's explicit permission.**
- Do not create branches, tags, rebase, reset, or rewrite history unless asked.
- Staging changes (`git add`) and showing diffs is fine; turning them into commits is not, until asked.
- "Do the work" / "implement X" is **not** permission to commit. Permission to commit must be explicit (e.g. "commit this", "go ahead and commit").

## Publishing

- **Never run `npm publish` (or any release/deploy command).** The user runs publish themselves.
- Preparing for publish (build, `npm publish --dry-run`, metadata) is fine; the actual publish is the user's keystroke.

## General

- For any irreversible or outward-facing action (commit, push, publish, deleting files you did not create, sending data to external services), ask first.
- When unsure whether something needs permission, assume it does and ask.
