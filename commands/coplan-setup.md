---
description: Build the Coplan plugin after installing or updating it
---

Coplan's build output is not in its repository, so a fresh install (or an
update) has to build it once. Install its dependencies in the plugin's own
directory — `npm install` builds it — and confirm the CLI runs:

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && npm install --include=dev && ./bin/coplan version
```

It needs Node.js 20.11 or later. If it fails, quote the failing lines and say
what they mean (a missing or old Node.js is the usual cause).

When it succeeds, tell the user in two lines that Coplan is built, and that
they should **restart Claude Code** so the plugin's MCP server and hooks start
from the build — then run `/coplan-doctor` to check the wiring.
