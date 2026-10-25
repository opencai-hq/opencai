# Chained commands for dashboard graphs ("Add graph")

## Context
Today a dashboard graph is exactly **one** read-only CLI command → JMESPath `rowsPath` → rows → an AI-written HTML page (`backend/src/ai/dashboard/widgetAuthor.js`, `widgetRunner.js`). Many useful graphs need a drill-down: list things, then ask about each one (instances → CPU per instance → …). The Operator wants graphs built from a **chain of any number of commands**, where each later step runs **once per item** produced by the step before it, and the combined rows are drawn as a coloured, interactive page.

Colour and interactivity already exist: `pagePrompt.js` makes the AI draw with `THEME.palette`, hover tooltips, click-to-pin, legends, donuts, light/dark. No change there beyond telling the model that chained rows carry parent fields (e.g. instance name), so it labels by name, not ID.

## Behaviour (decided with the user)
- A graph has `steps` (1..N). Step 1 runs once. Every later step runs **once per row** of the previous step.
- Each step's output is turned into rows by its own `rowsPath`. Rows from a per-item step are merged with that parent row's plain fields, so ancestors' fields (name, type, region…) flow down to the final rows.
- The last step's rows feed the existing `chartSpec` unchanged → same chart types, same page.
- A single-step graph behaves exactly as today (backward compatible).

