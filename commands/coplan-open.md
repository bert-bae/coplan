---
description: Open this session's plan in the Coplan UI
---

Run the Coplan CLI to open this session's plan in a browser, then tell the user the URL in one line:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/coplan" open
```

If it reports that the daemon is not running, run `"${CLAUDE_PLUGIN_ROOT}/bin/coplan" start` first.
Do not explain Coplan or list its features unless asked.
