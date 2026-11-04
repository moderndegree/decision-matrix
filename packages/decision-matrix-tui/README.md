# decision-matrix-tui

A terminal editor and test bench for a decision-matrix ruleset and its policy cases. Every edit re-runs the linter and every case, and every save first shows what the change does to the policy.

It runs on [Bun](https://bun.sh) with [OpenTUI](https://github.com/anomalyco/opentui). The rules engine and the CLI it builds on stay on Node, so nothing that evaluates rules needs Bun.

## Run

From the repository root, after `pnpm install` and `pnpm build`:

```bash
pnpm tui --rules packages/decision-matrix-cli/examples/ci-change.rules.json \
  --cases packages/decision-matrix-cli/examples/ci-change.cases.json \
  --questions packages/decision-matrix-cli/examples/ci-change.questions.json
```

`pnpm tui` runs `bun src/main.tsx` in this package with the Bun version pinned in the lockfile, so Bun does not need to be installed separately. Paths are relative to the directory you run it from.

| Option | Purpose |
| --- | --- |
| `--rules <file>` | The ruleset to edit. Required. Saved in place. |
| `--cases <file>` | Policy cases. Every edit re-runs them. A path that does not exist starts a new cases file. |
| `--questions <file>` | The questions the rules read. `Q` edits them, and they fill the pickers and the lint. A path that does not exist starts a new questions file. |

`ctrl+s` writes only the files that changed.

## The screen

```text
┌─ Rules ─────────────────────────────┐┌─ hold-injection ───────────────────────────┐
│  1 ● hold-ci-config facts 1✓        ││ → block · security · holds                  │
│  4 ● hold-injection 2✓              ││ when   (checked against "text addressing…") │
│ 10 ○ pass-small-change 1✓           ││   ✓ all of                                  │
│    ● default → hold · human 4✓      ││     ✓ content_contains_instructions gte …   │
└─────────────────────────────────────┘└─────────────────────────────────────────────┘
┌─ Thresholds ──┐┌─ Cases 16/16 ────────────────┐┌─ text addressing the reviewer … ──┐
│ injection 0.5 ││ ✓ a workflow change is held  ││ block via hold-injection · gate …  │
│ max_files 20  ││ ✗ text addressing …          ││ * content_contains_instructions 0.8│
└───────────────┘└──────────────────────────────┘└────────────────────────────────────┘
 unsaved (loosens 1, tightens 0) · lint 0 errors 0 warnings · cases 14/16
```

- **Rules:** `●` holds and `○` opens the gate. The last row is the default action, the one that applies when no rule matches. The title says `strict` when `open_gate_requires_facts` is on. `facts` means the rule decides without the model. `⚠` marks a lint warning. `N✓` is how many cases the rule decides.
- **The selected rule:** its condition is checked against the selected case, with the value each predicate saw.
- **Cases:** pass or fail, live. The first row is the shared `defaults` that every case starts from.
- **The selected case:** its decision, then its answers and facts. `*` marks values the case sets itself. Unmarked values come from the cases file's `defaults`.
- **Status:** unsaved changes and whether they loosen or tighten the policy, the lint summary, and the case count.

## Keys

| Pane | Keys |
| --- | --- |
| Everywhere | `tab` / `shift+tab` move between panes · `Q` questions · `S` strict on or off · `ctrl+s` save · `?` help · `q` quit · `ctrl+c` quit now |
| Rules | `↑↓` select · `shift+↑↓` move · `g` toggle the gate · `e` edit · `E` edit as JSON in `$EDITOR` · `n` new · `x` delete |
| The default action | `e` edit · `g` toggle the gate |
| Thresholds | `↑↓` select · `←→` adjust · `enter` type a value · `n` new · `r` rename · `x` delete |
| Cases | `↑↓` select · `n` new · `a` copy · `r` rename · `e` expectations · `u` accept the current decision · `x` delete |
| Case values | `↑↓` select · `←→` or `space` change · `enter` type a value (JSON, or plain text) · `n` add a fact or answer · `x` remove |

**Strict.** `S` turns `open_gate_requires_facts` on, which fails with the reason if a rule or the default breaks it. Turning it off asks first, and the diff counts it as a loosening.

**Thresholds.** `r` renames a threshold everywhere: the thresholds block, every condition that names it (as `"name"`, `{{thresholds.name}}`, or `{"threshold": "name"}`), every `{{thresholds.name}}` in a target or reason, and every case override. `x` deletes a threshold only when no rule uses it, and says which rules do.

**Cases.** Select the `defaults` row to edit what every case shares. On a case, a value marked `*` is the case's own override. `x` removes it and the default applies again. A value without `*` comes from the defaults, so change it on the defaults row. `n` adds a fact at any dotted path, or an answer to any question. `e` lists every expectation (`matched_rule`, `action`, `target`, `reason`, `gate`, `from_facts`, `error`). Choose one to set it or mark it "not checked", then press escape when done. A new case starts from the defaults and expects what the rules decide for it now.

## Editing questions

`Q` opens the questions screen: the questions on the left with how many rules read each, and the selected question on the right.

| Row | Keys |
| --- | --- |
| A question in the list | `enter` or `tab` edit · `n` new · `r` rename · `x` delete |
| id | `enter` rename |
| type | `←→` choice, noul, score |
| instructions | `enter` edit what the model is asked |
| A choice label | `enter` describe · `r` rename · `x` delete |
| A score level | `enter` edit · `shift+↑↓` move · `x` delete |

Renames carry through. A question id is renamed in every rule, every `{{answers.<id>.…}}` template, and every saved answer in the cases. A choice label is renamed in every rule comparison and every saved choice. Deleting a question or a label that a rule reads is refused, naming the rules.

Changing a type keeps what carries over (choice labels become score levels and back). A rule that no longer fits shows as a lint error at the bottom of the screen instead of being refused, so you can fix the rule next. Moving or removing a score level changes what each score number means, and the message says so.

Every edit is checked against the same rules as `questions.schema.json`, so a saved questions file is always valid.

## Editing a rule

`e` opens the selected rule as a form. `n` adds a rule that holds and opens it in the same form. Cancelling a new rule removes it again.

```text
┌─ Edit rule hold-mismatch ─────────────────────┐┌─ Preview ──────────────────────────────┐
│ Rule                                          ││ Holds: hold → human                    │
│   id           hold-mismatch                  ││ when                                   │
│ Action                                        ││   any of these is true:                │
│   type         hold                           ││     • description_matches_diff is less │
│   target       human                          ││       than 0.5                         │
│   gate         ● holds                        ││     all of these are true:             │
│ When                                          ││       • the fact docs_only is true     │
│   ANY of these                                ││       • changes_runtime_behavior is at │
│     question description_matches_diff (noul)  ││         least 0.5                      │
│       is less than  0.5                       ││                                        │
│       + add a comparison                      ││ ✓ Valid                                │
│     ALL of these                              ││ No change to the policy yet.           │
│       fact docs_only                          ││                                        │
│         is  true                              ││                                        │
└───────────────────────────────────────────────┘└────────────────────────────────────────┘
```

The left side is the rule as rows. The bottom line always says what the selected row's keys do.

| Row | Keys |
| --- | --- |
| id, description, type, target, reason | `enter` edit · on type, `←→` cycles the types the policy already uses |
| gate | `space` or `←→` toggles between holding and opening the gate |
| ALL of these / ANY of these | `space` or `←→` switches all and any · `a` add a condition · `g` add a group · `w` wrap in a group · `x` delete · `shift+↑↓` move |
| question / fact | `enter` choose what to check · `a` `g` `w` `x` `shift+↑↓` as for groups |
| a comparison | `←→` change it (is at least, is less than, is one of…) · `enter` choose the value · `x` remove |
| + add … | `enter` adds one |

The pickers list only what fits:

- **What to check:** the questions from `--questions` (with their types) and every fact the rules and cases use. You can also type a new fact path or question id.
- **Comparisons:** only the ones that make sense for the subject. A probability gets "is at least" and "is less than", a choice question gets "is" and "is one of", and a fact gets those plus "includes".
- **Values:** thresholds that fit the range (a probability is offered `injection (0.5)`, not `max_files (20)`), a question's own choice labels, or `true`, `false`, and `null` for a fact. A number or text can always be typed.

Switching a condition from a question to a fact starts it with a comparison that fits the fact. The cases show what kind of value the fact holds, so a true/false fact starts as "is", and a count starts as "is at least".

The right side reads the rule back in plain words, then says whether it is valid, shows lint warnings for it, and lists what applying it would do: which rules loosen or tighten, and which cases change their decision. `ctrl+s` applies the rule to the policy only when it is valid, and a strict policy (`open_gate_requires_facts`) refuses a rule the model alone could open. Saving to disk is still `ctrl+s` on the main screen. `esc` cancels and asks first if anything changed.

`E` opens the rule as JSON in `$VISUAL`, then `$EDITOR`, then `vi`, for anything the form does not cover. The same validation applies.

`u` and `a` make a case expect what the rules decide now. Use them after you have checked that the new decision is the one you want.

## Safety

- Every edit is validated before it applies: the ruleset, the cases, and the questions each against the same checks as their JSON Schemas. An edit that would break one is refused with the reason, and the previous version stays.
- `ctrl+s` shows the same report as `decision-matrix diff`, including the cases whose decision changes. A change that loosens the policy says so in the title.
- Saves write a temporary file next to the target and rename it into place, so a crash cannot leave a half-written policy.
- The rule handed to `$EDITOR` goes in a private temporary directory, and the editor runs with no shell.
- The TUI reads and writes only the files you name. It makes no network calls.

## Standalone executable

```bash
pnpm --filter decision-matrix-tui compile                       # this machine
pnpm --filter decision-matrix-tui compile -- bun-linux-x64-musl # another target
```

This writes `dist/decision-matrix-tui-<target>` and a `.sha256` file next to it. The executable embeds Bun and OpenTUI's native library, so users need neither. Expect about 120 MB. Build each target on a machine that has its OpenTUI native package installed.

## Tests

`pnpm test` from the root runs `bun test` here with the rest of the workspace. The model tests cover every edit, in the main screen and in the rule form. The app tests drive both with keys through OpenTUI's test renderer.
