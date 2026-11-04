# decision-matrix-cli

Three commands:

- `decide` classifies one event and prints one action.
- `test` runs policy test cases against a ruleset, without a server.
- `check` lints a ruleset without running it.

`decide` is a local command for one event. It asks a System One server the questions, then applies a version-1 ruleset on this machine. It prints one decision. It does not open a service, and it does not scan traffic.

The decision server answers the questions. The ruleset chooses the action. Scanners, secret redaction, and authentication checks stay in the program that builds the event. Pass what that program verified with `--facts`. Rules read facts directly, and they are not sent to the server.

## Run

From the repository root, after `pnpm install` and `pnpm build`:

```bash
cd packages/decision-matrix-cli
node dist/cli.js --help
```

The examples below run from this package's directory and call the built command as `decision-matrix`. In this repository that is `node dist/cli.js`. Once the package is published, `npx decision-matrix` works anywhere.

During development, `tsx` runs the source without a build:

```bash
pnpm exec tsx src/cli.ts decide --help
```

The default preset is `attack-triage`. `--questions` and `--rules` replace either half of it. Other presets: `ci-change`, `access-review`, `generic`, `sdlc`, `support`.

`--facts facts.json` passes a JSON object of verified values to the rules. Every fact a rule references must be present, or the command exits 1 before calling the server. When the leading rules reference only facts and one matches, the command prints that decision without calling the server (no `--server` and no state needed), and `answers` is `{}`.

Offline, with a saved answer file (a System One response or a bare answers map):

```bash
decision-matrix decide \
  --answers examples/attack-triage.block.answers.json \
  --fail-on-gate
```

Against a decision server:

```bash
export DECISION_SERVER_URL=http://localhost:8000
decision-matrix decide \
  --state examples/event.json
```

`--api-key` or `DECISION_SERVER_API_KEY` sends `Authorization: Bearer` when set. `--model` or `DECISION_SERVER_MODEL` is sent only when set. `--threshold high_confidence=0.9` replaces that threshold for one run. Repeat the flag for another name.

Stdout is the decision JSON, including the answers:

```json
{
  "action": "block",
  "target": "security",
  "reason": "Hold account_takeover before any automated action",
  "gate": true,
  "matched_rule": "hold-hostile",
  "confidence": 0.93,
  "answers": {}
}
```

| Exit code | Meaning |
| --- | --- |
| 0 | A decision was printed, and `gate` is false or `--fail-on-gate` was not set. |
| 1 | The event, the rules, or the server call failed. The message is on stderr. |
| 2 | A decision was printed and `gate` is true, because `--fail-on-gate` was set. |

A shell step that must stop on a hold uses `--fail-on-gate`. A triage step reads the JSON and leaves the exit code at 0.

```bash
decision-matrix decide --answers review.json --fail-on-gate || echo held
```

The ruleset is checked before the server is called. `--answers` skips the server even if `--server` is also set.

## Attack triage

`examples/attack-triage.questions.json` and `examples/attack-triage.rules.json` are the starter policy. They match `ATTACK_TRIAGE_QUESTIONS` and `ATTACK_TRIAGE_RULES`. Copy them into the place your team reviews policy, then edit the labels.

Questions:

| Id | Type | What it asks |
| --- | --- | --- |
| `intent` | choice | `legitimate_ops`, `benign`, `account_takeover`, `social_engineering`, `supply_chain`, or `reconnaissance` |
| `risk` | score 0–3 | How much an automated action could change security, access, or data |
| `needs_human` | noul | A person should decide before any automated action |

Rules run in order. The first match wins. `high_confidence` starts at 0.85 and `high_risk` starts at 2.

| Rule | Action | Gate | When |
| --- | --- | --- | --- |
| `hold-hostile` | `block` / `security` | true | Hostile intent at or above `high_confidence` |
| `hold-uncertain` | `escalate` / `human` | true | `needs_human` at or above `high_confidence`, or `risk` at or above `high_risk` |
| `allow-legitimate` | `allow` / `automation` | false | `legitimate_ops` or `benign`, confident, and `risk` below `high_risk` |
| default | `escalate` / `human` | true | Nothing matched, including a low-confidence answer |

Proceed with automation only when `gate` is false. Store `matched_rule`, `confidence`, and `answers` with the event. Counting holds for the same account, address, or repository is the caller's next step. This command classifies one event.

