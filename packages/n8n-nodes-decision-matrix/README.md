# n8n-nodes-decision-matrix

An n8n community node that runs a declarative decision matrix. Questions can be answered by a local script, or by any server speaking the System One `/v1/systemone` protocol. That includes Lev, Jev, OpenJev, and other compatible implementations. The node does not hard-code a vendor.

You send a state and typed questions. Each answer is a choice, a noul (yes-probability), or a score. A first-match ruleset turns those answers, plus any **facts** the workflow verified itself, into one routing action: `action`, `target`, `reason`, `gate`, `matched_rule`, and `confidence`.

Security decisions are one use. For those, read [Facts](#facts) first. A model reads text an attacker may have written, so the rules can require a verified fact before anything opens the gate. A ticket queue or a commit tag usually does not need a model. See [Scripts](#scripts).

## Minimal working example

Use any host that accepts `POST /v1/systemone`. The node does not pick a vendor or a model.

1. Create a **Decision Server API** credential.
   - **Base URL:** `https://decisions.example.com` (replace this with your server; a path prefix is kept).
   - **API Key:** leave empty when that server does not check a token. Otherwise paste the bearer token. The node sends `Authorization: Bearer` only when this field is set.
2. Add a **Decision Matrix** node. **Questions** below replaces the question-set preset. **Rules** is the whole policy. You do not add IF or Switch nodes to express that policy. A later Switch only fans out the action this node already chose.
3. Leave **Options → Model** empty unless that server rejects a body that has no `model` field. The request body is `{ "state", "questions" }`.

**State** (expression or text):

```text
={{ $json.body }}
```

**Questions:**

```json
{
  "task_type": {
    "type": "choice",
    "instructions": "What kind of work is this",
    "criteria": {
      "bugfix": "Correct broken behavior",
      "feature": "New behavior",
      "chore": "Tooling or maintenance"
    }
  },
  "is_urgent": {
    "type": "noul",
    "instructions": "This needs attention before other work"
  },
  "risk": {
    "type": "score",
    "instructions": "How risky is it to act automatically",
    "criteria": ["Trivial", "Limited", "Shared or hard to reverse"]
  }
}
```

**Rules** (first match wins; `high_confidence` and `max_risk` are thresholds):

```json
{
  "version": 1,
  "default_action": { "type": "escalate", "target": "human", "reason": "No matching rule" },
  "thresholds": { "high_confidence": 0.85, "max_risk": 2 },
  "rules": [
    {
      "id": "ship-bugfix",
      "when": {
        "all": [
          {
            "any": [
              { "question": "task_type", "eq": "bugfix" },
              { "question": "task_type", "in": ["bugfix", "chore"] }
            ]
          },
          { "question": "task_type", "confidence_gte": "high_confidence" },
          { "question": "is_urgent", "gte": "high_confidence" },
          { "question": "risk", "lt": "max_risk" }
        ]
      },
      "action": {
        "type": "route",
        "target": "{{answers.task_type.choice}}",
        "reason": "Ship {{answers.task_type.choice}} below risk {{thresholds.max_risk}}",
        "gate": false
      }
    },
    {
      "id": "review-feature",
      "when": {
        "all": [
          { "question": "task_type", "eq": "feature", "confidence_gte": "high_confidence" },
          { "question": "risk", "gte": "max_risk" }
        ]
      },
      "action": {
        "type": "review",
        "target": "design",
        "reason": "Feature {{answers.task_type.choice}} needs review",
        "gate": true
      }
    }
  ]
}
```

The node calls `POST https://decisions.example.com/v1/systemone`. When the first rule matches, the item looks like this (`answers` is the server map; turn it off with **Include Full Answers**):

```json
{
  "action": "route",
  "target": "bugfix",
  "reason": "Ship bugfix below risk 2",
  "gate": false,
  "matched_rule": "ship-bugfix",
  "confidence": 0.8,
  "answers": {}
}
```

If neither rule matches, the item is the default action with `matched_rule: null`. The node's **Thresholds** collection can replace `high_confidence` or `max_risk` for one item without editing the rules JSON.

## Install

Requirements: Node.js 20.19 or newer, and a self-hosted n8n.

### From npm (after the package is published)

In n8n: **Settings → Community nodes → Install**, then enter:

```text
n8n-nodes-decision-matrix
```

Restart n8n if it does not pick the node up immediately. The node appears as **Decision Matrix**. The credential type is **Decision Server API**.

Manual install, including queue mode:

```bash
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install n8n-nodes-decision-matrix
```

Restart n8n.

### From this repository

This package lives in a pnpm workspace. From the repository root:

```bash
pnpm install
pnpm build
pnpm test
```

The build bundles this node and the two libraries it uses into `packages/n8n-nodes-decision-matrix/dist/`, and copies the icon and codex file. n8n loads the paths listed under the `n8n` key in `package.json`.

Install the built package into n8n:

```bash
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install /absolute/path/to/repo/packages/n8n-nodes-decision-matrix
```

Restart n8n.

You need a decision server of your choice running separately. This package does not start one.

### Docker

`docker compose up` starts n8n 2.46.3 with this package loaded, and a scripted stand-in for `POST /v1/systemone` so the node and the example workflows can run. Run it from the repository root.

```bash
pnpm install
pnpm build
docker compose up
```

Open http://localhost:5678 and sign in as `dev@example.com` / `Decision1`. That password is for this local stack. Open **Why the decision matrix** for one ruleset and a threshold change. Open **SDLC with a feedback loop** and click **Execute workflow**. That starts from **Change opened**, whose four pinned changes move through triage, design, release, and production. The trigger menu also runs **Walk the lifecycle** (the same four), the hourly poll, and a pinned deploy alert.

Create a **Decision Server API** credential with Base URL `http://systemone:8000` and an empty API key if one is not already there. n8n reaches the stand-in by that compose service name. From the host machine the same stand-in is http://localhost:8000.

The stand-in reads the state text and returns a scripted answer profile for the phrases used in those workflows (an outage, a migration, a design sign-off, an error spike, a narrow degradation, a healthy or recovered signal, an unsure bug report, a README typo, a vague request, and the phrases in the attack-gate examples). Other text still gets a fixed bugfix-shaped answer, so the smaller examples and the credential test keep working. The profile is a stand-in for a real server. The rules are what decide.

**SDLC with a feedback loop** is inactive. Activate it to arm the hourly **Error-budget poll**, `POST /webhook/sdlc-intake`, and `POST /webhook/sdlc-monitor`. Editor runs use the pinned data on those triggers and finish while the workflow is inactive. A live POST uses the request body.

The container copies `dist/` into n8n on each start. After `pnpm build`, run `docker compose restart n8n` to load the new build. The build empties `dist/` instead of deleting it, so the container's bind mount stays attached and the restart works. Workflow data stays in the `n8n_data` volume.

## Credentials

Create a credential of type **Decision Server API**.

| Field | Required | Purpose |
| --- | --- | --- |
| Base URL | yes | Server root, for example `http://localhost:8000` or `https://api.example.com`. The node calls `POST {baseUrl}/v1/systemone`. A path prefix is preserved for gateways that mount the protocol under a prefix. A trailing slash is removed. |
| API Key | no | When set, every request sends an `Authorization: Bearer` header whose value is the API key. Leave it empty for a local server that does not check a token. |

All requests go through this credential. The credential's `authenticate` hook adds the bearer token only when the API key is non-empty, so an empty password field does not send a bare `Bearer` header.

**Test** sends one small noul question (`state: "connectivity check"`) and does not send a `model` field. Local servers that accept `{ state, questions }` and choose their own model should return HTTP 200. Servers that require `model` answer with a validation error. That error means the host responded. Set **Options → Model** on the node for real runs. A connection error means the Base URL is unreachable from the n8n process.

## Node parameters

| Parameter | Required | What it does |
| --- | --- | --- |
| State | yes | Text, a JSON object, or a JSON array. Expressions are supported. A string that starts with `{` or `[` is parsed as JSON. Any other string is sent as text. |
| Question Set | no | `Generic Triage` (default), `SDLC Change`, `Support / Ops`, or `Custom JSON`. |
| Questions | no | System One questions object. A non-empty object replaces the selected question set. Empty uses that preset (generic triage when the set is Custom JSON). |
| Rules | yes | Version 1 ruleset. Expressions are supported, so an earlier node can supply the JSON. The node ships with the generic triage ruleset filled in. |
| Facts | no | JSON object of values the workflow verified itself (directory, IAM, git). Fact predicates in the rules read it. It is not sent to the server. See [Facts](#facts). |
| Thresholds | no | Fixed collection of name/value rows. A row replaces the same name in `rules.thresholds` for that item. |
| Rule Rows | no | Fixed collection of flat rules. Empty keeps the Rules JSON. A non-empty collection replaces the `rules` array and keeps version, thresholds, the default action, owner, ticket, fact schema, and agreements. Each row is one `all` or `any` of unary cells. Nested groups stay in the Rules JSON. |
| Options → Timeout (ms) | no | HTTP timeout. Default 60000. |
| Options → Include Full Answers | no | Copy the server `answers` map onto the item. Default true. |
| Options → Fail on No Matching Rule | no | Throw instead of returning `default_action`. Default false. |
| Options → Include Raw Response | no | Add the response body as `raw_response`. Default false. |
| Options → Model | no | Sent as `model` only when non-empty. Leave empty when the server chooses a model. The node does not default to a vendor or a model id. |

The request body is `{ "state", "questions" }`, plus `model` when you set one.

## Question presets

Question ids are the keys your rules reference. Copy a preset into **Custom JSON** to change instructions or criteria. Question presets ship in `decision-matrix-systemone`. The paired rulesets ship in `decision-matrix-rules`.

### Generic triage (default)

`category` (choice), `urgency` (score, levels 0–3), `needs_human` (noul).

```json
{
  "category": {
    "type": "choice",
    "instructions": "Which queue should handle this",
    "criteria": {
      "billing": "Payment, invoice, refund, or subscription",
      "technical": "Bug, outage, or how-to for the product",
      "account": "Login, access, or profile",
      "other": "Does not fit the other queues"
    }
  },
  "urgency": {
    "type": "score",
    "instructions": "How time-sensitive is this",
    "criteria": [
      "Can wait days",
      "Should be handled today",
      "Needs attention within the hour",
      "Active outage or safety issue"
    ]
  },
  "needs_human": {
    "type": "noul",
    "instructions": "A person should review this before any automated action"
  }
}
```

### SDLC change

`change_type` (choice), `risk` (score, levels 0–3), `needs_design` (noul), `ready_to_implement` (noul).

```json
{
  "change_type": {
    "type": "choice",
    "instructions": "What kind of change is being requested",
    "criteria": {
      "feature": "New behavior or capability",
      "bugfix": "Correct broken behavior",
      "refactor": "Restructure without changing behavior",
      "docs": "Documentation only",
      "chore": "Tooling, dependency, or maintenance"
    }
  },
  "risk": {
    "type": "score",
    "instructions": "How risky is this change to ship",
    "criteria": [
      "Trivial and easily reversed",
      "Limited blast radius",
      "Touches shared paths or data",
      "Security, migration, or hard to reverse"
    ]
  },
  "needs_design": {
    "type": "noul",
    "instructions": "This needs a design or architecture review before implementation"
  },
  "ready_to_implement": {
    "type": "noul",
    "instructions": "The request is specific enough to implement without more clarification"
  }
}
```

### Support / ops

`severity` (choice), `customer_impact` (score, levels 0–3), `page_oncall` (noul).

```json
{
  "severity": {
    "type": "choice",
    "instructions": "Incident severity",
    "criteria": {
      "sev1": "Service down for many users",
      "sev2": "Major feature degraded",
      "sev3": "Minor impact or a workaround exists",
      "sev4": "Question or cosmetic issue"
    }
  },
  "customer_impact": {
    "type": "score",
    "instructions": "How broad the customer impact is",
    "criteria": [
      "Single user or internal",
      "A team or account",
      "Many customers",
      "All customers or data risk"
    ]
  },
  "page_oncall": {
    "type": "noul",
    "instructions": "An on-call engineer should be paged now"
  }
}
```

## Rules schema

Version 1 only. Rules are tried in array order. The first rule whose `when` tree is true wins. Later rules are not used. If none match, the node returns `default_action` with `matched_rule: null` and `confidence: 0`, unless **Fail on No Matching Rule** is on.

The engine is deterministic and has no I/O. Every branch of `all` / `any` is evaluated, so a bad question id still produces an error when an earlier branch already decided the boolean.

```json
{
  "version": 1,
  "default_action": {
    "type": "escalate",
    "target": "human",
    "reason": "No matching rule"
  },
  "thresholds": {
    "high_confidence": 0.85,
    "medium_confidence": 0.7
  },
  "rules": [
    {
      "id": "urgent-human",
      "description": "Optional. Not used in the output.",
      "when": {
        "any": [
          { "question": "needs_human", "gte": "high_confidence" },
          { "question": "urgency", "gte": 2 }
        ]
      },
      "action": {
        "type": "escalate",
        "target": "human",
        "reason": "Urgency or human review signal crossed the threshold",
        "gate": true
      }
    }
  ]
}
```

`action.type` becomes the output field `action`. `gate` defaults to false when omitted. `description` is optional.

Unknown keys are rejected with the path, for example `rules[0].when`. Threshold names start with a letter or underscore and then use letters, digits, and underscores.

### Conditions

A condition is exactly one of:

- `{ "all": [ ... ] }` — every child is true
- `{ "any": [ ... ] }` — at least one child is true
- `{ "question": "<id>", "<operator>": <operand>, ... }` — one question, one or more operators
- `{ "fact": "<path>", "<operator>": <operand>, ... }` — one verified fact. See [Facts](#facts).

`all` and `any` must be non-empty. Several operators on one predicate are AND, checked in a fixed order (identity, then confidence, then numeric). JSON key order does not matter. Do not mix choice operators (`eq`, `neq`, `in`, `not_in`) with numeric operators (`gte`, `gt`, `lte`, `lt`) on the same predicate.

| Operator | Answer type | Operand | Meaning |
| --- | --- | --- | --- |
| `eq`, `neq` | choice | choice label | Selected option equals / does not equal the label. Labels are case-sensitive and are not threshold names. |
| `in`, `not_in` | choice | non-empty array of labels | Selected option is / is not in the list. |
| `confidence_gte`, `confidence_lt` | choice or score | number or threshold | Best-effort confidence comparison. |
| `gte`, `gt`, `lte`, `lt` | noul or score | number or threshold | Compares the noul probability or the score value. |

Numeric operands accept:

- a number: `0.85` or `2`
- a numeric string: `"0.4"`
- a threshold name: `"high_confidence"`
- a template: `"{{thresholds.high_confidence}}"`
- an object: `{ "threshold": "high_confidence" }`

A threshold name wins over a numeric parse. Node **Thresholds** replace ruleset values of the same name. A referenced name that is missing from both is an error, raised before the HTTP call.

`confidence_gte` on a noul is an error. Compare the noul probability with `gte` / `gt` / `lte` / `lt`. Noul has no separate confidence field.

### Confidence

Output `confidence` is the minimum best-effort confidence of every question the matched rule references.

- Choice and score use the server's `confidence` when it is present.
- If a choice omits `confidence`, the probability of the selected label is used. A missing label does not fall back to the maximum probability.
- If a score omits `confidence`, the probability of the selected level is used. The level index itself is not limited to 0–1. A missing level does not fall back to the maximum probability.
- Noul contributes decisiveness, `abs(noul - 0.5) * 2`. A probability of 0.5 contributes 0. A probability of 0 or 1 contributes 1. That measures uncertainty, not "how yes" the answer is.
- A referenced answer with none of those signals contributes 0.
- Facts do not lower confidence. A rule that references only facts has confidence 1.
- When no rule matches, `confidence` is 0.

`confidence_gte` / `confidence_lt` use the same number. If a rule asks for confidence and the answer has neither `confidence` nor `probabilities`, evaluation throws.

### Templates

`action.target` and `action.reason` may contain:

- `{{answers.<question>.choice}}`
- `{{answers.<question>.noul}}`
- `{{answers.<question>.score}}`
- `{{answers.<question>.confidence}}`
- `{{answers.<question>.type}}`
- `{{thresholds.<name>}}`
- `{{facts.<path>}}` (a string, number, or boolean; anything else renders empty)

A known path that does not resolve becomes an empty string. Any other placeholder is left as written. If the rendered target or reason is empty, the item fails.

Question ids used in templates cannot contain `.`, because the placeholder is split on dots.

## Facts

A model answer is a judgment about text, and in a security flow someone hostile may have written that text. A **fact** is a value the workflow verified itself: the directory says the account is disabled, git says a workflow file changed, the access log says the role was last used 140 days ago. Rules read facts directly. They are not passed through the model.

Pass facts in the node's **Facts** parameter, as `evaluateRules(ruleset, answers, overrides, facts)`, or with `decision-matrix decide --facts facts.json`. Facts are never sent to the decision server. Put anything the model should read in the state.

```json
{ "all": [
  { "fact": "grant.privileged", "eq": true },
  { "fact": "grant.days_since_last_use", "gte": "stale_privileged_days" }
] }
```

| Operator | Fact must be | Operand |
| --- | --- | --- |
| `eq`, `neq` | string, number, boolean, or null | a literal of the same type, or null |
| `in`, `not_in` | string, number, boolean, or null | non-empty array of literals |
| `contains`, `not_contains` | array of scalars | a literal |
| `gte`, `gt`, `lte`, `lt` | finite number | number or threshold, as for questions |

`fact` is a dotted path through nested objects (`principal.mfa`). Only own properties are read.

**Facts fail closed.** A missing fact is an error, not false, because a false would quietly skip a deny rule. Comparing a boolean fact with `"true"` is an error for the same reason. Set an unknown value to `null` explicitly. The node and the command check every referenced fact before the server is called. `confidence_gte` and `confidence_lt` are rejected on a fact.

**Facts can decide without the model.** Rules are tried in order. While the leading rules reference only facts, the first one that matches is the decision, and the server is not called (`decideFromFacts`). `answers` is then empty. Put fact-only holds first: a CI file change or a terminated employee is decided before any untrusted text reaches a model.

**`open_gate_requires_facts: true`** makes the ruleset reject itself unless model answers can only hold:

- `default_action.gate` must be true.
- Every rule with `gate: false` must require a fact on every path through `when`: a fact under `all`, or under every branch of an `any`. A fact under `any` next to a question-only branch does not count.

The `ci-change` and `access-review` presets use it. A model answer can still add a hold, which is the useful part: it catches injected instructions, a diff that does not match its description, or a justification that does not hold up.

**Check the model against what you know.** Ask a question whose answer a fact already gives, and hold when they disagree. `ci-change` asks whether the diff changes runtime behavior. When git says the change is docs-only and the model says it is not, either a doc file is doing more than documentation or the model was steered. The `hold-mismatch` rule holds either way.

Build facts from systems of record, never from the request body. In a Code node, the facts object should come from earlier HTTP Request nodes (directory, IAM, git), not from `$json.body`.

### Generic triage rules (node default)

```json
{
  "version": 1,
  "default_action": { "type": "escalate", "target": "human", "reason": "No matching rule" },
  "thresholds": { "high_confidence": 0.85, "medium_confidence": 0.7 },
  "rules": [
    {
      "id": "urgent-human",
      "description": "High urgency or an explicit human-review signal goes to a person",
      "when": {
        "any": [
          { "question": "needs_human", "gte": "high_confidence" },
          { "question": "urgency", "gte": 2 }
        ]
      },
      "action": {
        "type": "escalate",
        "target": "human",
        "reason": "Urgency or human review signal crossed the threshold",
        "gate": true
      }
    },
    {
      "id": "route-category",
      "description": "Route to the chosen queue when the choice is confident enough",
      "when": { "all": [{ "question": "category", "confidence_gte": "medium_confidence" }] },
      "action": {
        "type": "route",
        "target": "{{answers.category.choice}}",
        "reason": "Category {{answers.category.choice}} with sufficient confidence",
        "gate": false
      }
    }
  ]
}
```

### SDLC rules

```json
{
  "version": 1,
  "default_action": { "type": "escalate", "target": "human", "reason": "No matching rule" },
  "thresholds": { "high_confidence": 0.85, "medium_confidence": 0.7, "high_risk": 2 },
  "rules": [
    {
      "id": "needs-design",
      "description": "Unclear or high-risk work goes to design review",
      "when": {
        "any": [
          { "question": "needs_design", "gte": "medium_confidence" },
          { "question": "risk", "gte": "high_risk" },
          { "question": "ready_to_implement", "lt": 0.4 }
        ]
      },
      "action": {
        "type": "review",
        "target": "design",
        "reason": "Change needs design review before implementation",
        "gate": true
      }
    },
    {
      "id": "ready-implementer",
      "description": "Specific, lower-risk work can go to an implementer",
      "when": {
        "all": [
          { "question": "ready_to_implement", "gte": "high_confidence" },
          { "question": "risk", "lt": "high_risk" },
          {
            "question": "change_type",
            "in": ["feature", "bugfix", "refactor", "docs", "chore"],
            "confidence_gte": "medium_confidence"
          }
        ]
      },
      "action": {
        "type": "route",
        "target": "implementer",
        "reason": "Ready to implement as {{answers.change_type.choice}}",
        "gate": false
      }
    }
  ]
}
```

### Support / ops rules

```json
{
  "version": 1,
  "default_action": { "type": "escalate", "target": "human", "reason": "No matching rule" },
  "thresholds": { "page_threshold": 0.8, "high_confidence": 0.85 },
  "rules": [
    {
      "id": "page-oncall",
      "description": "Page on-call for a confident high severity or a strong page signal",
      "when": {
        "any": [
          { "question": "page_oncall", "gte": "page_threshold" },
          { "question": "severity", "in": ["sev1", "sev2"], "confidence_gte": "high_confidence" }
        ]
      },
      "action": {
        "type": "page",
        "target": "oncall",
        "reason": "Severity {{answers.severity.choice}} warrants a page",
        "gate": true
      }
    },
    {
      "id": "queue-ticket",
      "description": "Queue everything else that has a confident severity",
      "when": { "all": [{ "question": "severity", "confidence_gte": "high_confidence" }] },
      "action": {
        "type": "route",
        "target": "ticket-queue",
        "reason": "Queue as {{answers.severity.choice}}",
        "gate": false
      }
    }
  ]
}
```

## Output

One item per input item:

```json
{
  "action": "route",
  "target": "billing",
  "reason": "Category billing with sufficient confidence",
  "gate": false,
  "matched_rule": "route-category",
  "confidence": 0.9,
  "answers": {},
  "usage": { "input_tokens": 120, "output_tokens": 12 }
}
```

`answers` is the server's answers map when **Include Full Answers** is on (the default). `raw_response` is present only when **Include Raw Response** is on. `usage` is present when the server reported token counts. `prompt_tokens` and `completion_tokens` are mapped to `input_tokens` and `output_tokens`.

With **Continue On Fail**, a failed item is `{ "error": "<message>" }` instead of stopping the run.

## Example workflows

Import a file with the n8n workflow menu (**Import from File**). On import, select your **Decision Server API** credential. The support and SDLC workflows are:

**Webhook → Decision Matrix → Switch on action**

The Switch compares `{{ $json.action }}` and names its outputs. An extra fallback output catches an action value the Switch does not list.

### Support / ops

File: [`examples/support-ops.workflow.json`](examples/support-ops.workflow.json)

1. Webhook `POST /webhook/decision-support` accepts a JSON body. State is `body.message`, or the whole body when `message` is absent.
2. Decision Matrix uses the **Support / Ops** question set and the support rules above.
3. Switch outputs: `page`, `route`, `escalate`.

Pinned sample body:

```json
{
  "message": "Our API integration started returning 500 errors on every request about 20 minutes ago, and we can't process any customer orders until this is fixed."
}
```

`page` goes to on-call (`gate: true`). `route` goes to `ticket-queue`. Anything else escalates to `human`.

### SDLC change

File: [`examples/sdlc-change.workflow.json`](examples/sdlc-change.workflow.json)

1. Webhook `POST /webhook/decision-sdlc`. State is `body.state`, then `body.message`, then the whole body. An object state is sent as JSON.
2. Decision Matrix uses the **SDLC Change** question set and the SDLC rules above.
3. Switch outputs: `review`, `route`, `escalate`.

Pinned sample body:

```json
{
  "title": "Add retry with jitter to the billing webhook handler",
  "body": "The handler fails the whole batch when the provider returns 429. Retry three times with jitter, and do not change the public API.",
  "paths": ["services/billing/webhook.ts"]
}
```

`review` / target `design` means design review (`gate: true`). `route` / target `implementer` means the change looks specific and lower-risk. Otherwise the item escalates to a person.

### Attack gates

Eight workflows place the same attack-triage policy at the point a caller would refuse an action. Import a file, select the **Decision Server API** credential, and run **Walk the examples** from the trigger menu. **Build state** keeps the caller's `request` apart from `facts` the caller already verified. **Attack gate** then chooses `block`, `escalate`, or `allow`. The switch's extra output joins the hold branch, so an action it does not name does not continue. If the gate errors, the workflow stops before the allow node.

The stand-in matches a phrase in `text`. A real server reads the whole state, including `facts`. The pinned `facts` are there for that server. They do not change the stand-in's scripted profile.

| File | Where it sits | What continues |
| --- | --- | --- |
| [`attack-identity.workflow.json`](examples/attack-identity.workflow.json) | Admin API, before a payout change, role grant, or MFA reset | Apply the change |
| [`attack-request.workflow.json`](examples/attack-request.workflow.json) | Ticket flow, before a payment target or an approval changes | Continue the request |
| [`attack-change.workflow.json`](examples/attack-change.workflow.json) | Required check, before merge | Merge the change |
| [`attack-infra.workflow.json`](examples/attack-infra.workflow.json) | Apply job, after plan and before apply | Apply the plan |
| [`attack-config.workflow.json`](examples/attack-config.workflow.json) | Flag service, before the value changes | Flip the flag |
| [`attack-export.workflow.json`](examples/attack-export.workflow.json) | Export handler, before the job starts | Start the export |
| [`attack-agent.workflow.json`](examples/attack-agent.workflow.json) | Tool gateway, before the call runs | Run the tool |
| [`attack-detect.workflow.json`](examples/attack-detect.workflow.json) | After a detector has raised one alert | Nothing. A block freezes the credential. |

**Repo and CI** sends only an allow to a second matrix, **Implement gate**. A docs-only change merges. A payments schema change is held for design. A workflow permission change fails the check and never reaches that gate.

**Infrastructure apply** sets this node's `high_confidence` to 0.9. Renaming a private subnet tag would allow at 0.85. At 0.9 no rule matches, and the default holds the plan. The staging description tweak is still confident enough to apply.

**Alert and containment** classifies one alert. `facts` carries counts the host already computed. A block freezes the credential. A hold pages a person and does not freeze. An allow closes the alert. `proceeded` stays false on every branch.

Webhook paths are `POST /webhook/attack-identity`, `attack-request`, `attack-change`, `attack-infra`, `attack-config`, `attack-export`, `attack-agent`, and `attack-detect`. The workflows are inactive. A live POST uses the request body.

### Routine access review

File: [`examples/audit-access-review.workflow.json`](examples/audit-access-review.workflow.json)

A monthly audit, one grant per item, using the `access-review` questions and rules. There is no webhook. **Load grants** is where your directory and IAM export goes. It returns nothing until you replace it. **Build facts and state** puts the directory, IAM, and access-log fields in `facts`, and only the role description and the grantee's justification in the state.

| Grant | Decided by | Outcome |
| --- | --- | --- |
| Terminated contractor with `prod-db-admin` | facts | Revoke |
| `aws-org-admin` unused for 140 days | facts | Revoke |
| `github-org-owner` without MFA | facts | Security reviews it |
| On-call SRE with a specific justification | facts + model | Keep |
| "Needed for work." | model | Owner reviews it |
| Justification that tells automated reviewers to keep it | model | Security reviews it |

The first three never call the decision server. Revocation comes only from facts. The model can send a grant to a person but cannot revoke or keep it on its own.

Other routine audits use the same shape: facts decide the clear cases, and the model reads the human-written part.

- **Security exceptions and risk acceptances:** facts give the expiry date, the owner, and whether the finding is still open. The model asks whether the written rationale still holds.
- **Firewall and security-group rules:** facts give `0.0.0.0/0`, the port, and the last hit. The model asks whether the rule description justifies the exposure.
- **OAuth app and API-token grants:** facts give the scopes, the publisher, and the last use. The model asks whether the stated purpose needs those scopes.
- **Secrets rotation:** facts give the age and the consumers. The model reads the exemption note when one exists.

### CI with GitHub Actions

The command, not the node, belongs in CI. A second workflow runs `decision-matrix check` and `decision-matrix test --require-coverage --require-fact-errors` on every policy change, so a PR that weakens the policy fails a test case and shows the reviewer which decision changed. `check` fails on errors. `--strict` also fails warnings, including the overlap warnings on the starter CI policy. See [`packages/decision-matrix-cli/README.md`](packages/decision-matrix-cli/README.md#github-actions) for a required check that collects facts from git and holds CI, script, and new-dependency changes before any model call.

The generic triage rules are the default already loaded on a new Decision Matrix node. Pair them with **Question Set → Generic Triage** and switch on `route` versus `escalate`. `target` for `route` is the chosen category (`billing`, `technical`, `account`, or `other`).

## Scripts

**Answer With → Scripts** runs a version 1 scripts document on the state and skips the server for every question it answers. Leave **Scripts** empty to use the built-in script for Generic Triage, SDLC Change, or Support / Ops. Those three answer every question, so the node does not need a Decision Server API credential. Paste a document when **Questions** replaces the preset.

A step has one matcher and one answer. `word` is a whole word or phrase, ASCII case-insensitive. `tag` is a leading token followed by `:` or `(`, such as `feat:` or `feat(api):`. `contains` is a substring. `equals` compares one field exactly. `else` fills a question nothing earlier answered. The first match for a question wins. The matchers, the search text, and the answer shape are specified in [`PROTOCOL.md`](../decision-matrix-systemone/PROTOCOL.md#local-scripts).

```json
{
  "version": 1,
  "scripts": [
    { "question": "category", "word": ["invoice", "refund"], "choice": "billing", "confidence": 0.96 },
    { "question": "category", "else": true, "choice": "other", "confidence": 0.45 }
  ]
}
```

A script reads the state. It is not a fact. Use it for a queue, a severity, or a commit tag. For a security decision, keep the gate on facts. Attack triage, CI, and access review do not ship with scripts.

When a script leaves a question open, the node sends only those questions. Script answers and server answers are merged, and the script wins on a question it answered. When `open_gate_requires_facts` is set, a question that an opening rule reads is still sent, and the server answer wins on that question. A script may still be the only answer for a hold.

## Local and hosted servers

The node only requires `POST {baseUrl}/v1/systemone` with a JSON body of `state` and `questions`, and a JSON response that contains an `answers` map.

| Setup | Base URL | API Key | Model |
| --- | --- | --- | --- |
| Local Lev, OpenJev, or another server that defaults the model | `http://localhost:8000` (or that process's host and port) | empty | leave empty |
| Gateway or host that mounts the protocol under a prefix | `https://gateway.example/your-prefix` | as that gateway requires | as that gateway requires |
| Hosted API that requires a model name | that API's origin | bearer token | set **Options → Model** to the id that server expects |

n8n must be able to open a TCP connection to the Base URL. A server bound to `127.0.0.1` is reachable when n8n runs on the same machine. An n8n container needs a host it can route to (`host.docker.internal`, a service name, or a public URL), not the container's idea of your laptop's `localhost` unless they share a network namespace.

This package does not embed a model and does not select Lev, Jev, or OpenJev for you.

## Errors

Validation runs before the HTTP call. Messages include a path such as `rules[2].when.all[0].gte`.

| Situation | What you see |
| --- | --- |
| Rules JSON is not version 1, a key is unknown, or a threshold name is missing | `RulesError` text on the item. The server is not called. |
| Base URL is missing, not http(s), or contains userinfo | Credential / node error before the call. |
| Connection refused, DNS failure, or timeout | `Could not reach the decision server at .../v1/systemone` plus the network reason. |
| HTTP 401 | The server expects a bearer token. Set API Key. |
| HTTP 403 | The token was rejected. |
| HTTP 404 | Base URL is not the server root, or the server does not serve `/v1/systemone`. |
| HTTP 400 or 422 | The server rejected `state`, `questions`, or a missing `model`. The response detail is included, truncated to 500 characters. |
| HTTP 5xx | The decision server failed. The status and a short body are included. |
| Response has no `answers` object, or an answer is not choice / noul / score | The body could not be read. A Decisions-style answers array is called out specifically. |
| A rule names a question the server did not return | The item lists the question ids that did come back. |

## Dialect tolerance

The reader accepts small differences between implementations:

- `type` may be omitted when `choice`, `noul` / `yes`, or `score` is present.
- Numbers may be numeric strings. A boolean noul is read as 1 or 0.
- Choice may be named `choice`, `value`, `selected`, or `label`. If it is missing, the highest probability wins.
- `probabilities` may be a map or an array of `{ value, probability }`.
- Usage may report `input_tokens` / `prompt_tokens` and `output_tokens` / `completion_tokens`.
- The answers map may be nested under `data` or `result` when it is not at the top level.

`confidence` is preferred over the selected option's probability when both exist. Those are different numbers on some servers.

## Libraries

The n8n package is the host. The other workspace packages are the shareable part. They do not import `n8n-workflow`. The build bundles the two this node uses into `dist/`, so installing this package into n8n does not require publishing them.

| Package | What it is |
| --- | --- |
| `decision-matrix-rules` | First-match rules engine. `evaluateRules(ruleset, answers, overrides)` returns `{ action, target, reason, gate, matched_rule, confidence, margin, contributions }`. `decisionReceipt` adds the ruleset hash and the paths and question ids that were read, without the values. No I/O. |
| `decision-matrix-systemone` | `POST /v1/systemone` client, plus local scripts (`validateScripts`, `runScripts`) that return the same answer view. |
| `decision-matrix-cli` | `decision-matrix decide` reads one event, calls the server (or a saved answers file), and prints the decision. `decision-matrix test` runs policy test cases with no server. `decision-matrix check` lints a ruleset. `decision-matrix diff` explains what a ruleset change does to the policy. |
| `decision-matrix-tui` | A terminal editor and test bench for a ruleset and its cases. Runs on Bun. |

The protocol other languages can implement is [`decision-matrix-systemone/PROTOCOL.md`](../decision-matrix-systemone/PROTOCOL.md). JSON Schemas live next to it and next to the rules package. A host such as a Python guard keeps its own HTTP stack, framing, and scanners, and follows that document for the request, the normalized answer view, and the ruleset.

There is no decision service in this repo. The decision server is already `POST /v1/systemone`. A local script can answer the same questions when a model is the wrong tool. The ruleset is evaluated in the caller so a bad ruleset fails before that request. The command is one such caller. Its README is [`decision-matrix-cli/README.md`](../decision-matrix-cli/README.md).

`ci-change` and `access-review` are fact-first presets for CI and routine audits. See [Facts](#facts). `attack-triage` is the command's default preset. It blocks a confident hostile intent, holds high risk or a human-review signal, and allows only a confident low-risk legitimate event. The default action also holds. Copy `packages/decision-matrix-cli/examples/attack-triage.questions.json` and `attack-triage.rules.json` when the team wants its own copy of that policy. After `pnpm build`, from the repository root:

```bash
node packages/decision-matrix-cli/dist/cli.js decide --answers packages/decision-matrix-cli/examples/attack-triage.block.answers.json --fail-on-gate
```

Exit 0 prints a decision whose gate is false, or any decision when `--fail-on-gate` is omitted. Exit 2 means the decision was printed and `gate` is true. Exit 1 means the event, the rules, or the server call failed.

```ts
import { callSystemOne } from 'decision-matrix-systemone';
import { assertThresholdsResolve, evaluateRules } from 'decision-matrix-rules';

assertThresholdsResolve(ruleset, overrides);
const result = await callSystemOne({ baseUrl, state, questions, apiKey, model });
const decision = evaluateRules(ruleset, result.answers, overrides);
```

## Development

From the repository root, `pnpm build`, `pnpm test`, and `pnpm typecheck` run every package through Turborepo. The repository README describes the workspace.

This package's tests use `node:test` and do not need n8n or a decision server. They cover the parameter parser, the item output, the n8n HTTP helpers, and the example workflows, including running each workflow's Code node on its pinned data.

Layout of this package:

```text
credentials/DecisionServerApi.credentials.ts   n8n credential
nodes/DecisionMatrix/DecisionMatrix.node.ts    n8n execute method
nodes/DecisionMatrix/n8n-http.ts               n8n HTTP helper error unwrapping
examples/*.workflow.json                       importable workflows
docker/                                        compose entrypoint and the local System One stand-in
scripts/                                       bundle, asset copy, and the dist/ cleaner
test/                                          unit tests
```

The compose file is `docker-compose.yml` at the repository root.

`n8n-workflow` is a peer dependency. n8n provides it at runtime. The dev dependency is only there so this package typechecks.

## License

MIT. See [LICENSE](LICENSE).
