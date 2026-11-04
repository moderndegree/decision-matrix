# decision-matrix

Declarative security decisions that a model can inform but not unlock.

A model answers typed questions about an event (a pull request, an access grant, an alert). A first-match ruleset turns those answers, plus **facts** the host verified itself, into one action and a `gate`. The rules are deterministic and run in the caller. The model reads text an attacker may have written, so the strict presets let model answers add holds but never open the gate alone.

## Packages

| Package | Runtime | What it is |
| --- | --- | --- |
| [`decision-matrix-rules`](packages/decision-matrix-rules) | Node ≥20 | The rules engine, fact predicates, linter, trace, and policy diff. No I/O. |
| [`decision-matrix-systemone`](packages/decision-matrix-systemone) | Node ≥20 | Client and normalizer for `POST /v1/systemone`, and [the protocol](packages/decision-matrix-systemone/PROTOCOL.md). |
| [`decision-matrix-cli`](packages/decision-matrix-cli) | Node ≥20 | `decide`, `test`, `check`, and `diff`, plus the GitHub Actions gate. |
| [`decision-matrix-tui`](packages/decision-matrix-tui) | Bun | Terminal editor and test bench for a ruleset and its cases. |
| [`n8n-nodes-decision-matrix`](packages/n8n-nodes-decision-matrix) | n8n | The Decision Matrix community node, example workflows, and the local Docker stack. |

The libraries and the CLI stay on plain Node so CI runners and n8n can use them. Only the interactive editor needs Bun.

## Start

```bash
pnpm install
pnpm build
pnpm test
```

Open the CI policy in the editor:

```bash
pnpm tui --rules packages/decision-matrix-cli/examples/ci-change.rules.json \
  --cases packages/decision-matrix-cli/examples/ci-change.cases.json \
  --questions packages/decision-matrix-cli/examples/ci-change.questions.json
```

Test, lint, and diff it from the command line:

```bash
cd packages/decision-matrix-cli
node dist/cli.js test  --preset ci-change --cases examples/ci-change.cases.json --require-coverage
node dist/cli.js check --preset ci-change --strict
node dist/cli.js diff  --from old.rules.json --to examples/ci-change.rules.json --cases examples/ci-change.cases.json
```

Run n8n with the node and a scripted decision server:

```bash
docker compose up
```

## Where it fits

- **CI:** a required check on every pull request. Facts from git hold CI, install-script, and new-dependency changes without calling the model. Policy changes get tests, a lint, and a diff in the job summary. See the [CLI README](packages/decision-matrix-cli/README.md#github-actions).
- **Routine audits:** scheduled access reviews in n8n. Facts revoke, and the model can only send a grant to a person. See the [access review workflow](packages/n8n-nodes-decision-matrix/README.md#routine-access-review).
- **Monitoring:** triage alerts into page, ticket, or close. Leave containment to facts.

The [n8n package README](packages/n8n-nodes-decision-matrix/README.md#facts) documents the ruleset format and fact predicates.

## Schemas

Every file format has a JSON Schema (draft 2020-12):

| File | Schema | Checked by |
| --- | --- | --- |
| Ruleset (`*.rules.json`) | [`decision-matrix-rules/schema/ruleset.schema.json`](packages/decision-matrix-rules/schema/ruleset.schema.json) | `validateRuleset` |
| Facts (`--facts`, the node's Facts) | [`decision-matrix-rules/schema/facts.schema.json`](packages/decision-matrix-rules/schema/facts.schema.json) | `validateFacts` |
| Questions (`*.questions.json`) | [`decision-matrix-systemone/schema/questions.schema.json`](packages/decision-matrix-systemone/schema/questions.schema.json) | `validateQuestions` |
| Policy cases (`*.cases.json`) | [`decision-matrix-cli/schema/cases.schema.json`](packages/decision-matrix-cli/schema/cases.schema.json) | `readCases` |
| System One request and response | [`decision-matrix-systemone/schema/`](packages/decision-matrix-systemone/schema) | the client |

Each parser accepts exactly the documents its schema accepts. Each package's tests keep it that way. A corpus of valid and broken documents must get the same verdict from the schema and the parser. What JSON Schema cannot express is listed in each schema's `$comment` and checked only by the parser: unique rule and case names, thresholds that resolve, nesting depth, and what `open_gate_requires_facts` requires. Every shipped ruleset, question set, cases file, and n8n workflow is validated against its schema.

The schemas are published with each package (`decision-matrix-rules/schema/ruleset.schema.json`, and so on). A file may set `"$schema"` to point an editor at one, and the parsers ignore it. In this repository, `.vscode/settings.json` maps `*.rules.json`, `*.questions.json`, `*.cases.json`, and `*.facts.json` to their schemas, so VS Code checks and completes them as you type.

## Workspace

pnpm workspaces with Turborepo. `pnpm build`, `pnpm test`, and `pnpm typecheck` run each package's own script in dependency order, and repeat runs come from the cache. `pnpm check` runs all three.

`pnpm-workspace.yaml` applies the same scrutiny to this repository's own dependencies as the gate applies to yours:

- `minimumReleaseAge: 10080` installs only versions at least a week old. Most malicious releases are pulled within hours.
- `allowBuilds` blocks every dependency install script except the ones listed. Bun's is allowed for one exact version, so an upgrade needs a fresh review.

## License

MIT. See [LICENSE](LICENSE).