The starter is a policy to edit. A model probability is not proof. A confident `allow` still depends on the facts the host put in the state.

## CI change

`ci-change` is a required check for pull requests. It is strict (`open_gate_requires_facts`): the model can add a hold, and every rule that passes also needs facts.

| Rule | Decided by | Outcome |
| --- | --- | --- |
| `hold-ci-config` | `touches_ci` | hold, security. The model is not asked. |
| `hold-package-scripts` | `changes_package_scripts` | hold, security. The model is not asked. |
| `hold-new-dependency` | `new_package_count` | hold, security. The model is not asked. |
| `hold-injection` | `content_contains_instructions` ≥ 0.5 | block, security |
| `hold-suspicious-code` | `suspicious_code` ≥ 0.3 | hold, security |
| `hold-mismatch` | the description does not match the diff, or git says docs-only and the model says behavior changed | hold, human |
| `hold-risk` | `risk` ≥ 2 | hold, human |
| `auto-merge-dependency-patch` | a dependency bot (per GitHub), a patch update, the full diff seen, plus a clean model read | auto_merge |
| `pass-docs` | `docs_only`, the full diff seen, plus `risk` 0 | pass |
| `pass-small-change` | outside sensitive and dependency paths, ≤ 20 files, the full diff seen, plus a clean model read | pass |
| default | | hold, human |

`pass` turns the check green. Branch protection still asks for a human review. Only `auto_merge` merges without one.

The thresholds are low on purpose. A 0.5 chance that the PR text is addressing the reviewer is enough to hold.

## GitHub Actions

[`examples/github/decision-gate.yml`](examples/github/decision-gate.yml) and [`examples/github/collect-facts.mjs`](examples/github/collect-facts.mjs) are a working required check.

1. Copy `decision-gate.yml` to `.github/workflows/`.
2. Copy `collect-facts.mjs`, `ci-change.rules.json`, `ci-change.questions.json`, and `ci-change.cases.json` to `.github/decision-matrix/`. Edit the rules there. They are reviewed like code.
3. Set the repository variable `DECISION_SERVER_URL` and the secret `DECISION_SERVER_API_KEY`.
4. Make the `gate` job a required status check.
5. Copy [`examples/github/policy-tests.yml`](examples/github/policy-tests.yml) to `.github/workflows/` too. It runs `check --strict` and `test --require-coverage` on every PR that edits the policy. It calls no server and needs no secrets.

How it stays trustworthy:

- **The PR cannot change its own gate.** The job runs on `pull_request_target` from the base branch, so the workflow, the collector, and the rules come from the base branch. A PR that edits any of them is held by `touches_ci`.
- **No PR code runs.** The job fetches the PR commits and reads them with `git show` and `git diff --no-ext-diff --no-textconv`. It never checks them out or installs them.
- **Facts come from git and GitHub, not from the PR text.** Changed paths, `package.json` dependency and script diffs, the author's login and account type, and whether the PR is from a fork. A user named `dependabot[bot]` whose account type is not `Bot` is not treated as the bot.
- **PR text reaches the model only as labeled, untrusted state,** cut at `MAX_DIFF_CHARS`. When the diff is truncated, `diff_truncated` is true and no pass rule can match.
- **Event fields reach scripts through `env`,** never through `${{ }}` inside `run:`.
- **Write permission exists only in the `auto-merge` job,** which runs only for `auto_merge`.
- **Only exit 0 merges.** Exit 1 (the gate failed) fails the check, like exit 2 (held).

Before you rely on it, pin the actions to commit SHAs and pin or vendor the CLI. Edit `SENSITIVE_PATHS` and the patterns at the top of `collect-facts.mjs` for your repository.

Try the collector locally against two commits:

```bash
GITHUB_EVENT_PATH=event.json BASE_SHA=<base> HEAD_SHA=<head> OUT_DIR=out \
  node examples/github/collect-facts.mjs
decision-matrix decide --preset ci-change --facts out/facts.json --state out/state.json --fail-on-gate
```

## Policy tests

A cases file says what the policy must decide. Each case gives facts and saved answers and an expectation. `defaults` holds what most cases share, so a case lists only what differs.

