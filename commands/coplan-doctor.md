---
name: coplan-doctor
description: Verify the Coplan plugin wiring against the running daemon
---

Run the Coplan self-test and report the result:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/coplan" doctor
```

If the path comes out empty (not every agent fills it in), use
`${CURSOR_PLUGIN_ROOT}` in Cursor; failing that, the plugin's folder is the
one that holds this command's `commands/` folder, and `bin/coplan` is in it.

This checks what the hooks need from the machine (Node 20.11+ on the PATH,
curl), reads both Coplan configs and the repository's `.coplan/config.json`
and lists anything wrong in them, and checks that the running daemon is the
one its lock names and the same version as the plugin. Then it sends one hook
through the real relay script, as an agent does, and replays real hook
payloads against the daemon to check the planning round trip: a published plan
is stored with its task tree, edits from the browser are accepted, the next
chat message notes that the plan changed, `harness_plan_read` reports those
edits, a question the agent asks is noticed and cleared once answered, and no
hook ever holds a turn. The sessions it makes are deleted afterwards.

Summarise: say whether it passed, and for any failure quote the failing line and
say what it means. A failure in "the Stop hook never holds a turn" would affect
every project and is worth flagging loudly. A failure in the `present:` checks
usually just means Coplan has not been built: run `/coplan-setup`. A version
or pid mismatch means an old daemon is still running: run `/coplan-restart`.
Lines marked `!` are warnings (a config value that is ignored, say); `✗` fails.
