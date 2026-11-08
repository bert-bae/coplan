---
name: coplan-init
description: Set up .coplan/config.json — the checks each task runs in its implement → review → refine cycle
---

Set up this repository's Coplan config, so the build runs the right checks
instead of guessing.

1. See what Coplan detects from the repository's scripts:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/coplan" init --print
   ```

   If the path comes out empty (not every agent fills it in), use
   `${CURSOR_PLUGIN_ROOT}` in Cursor; failing that, the plugin's folder is
   the one that holds this command's `commands/` folder, and `bin/coplan` is
   in it. Use the same path below.

2. Check it against how the project is really verified: the CI workflows
   (`.github/workflows`, `.gitlab-ci.yml`, …), `package.json` scripts, a
   Makefile, CONTRIBUTING and README. Put each command in the stage it
   belongs to:
   - `implement` — fast checks run after every implementation or refinement
     pass: typecheck, lint, format. Seconds, not minutes.
   - `review` — the gate a task must pass before it is done: the tests, and
     anything CI would fail on for that change.
   - `final` — once every task is done: the full suite, the build, anything
     slow or repository-wide (generated files up to date, audits).

   Make every check targeted: the build runs a check only when the change
   touches its area, so give each one its area — `paths` (e.g. `["*.py"]`,
   `["packages/api/"]`), or `cwd` for a package's own checks — and where
   the tool takes files, pass only the changed ones with `{files}`
   (`ruff check {files}`, `eslint {files}`). Leave a check whole only if
   it really depends on anything in the repository. Give slow hooks a
   `timeout` (seconds), and mark advisory ones `"optional": true`. Set
   `branches.base` to the branch work merges into.

3. If `.coplan/config.json` already exists, show the user how yours differs
   and ask before replacing it. Otherwise write it (it allows `//` comments),
   then run `"${CLAUDE_PLUGIN_ROOT}/bin/coplan" check implement --all --list`
   to confirm it reads back, and tell the user in a few lines what each stage
   runs. Suggest committing it so everyone's builds run the same checks.
