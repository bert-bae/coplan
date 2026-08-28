---
description: Open the harness review UI for this session in a browser
---

Run the harness CLI to open this session's UI, then tell the user the URL in one line:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/harness" open
```

If it reports that the daemon is not running, run `"${CLAUDE_PLUGIN_ROOT}/bin/harness" start` first.
Do not explain the harness or list its features unless asked.
