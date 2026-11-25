---
name: coplan-init
description: Set up Coplan for this repository — the checks each task runs, and your own defaults (who reviews, standing instructions)
---

Follow the `coplan-config` skill: the repository's checks in
`.coplan/config.json`, then the user's own defaults in Coplan's
`coplan.json`. If the user only asked for the checks, stop after the
checks.

Its CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/coplan"`. If the path comes out empty
(not every agent fills it in), use `${CURSOR_PLUGIN_ROOT}` in Cursor;
failing that, the plugin's folder is the one that holds this command's
`commands/` folder, and `bin/coplan` is in it.