```json
{
  "version": 1,
  "defaults": {
    "facts": { "touches_ci": false, "docs_only": false },
    "answers": { "content_contains_instructions": { "type": "noul", "noul": 0.02 } }
  },
  "cases": [
    {
      "name": "text addressing the reviewer is blocked",
      "answers": { "content_contains_instructions": { "type": "noul", "noul": 0.8 } },
      "expect": { "matched_rule": "hold-injection", "gate": true }
    }
  ]
}
```

The format is [`schema/cases.schema.json`](schema/cases.schema.json), and `readCases` accepts exactly what it accepts. Facts merge over the defaults, including nested objects. Answers replace default answers by question id, and thresholds replace default thresholds by name. Answers accept the same dialects as `--answers`.

`expect` takes any of `matched_rule` (null means the default action), `action`, `target`, `reason`, `gate`, `from_facts` (true when the leading facts-only rules must decide without the server), and `error` (a substring of the error the case must raise, for example a missing fact).

```bash
decision-matrix test --preset ci-change --cases examples/ci-change.cases.json --require-coverage
```

A failing case prints each rule up to the one that won, with the value it saw and the check that failed:

```text
  ✗ text addressing the reviewer is blocked even when every other answer passes
      matched_rule: expected "hold-injection", got "pass-small-change"
      why:
        hold-injection               no     content_contains_instructions is 0.8, needs gte injection (0.9)
        ...
        pass-small-change            match
```

`--require-coverage` also fails when no case matches some rule. `--json` prints the results for other tools. `examples/ci-change.cases.json` and `examples/access-review.cases.json` cover every rule of their presets.

## Check

```bash
decision-matrix check --rules policy.json --questions questions.json --strict
```

| Code | Severity | Meaning |
| --- | --- | --- |
| `invalid` | error | The ruleset does not validate. |
| `unknown-threshold` | error | A referenced threshold is not defined. |
| `unknown-question` | error | A rule reads a question the question set does not ask. |
| `operator-type` | error | The operator does not fit the question's type, for example `eq` on a noul. |
| `unknown-label` | error | A choice label the question does not offer. Labels are case-sensitive, so the rule never matches. |
| `model-opens-gate` | warning | A rule with gate false needs no fact, so model answers alone open it. |
| `default-opens-gate` | warning | No match proceeds. |
| `shadowed` | warning | An earlier rule matches whenever this one would, so this one never wins. |
| `out-of-range` | warning | A comparison outside a score's levels or a probability's 0–1. |
| `fact-rule-after-model-rule` | info | A facts-only rule comes after a rule that asks the model, so it cannot skip the server. |
| `unused-question` | info | Asked on every call, read by no rule. |
| `unused-threshold` | info | Defined, used by no rule. |

The question checks run when `--questions` is given, or with `--preset`. The `shadowed` check is conservative. It can miss a dead rule, but it does not call a live rule dead.

## Diff

```bash
decision-matrix diff --from main.rules.json --to edited.rules.json --cases examples/ci-change.cases.json
```

`diff` reports what a ruleset change does, not which lines moved. Each change is one of:

- **Loosens:** a rule holds less often or opens the gate more often, a hold rule was removed, a gate flipped to false, or a gate-opening rule moved ahead of a hold.
- **Tightens:** the reverse.
- **Needs review:** a condition changed and neither direction could be proven.
- **Other:** renames, reasons, targets, and moves that do not change which side wins.

Threshold changes are judged through every rule that uses them. Raising `injection` from 0.5 to 0.9 is reported as "`hold-injection` matches fewer events after a threshold change, so it holds less often". The rule language has no negation, so that direction is exact.

With `--cases`, the diff also lists each case whose decision changes, and marks a case that held before and now opens the gate. `--format markdown` writes a PR comment. `--fail-on-loosen` exits 2 when anything loosens, needs review, or a case newly opens the gate. `policy-tests.yml` posts the diff to the job summary of every policy PR.

## Access review

`access-review` evaluates one grant per run for a scheduled audit. Revocation comes only from facts (`principal.active` false, or privileged access unused for 90 days). The model reads the justification, which the grantee wrote, and can only send the grant to a reviewer. `keep` needs an owner approval, use in the last 30 days, a review in the last year, and the model's agreement. The n8n version is `examples/audit-access-review.workflow.json` in the repository root.
