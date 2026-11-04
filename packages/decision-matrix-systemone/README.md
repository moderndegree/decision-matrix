# decision-matrix-systemone

Client for `POST /v1/systemone`. It builds the request, normalizes dialect differences, and can perform the HTTP call. It does not choose an action. Pair it with `decision-matrix-rules`.

The protocol, including the aliases this package accepts, is [PROTOCOL.md](PROTOCOL.md). JSON Schemas are in `schema/`: `questions.schema.json` for a questions file (and a request's `questions`), `request.schema.json`, and `response.schema.json`. `validateQuestions` accepts exactly what `questions.schema.json` accepts: a choice has labels, a score has at least two levels, a noul has no criteria, and every question has instructions. `$schema` is allowed in a questions file and is not sent to the server.

```ts
import { callSystemOne } from 'decision-matrix-systemone';

const result = await callSystemOne({
  baseUrl: 'http://localhost:8000',
  state: 'the thing to classify',
  questions: {
    is_urgent: { type: 'noul', instructions: 'This needs attention before other work' },
  },
});
```

Hosts that already have an HTTP stack use `normalizeBaseUrl`, `systemOneUrl`, `buildSystemOneBody`, `interpretHttpResponse`, and `normalizeSystemOneResponse` instead of `callSystemOne`. The n8n node does that so credentials stay inside n8n.

`readState` accepts text, a JSON object, a JSON array, or JSON text. `validateQuestions` checks a questions object.

`GENERIC_TRIAGE_QUESTIONS`, `SDLC_QUESTIONS`, `SUPPORT_OPS_QUESTIONS`, and `ATTACK_TRIAGE_QUESTIONS` are examples. A host sends one when the caller did not supply questions. The paired rulesets live in `decision-matrix-rules`.
