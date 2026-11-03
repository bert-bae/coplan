---
description: Open this session's plan in the harness UI
---

Run the harness CLI to open this session's plan in a browser, then tell the user the URL in one line:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/harness" open
```

If it reports that the daemon is not running, run `"${CLAUDE_PLUGIN_ROOT}/bin/harness" start` first.
Do not explain the harness or list its features unless asked.
