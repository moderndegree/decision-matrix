# System One decision protocol

This is the wire format and the ruleset language implemented by `decision-matrix-systemone` and `decision-matrix-rules`. A host in another language can follow this document and the JSON Schemas without using n8n or TypeScript.

The TypeScript packages are the reference implementation. Schemas describe the shape. The parsers reject unknown keys and the cases the schemas cannot express, such as mixing choice operators with numeric operators on one predicate.

## Roles

A **decision server** accepts `POST {baseUrl}/v1/systemone` and returns typed answers. It does not choose an action.

A **client** sends `{ state, questions }` and normalizes the response into an answer map. `decision-matrix-systemone` is that client. A host that already has an HTTP stack can call the pure helpers and skip `callSystemOne`.

A **rules engine** turns that answer map and a version 1 ruleset into one action. `decision-matrix-rules` does that with no I/O. Evaluate locally. Do not put this step behind another service: a bad ruleset should fail before the server is called, and the ruleset belongs to the caller.

A **script** answers some or all of the questions on the caller. It reads the same state and returns the same answer view. Questions it answers are left out of the request. When it answers every question, the server is not called. `validateScripts` and `runScripts` are the reference. The script is data, so a host in another language can implement the matchers below and get the same answers.

The `decision-matrix` command in `decision-matrix-cli` is a local host. It reads one event, calls this protocol, and evaluates the ruleset in-process.

Text framing, secret redaction, circuit breakers, and security scanners are host concerns. They are not part of this protocol. A guard can redact and frame `state`, call this client, then apply its own policy or a ruleset. Facts a ruleset reads (`{ "fact": ... }` predicates) stay with the host and are never part of the request body.

## Request

`POST {baseUrl}/v1/systemone`

`baseUrl` is an absolute `http` or `https` URL. A path prefix is kept, so a gateway may mount the protocol at `https://example.com/gateway`. Trailing slashes are removed. Userinfo, query strings, and hashes are rejected. The client appends `/v1/systemone`.

```json
{
  "state": "text, object, or array",
  "questions": {
    "question_id": { "type": "noul", "instructions": "..." }
  }
}
```

Send `model` only when the server requires one. Do not send an empty string.

Send `Authorization: Bearer <token>` only when a token is set.

Question `type` is `choice`, `noul`, or `score`.

| type | criteria | canonical answer |
| --- | --- | --- |
| `noul` | omit | `{ "type": "noul", "noul": 0.91 }` yes-probability from 0 to 1 |
| `choice` | map of option id to description, or a list of labels | `{ "type": "choice", "choice": "bug", "confidence": 0.8, "probabilities": { "bug": 0.8 } }` |
| `score` | levels, lowest first | `{ "type": "score", "score": 2, "confidence": 0.7, "probabilities": { "0": 0.1, "2": 0.7 } }` |

Schema: `schema/request.schema.json`.

## Response

Canonical success body:

