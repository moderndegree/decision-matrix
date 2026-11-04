# System One decision protocol

This is the wire format and the ruleset language implemented by `decision-matrix-systemone` and `decision-matrix-rules`. A host in another language can follow this document and the JSON Schemas without using n8n or TypeScript.

The TypeScript packages are the reference implementation. Schemas describe the shape. The parsers reject unknown keys and the cases the schemas cannot express, such as mixing choice operators with numeric operators on one predicate.

## Roles

A **decision server** accepts `POST {baseUrl}/v1/systemone` and returns typed answers. It does not choose an action.

A **client** sends `{ state, questions }` and normalizes the response into an answer map. `decision-matrix-systemone` is that client. A host that already has an HTTP stack can call the pure helpers and skip `callSystemOne`.

A **rules engine** turns that answer map and a version 1 ruleset into one action. `decision-matrix-rules` does that with no I/O. Evaluate locally. Do not put this step behind another service: a bad ruleset should fail before the server is called, and the ruleset belongs to the caller.

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

## Reference API

```ts
import { callSystemOne, normalizeSystemOneResponse, readState } from 'decision-matrix-systemone';
import { assertThresholdsResolve, evaluateRules } from 'decision-matrix-rules';

assertThresholdsResolve(ruleset, overrides);
const result = await callSystemOne({ baseUrl, apiKey, state, questions, model, timeoutMs });
const decision = evaluateRules(ruleset, result.answers, overrides);
```

`decision` is `{ action, target, reason, gate, matched_rule, confidence }`.

`callSystemOne` returns the normalized result. `result.rawAnswers` is the server's answers object, unchanged.