## Decisions I made (marked as my calls — check them)
- **Limits** (new constants in `backend/src/constants/dashboard.js`): `MAX_CHAIN_STEPS = 5`, `MAX_ITEMS_PER_STEP = 25` (extra items dropped, result marked `truncated`), `MAX_COMMANDS_PER_RUN = 60` total. Without caps a 3-step chain can explode to thousands of cloud API calls per refresh.
- **Per-item commands run one after another** through the existing `withUserSlot` (`runLimiter.js`). Parallel fan-out would fill the 24-entry wait queue and return 429s when a dashboard of 12 graphs refreshes together.
- **One item failing doesn't fail the graph.** It's skipped and counted (`result.skippedItems`), and the card shows "N items skipped". The graph fails only if step 1 fails or every item of a step fails.
- **Safe substitution**: later steps reference parent fields as `{{item.<field>}}`. The value is substituted only if it matches `^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,255}$` (no spaces, quotes or leading `-`, so it can't add flags). Otherwise the item is skipped. This mirrors how `period.js` only ever substitutes a validated date. Every fully rendered command still goes through `classify()` (read-only check) and is audited, like today.
- **Storage**: new nullable `steps Json?` column on `DashboardWidget`. `commandTemplate` stays and always equals step 1's command, so existing graphs, copy-command and audit keep working. `steps = null` means the old single-command path.

## Shape of a chain (what the AI writes)
```json
{"title":"Avg CPU per instance (7 days)","period":"LAST_7_DAYS",
 "steps":[
  {"command":"aws ec2 describe-instances --output json",
   "rowsPath":"Reservations[].Instances[].{id: InstanceId, name: Tags[?Key=='Name'] | [0].Value, type: InstanceType}"},
  {"command":"aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value={{item.id}} --start-time {{start}}T00:00:00Z --end-time {{end}}T00:00:00Z --period 86400 --statistics Average --output json",
   "rowsPath":"Datapoints[].{date: Timestamp, cpu: Average}"}
 ],
 "chartSpec":{"type":"line","rowsPath":"[]","x":"date","y":["cpu"],"series":"name","unit":"%"}}
```
The single-command form (`"commandTemplate": "..."`) remains accepted. For a 1-step chain the step's `rowsPath` is optional, and `chartSpec.rowsPath` then runs over the raw JSON, which is today's behaviour.

## Implementation steps

### Backend
1. **`backend/src/ai/dashboard/chain.js` (new)**: `stepsSchema` (zod: 1..`MAX_CHAIN_STEPS`, each `{command, rowsPath?}`; `rowsPath` required on every step except a lone single step); `chainProblem(steps, period)` generalising `templateProblem` from `period.js` (date-placeholder rules apply across the chain; `{{item.x}}` allowed only in steps ≥ 2; no literal dates); `renderStep(command, period, now, item)`, which reuses `resolvePeriod` and adds validated `{{item.*}}` substitution.
2. **`period.js`**: export the placeholder regex/`resolvePeriod` so `chain.js` can reuse them, and keep `templateProblem`/`renderCommand` as thin single-step wrappers (tests unchanged).
3. **`widgetRunner.js`**: split the body of `runWidget` into `runOneCommand(rendered)` (classify → audit → exec → JSON parse; the existing code moved, not rewritten). Add `runChain({steps, ...})`: step 1 → `search(json, rowsPath)` → rows (reuse `scalarFields` from `chartSpec.js`, which needs exporting). For each later step, loop over capped parent rows, render, run, extract, merge `{...parentScalars, ...childScalars}`, and enforce `MAX_COMMANDS_PER_RUN` and the existing wall-clock budget. Final rows go to `shapeRows([...rows], chartSpec)`. Return `{ok, result: {...shaped, skippedItems}, commands: [argv…]}`. `runWidget` accepts `steps` or `commandTemplate` and normalises to steps.
4. **`widgetAuthor.js`**: extend `AUTHOR_PROMPT` with the chain rules and the example above (explore step 2 with a real ID via `run_command` first; prefer a single command when one is enough). Change `draftSchema` to accept `steps` or `commandTemplate` (normalised to `steps`). Preview returns `commands` (all rendered commands, capped for display) as well as `command`.
5. **`pagePrompt.js`**: one rule line: rows may carry parent fields; label by human names (`name`) rather than IDs when present.
6. **Persistence**: Prisma migration adding `steps Json?` to `dashboard_widgets`. `dashboard.schemas.js` accepts optional `steps` (validated with `stepsSchema`). In `dashboard.service.js`, `createWidget`/`runFor`/`toWidget` pass `steps` through, and `updateWidget`'s period check uses `chainProblem`. Audit metadata includes `steps`.

### Frontend
7. **`AddWidgetDialog.jsx`**: send `draft.steps` on save. Under "Command behind this graph", show each step as a numbered block (step 2+ labelled "for each item: …") plus "ran N commands" from `preview.commands`.
8. **`WidgetCard.jsx`**: the details panel lists all steps (copy copies the whole chain, one per line). Show "N items skipped" when `lastResult.skippedItems > 0`.
9. **`dashboardApi.js`**: pass `steps` through (no shape change otherwise).

### Docs
10. Commit the design as `docs/superpowers/specs/2026-10-25-chained-graph-commands-design.md` (the content of this plan).

## Tests (node:test, beside existing files)
- `chain.test.js`: schema limits; `chainProblem` (item placeholder in step 1 rejected, literal dates rejected, NONE/period rules across steps); `renderStep` rejects unsafe item values (`a b`, `--x`, `"q"`, `$(x)`) and substitutes safe ones.
- `widgetRunner.test.js`: 2-step and 3-step chains with the fake sandbox. Parent fields are merged; item cap leads to `truncated`; a failing item is skipped and counted; a write command in step 2 is rejected and audited and never executed; `MAX_COMMANDS_PER_RUN` stops runaway chains; single `commandTemplate` path is unchanged (existing tests still pass).
- `widgetAuthor.test.js`: `parseDraft` accepts `steps` and legacy `commandTemplate`, and rejects over-long chains.
- `dashboard.service.test.js`: create/refresh with `steps`, and a period change validated across the chain.

## Verification
1. `cd backend && npm test`: all dashboard tests green.
2. `npx prisma migrate dev` applies the `steps` migration. Existing widgets still load and refresh.
3. Run the app (`run` skill). In Operator → CloudOps → Add graph, enter "average CPU per instance over the last 7 days". The preview should show 2 numbered steps and a coloured multi-line chart labelled by instance name with hover/click tooltips. Save it, refresh it, and check the audit log has one entry per executed command.
4. Ask for something that needs one command ("volumes and their sizes") and confirm it still produces a single-step graph.
