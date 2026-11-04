---
description: Verify the Coplan plugin wiring against the installed Claude Code version
---

Run the Coplan self-test and report the result:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/coplan" doctor
```

This replays real hook payloads against a live daemon and checks the planning
round trip: a published plan is stored with its task tree, edits from the
browser are accepted, the next chat message notes that the plan changed,
`harness_plan_read` reports those edits, a question Claude asks is noticed and
cleared once answered, and no hook ever holds a turn.

Summarise: say whether it passed, and for any failure quote the failing line and
say what it means. A failure in "the Stop hook never holds a turn" would affect
every project and is worth flagging loudly. A failure in the `present:` checks
usually just means `npm run build` has not been run.
