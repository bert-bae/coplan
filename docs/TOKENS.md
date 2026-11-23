# Token budget

What Coplan puts into an agent's context, measured with
`node scripts/measure-tokens.mjs` (after `pnpm build`). It replays the demo
sessions (`scripts/demo/seed.mjs`) against a daemon of its own and records the
text each hook and tool reply hands the model. Tokens are characters ÷ 4:
compare runs, not absolute numbers.

Baseline: v0.3.0, before the token work.

## Fixed cost

| What | When it loads | Tokens |
| --- | --- | ---: |
| Skill + command descriptions (8) | every session | ~490 |
| MCP tool definitions (11) | every session where tools are not deferred (Codex, Cursor; Claude Code when tool search is off) | **9,509** |
| `coplan` skill body | planning | 5,189 |
| `coplan-build` + `iric` skill bodies | building | 3,770 |

The tool definitions are the largest fixed cost: `harness_plan_publish`
(2,453), `harness_plan_edit` (1,971), `harness_plan_propose` (1,958) and
`harness_tasks_publish` (1,424) each carry their own copy of the
node/edge/task schemas.

## Per-call cost (demo sessions)

| Reply | Avg | Max |
| --- | ---: | ---: |
| `harness_plan_read` (full plan) | 1,240 | 2,259 |
| `harness_plan_read {changes_only}` | 152 | 152 |
| "design confirmed" prompt (UserPromptSubmit) | 1,877 | 1,877 |
| `harness_plan_publish` | 872 | 1,557 |
| build prompt (UserPromptSubmit "go") | 1,393 | 1,462 |
| `harness_task_brief` | 1,017 | 1,093 |
| `harness_tasks_publish` | 700 | 1,017 |
| `harness_task_next` | 325 | 325 |
| `harness_task_update` | 28 | 58 |

`harness_task_update`, `harness_branch_update`, `harness_plan_edit` and
the hooks other than UserPromptSubmit are already cheap (under 60).

## One plan end to end (orders-service, 4 tasks / 10 subtasks)

The main agent reads **~11.7k tokens** of Coplan replies from publish to the
start of the build, and **~10k of it is the same plan, sent five times**:

| Step | Tokens | Content |
| --- | ---: | --- |
| `harness_plan_publish` | 1,557 | the whole plan it just wrote, echoed back |
| `harness_plan_read` | 1,412 | the whole plan |
| design confirmed prompt | 1,877 | instructions + the whole plan again |
| `harness_plan_read` | 1,511 | the whole plan |
| `harness_tasks_publish` + read | ~2,500 | the whole plan with tasks |
| build prompt | 1,462 | instructions + task tree, then "call `harness_plan_read`" |
| `harness_plan_read` | 2,169 | the whole plan, again |

Each revision round the user asks for adds another full read: 1.2–2.3k, where
`changes_only` would be ~150. No skill mentions `changes_only`.

The build runs about 4–5 `harness_task_update` calls per task (~28 tokens
each) and one brief (~1k) per task. The briefs are self-contained, so a
subagent needs nothing else from Coplan.

## What to cut, largest first

1. **Don't echo the plan back.** `harness_plan_publish` and
   `harness_tasks_publish` should answer with the URL, the revision and the
   gaps, not the full plan the agent just sent. ~1–1.5k per publish.
2. **Don't send the full plan when it's already in context.** The
   "design confirmed" prompt quotes the locked plan in full. The build prompt
   then tells the agent to read the whole plan again. With briefs, the main
   agent doesn't need the architecture at build time at all. ~2–4k per plan.
3. **Read changes only after the first read.** The `coplan` skill should use
   `harness_plan_read {changes_only: true}` once the agent has read the plan.
   ~1–2k per revision round.
4. **One subagent per task, even at `parallel: 1`.** The main agent keeps only
   task status. Without this, every file read for an early task is still in
   context for every later one. This is the largest cost in a real build, but
   it depends on the code base, so the demo can't measure it.
5. **Shrink the tool definitions.** Share the node/edge/task schemas and trim
   descriptions that repeat the skills. Possibly ~3–4k of the 9.5k, wherever
   tools load up front.
6. **Don't repeat instructions three times.** The build prompt restates
   `coplan-build`, and each brief restates `iric`. Keep the brief's cycle
   (subagents get only the brief) and shorten the build prompt to settings and
   checks, pointing at the skills.
7. **Load headless and setup text only when needed.** Move those sections of
   the `coplan` skill into reference files. ~1k per planning session.

Model routing (which model plans, implements and reviews) changes the cost
per token, not the count. It's covered by `models` in the config work, not
here.
