---
name: coplan-restart
description: Restart the Coplan daemon so a rebuilt plugin takes effect
---

Restart the daemon, then tell the user in one line that it is back and on which
address:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/coplan" restart
```

If the path comes out empty (not every agent fills it in), use
`${CURSOR_PLUGIN_ROOT}` in Cursor; failing that, the plugin's folder is the
one that holds this command's `commands/` folder, and `bin/coplan` is in it.

The daemon hands its port and token to its replacement, so any browser tab
already open on the UI reconnects by itself — say so rather than handing the
user a new link.

If the user has just changed Coplan's own source, run `pnpm build` in
the plugin directory first; the daemon starts from `dist/`, so a restart
without a build picks up nothing.
