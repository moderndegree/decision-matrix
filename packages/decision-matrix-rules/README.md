# decision-matrix-rules

First-match rules engine for normalized System One answers. No I/O and no HTTP client.

The wire format, the confidence rules, and the local scripts that produce the same answer view are in `decision-matrix-systemone`'s `PROTOCOL.md`. The ruleset schema is `schema/ruleset.schema.json`, and `$defs.answerView` in it is the answer shape this package evaluates. Facts follow `schema/facts.schema.json`. `validateRuleset` and `validateFacts` accept exactly what those schemas accept, and the tests check both against the same corpus.

```ts
import { assertFactsResolve, assertThresholdsResolve, decideFromFacts, evaluateRules } from 'decision-matrix-rules';

assertThresholdsResolve(ruleset, overrides);
assertFactsResolve(ruleset, facts);
const decision =
  decideFromFacts(ruleset, facts, overrides) ?? // facts alone decided, skip the server
  evaluateRules(ruleset, await askServer(), overrides, facts);
```

`decision` is `{ action, target, reason, gate, matched_rule, confidence }`.

Call `assertThresholdsResolve` and `assertFactsResolve` before contacting a decision server so a bad ruleset or a missing fact does not spend a request. `evaluateRules` validates again.

`facts` is a JSON object of values the host verified. `{ "fact": "path", ... }` predicates read it with strict comparisons, and a missing fact or a wrong type is an error, never false. `decideFromFacts` returns the decision when the leading rules reference only facts and one matches, and null when the server must be asked. `open_gate_requires_facts: true` rejects a ruleset in which model answers alone could open the gate. The Facts section of the [n8n package README](../n8n-nodes-decision-matrix/README.md#facts) has the details.

`traceRules(ruleset, answers, overrides, facts)` explains an evaluation: for every rule, the value each predicate saw and the result of each operator. It uses the same operator code as `evaluateRules`. `lintRuleset(ruleset, { questions })` returns static findings without evaluating anything. The CLI README lists the codes.

`CI_CHANGE_RULES` and `ACCESS_REVIEW_RULES` are strict, fact-first policies for a pull request check and a scheduled access review. `GENERIC_TRIAGE_RULES`, `SDLC_RULES`, `SUPPORT_OPS_RULES`, and `ATTACK_TRIAGE_RULES` are examples. They are not applied unless a caller passes them. The matching question presets live in `decision-matrix-systemone`. `ATTACK_TRIAGE_RULES` holds a confident hostile intent, holds high risk or a human-review signal, and allows only a confident low-risk legitimate event. Its default action also holds.