```json
{
  "model": "optional",
  "answers": { "<question_id>": {} },
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

Schema: `schema/response.schema.json`.

The normalizer also accepts these dialects, then returns the canonical answer view:

- `type` may be omitted when `choice`, `noul` / `yes`, or `score` is present.
- Numbers may be numeric strings. A boolean noul is read as 1 or 0.
- Choice may be named `choice`, `value`, `selected`, or `label`. If it is missing, the highest probability wins.
- `probabilities` may be a map or an array of `{ "value", "probability" }`.
- Usage may report `input_tokens` / `prompt_tokens` and `output_tokens` / `completion_tokens`, in snake or camel case.
- The answers map may sit under `data` or `result` when it is not at the top level.
- An answers array is rejected. That is a different protocol.

`confidence` is preferred over the selected option's probability when both exist. Some servers report different numbers for those fields.

The normalized answer view, which `evaluateRules` consumes, is `$defs.answerView` in `decision-matrix-rules/schema/ruleset.schema.json`.

## Ruleset

Version 1. Rules run in array order. The first rule whose `when` tree is true wins. If none match, `default_action` is returned with `matched_rule: null` and `confidence: 0`.

Every branch of `all` / `any` is evaluated, so a later typo still surfaces after an earlier branch has decided the boolean.

Several operators on one predicate are AND, in a fixed order: identity (`eq`, `neq`, `in`, `not_in`), then confidence, then numeric (`gte`, `gt`, `lte`, `lt`). JSON key order does not change the result. Identity operators and numeric operators cannot share a predicate.

Numeric and confidence operators accept a number, a threshold name, `{{thresholds.name}}`, or `{ "threshold": "name" }`. Names resolve against `rules.thresholds` after the caller's overrides replace same-named entries. Choice operators compare labels literally.

`target` and `reason` may contain `{{answers.<id>.choice}}`, `{{answers.<id>.noul}}`, `{{answers.<id>.score}}`, `{{answers.<id>.confidence}}`, `{{answers.<id>.type}}`, and `{{thresholds.<name>}}`. A known path that does not resolve becomes an empty string. Any other placeholder is left in place so a typo stays visible.

Output confidence is the minimum `bestEffortConfidence` of the questions the winning rule references.

- Choice and score prefer the server `confidence`. Otherwise choice uses the selected option's probability, then the maximum probability. Score uses the maximum level probability.
- Noul has no separate confidence. Its contribution is decisiveness, `abs(noul - 0.5) * 2`. That is uncertainty, not the yes-probability. Compare a noul with `gte` / `gt` / `lte` / `lt`, not with `confidence_gte`.

Schema: `decision-matrix-rules/schema/ruleset.schema.json`.

## Local scripts

Version 1. Schema: `schema/scripts.schema.json`. A script is not part of the request body.

```json
{
  "version": 1,
  "scripts": [
    { "question": "category", "word": ["invoice", "refund"], "choice": "billing", "confidence": 0.96 },
    { "question": "category", "else": true, "choice": "other", "confidence": 0.45 }
  ]
}
```

Steps run in order. The first step that matches a question writes that answer, and later steps for the same question are skipped. `else` matches when nothing earlier answered that question, and it has to be the last step for that question.

A step has one matcher and one answer.

| Matcher | Match |
| --- | --- |
| `contains` | The needle is a substring of the searched text. |
| `word` | The needle appears with a boundary on each side. A boundary is the end of the text or a character that is not an ASCII letter, digit, or `_`. |
| `tag` | The searched text starts with the needle, and the next character is `:` or `(`. `feat` matches `feat:` and `feat(api):`. It does not match `feature:` or `feat add`. |
| `equals` | `{ "path", "value" }` compared with strict equality. A string is case-sensitive. A missing path does not match. |
| `else` | `true`. No path. |

`contains`, `word`, and `tag` take a string or a list of strings. Any one needle can match. Needles are compared in ASCII lowercase: `A`–`Z` fold to `a`–`z`, and no other character changes, so `É` and `é` stay different. The fold happens once, when the script is compiled.

`path` limits `contains`, `word`, and `tag` to those fields. It is a dotted path or a list of them (`title`, `commit.type`, `items.0.subject`). Any listed field can match. Names start with a letter or `_`. Indexes are `0` or a number without a leading zero. A path nests at most 32 segments. `__proto__`, `prototype`, and `constructor` are rejected. `else` and `equals` do not take a step `path`.

Where the text comes from:

- A string state is the whole text. `tag` with no `path` reads it from the first character.
- An object or array joins every string leaf with `\n`, object keys in ascending UTF-16 order, array items in index order. Numbers, booleans, and null are left out of that text. `contains` and `word` with no `path` search the joined text. `tag` with no `path` does not: a tag is a prefix, and the joined text has no single start that a host should guess.
- A `path` reads one field. The match runs only when that field is a string. `equals` reads the field as its JSON value.

`choice` and `score` require `confidence` from 0 to 1. The answer view also carries `probabilities` of `{ "<choice or score>": confidence }`, which is what a one-label server response normalizes to. `noul` is the yes-probability from 0 to 1 and carries no `confidence`. The rules engine turns that into decisiveness itself.

`generic`, `sdlc`, and `support` ship with scripts that answer every question, so those presets can run with no server. `attack-triage`, `ci-change`, and `access-review` do not. A script reads the state you give it. It is not a fact, and a keyword match is not a verification.

## Reference API

```ts
import { callSystemOne, normalizeSystemOneResponse, readState, runScripts, unansweredQuestions, validateScripts } from 'decision-matrix-systemone';
import { assertThresholdsResolve, evaluateRules } from 'decision-matrix-rules';

assertThresholdsResolve(ruleset, overrides);
const program = validateScripts(scripts, questions);
const local = runScripts(program, state);
const remaining = unansweredQuestions(questions, local);
const remote = Object.keys(remaining).length === 0
  ? { answers: {} }
  : await callSystemOne({ baseUrl, apiKey, state, questions: remaining, model, timeoutMs });
const decision = evaluateRules(ruleset, { ...remote.answers, ...local }, overrides);
```

`decision` is `{ action, target, reason, gate, matched_rule, confidence }`.

`callSystemOne` returns the normalized result. `result.rawAnswers` is the server's answers object, unchanged.
