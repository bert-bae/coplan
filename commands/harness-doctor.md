---
description: Verify the cc-harness plugin wiring against the installed Claude Code version
---

Run the harness self-test and report the result:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/harness" doctor
```

This replays real hook payloads against a live daemon and asserts the observable behaviour —
session registration, todo capture, gate parking, `Stop`-hook feedback injection, and that
sessions with no open gate are never held up.

Summarise: say whether it passed, and for any failure quote the failing line and say what it
means. A failure in "Stop hook parks on the gate" or "the block carries the user feedback"
means the CLI's hook contract has changed and the gate loop is broken — that is worth flagging
loudly. A failure in the `present:` checks usually just means `npm run build` has not been run.
