/**
 * Local stand-in for POST /v1/systemone used by docker compose.
 *
 * Phrases in the state select a scripted answer profile so the same ruleset
 * can take different actions. Anything else keeps the earlier fixed answers,
 * which still satisfy the credential test and the smaller example workflows.
 * A real server would score the same questions. This file only supplies the
 * answers the rules evaluate.
 *
 * Attack-gate phrases are listed first. They answer intent, risk, and
 * needs_human for examples/attack-*.workflow.json. A few also answer the
 * implement-gate questions used after an allow on the repo workflow.
 *
 * Access review phrases come first. They answer the access-review questions
 * for examples/audit-access-review.workflow.json:
 * - "on-call rotation for the payments api" → specific, supported, matching scope
 * - "needed for work" → vague, broader than needed
 * - "automated reviewers" → the justification addresses the reviewer
 *
 * Then the lifecycle phrases:
 * - "checkout" and "down" → incident, blast radius 3, production outage
 * - "spike" or "5xx" → degraded release, wide customer impact, rollback is safe
 * - "signed off" or "sign-off" → design approved, residual risk 1
 * - "a little worse" → degraded, narrow impact
 * - "healthy", "error rate flat", or "recovered" → healthy signal
 * - "migrate" → feature, blast radius 3, needs design
 * - "not sure" or "maybe" → bugfix at low confidence
 * - "typo" or "readme" → bugfix, blast radius 0, high confidence
 * - "better", "improve", or "feels off" → unclear, low confidence
 */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const port = Number(process.env.PORT || 8000);

function choice(selected, confidence) {
  return {
    type: 'choice',
    choice: selected,
    confidence,
    probabilities: { [selected]: confidence },
  };
}

function score(value, confidence) {
  return { type: 'score', score: value, confidence };
}

function noul(value) {
  return {
    type: 'noul',
    noul: value,
    confidence: Math.round(Math.abs(value - 0.5) * 2000) / 1000,
  };
}

function attackAnswers(intent, intentConfidence, riskValue, human) {
  return {
    intent: choice(intent, intentConfidence),
    risk: score(riskValue, 0.9),
    needs_human: noul(human),
  };
}

function implementAnswers(changeType, confidence, deliveryRisk, needsDesign, ready) {
  return {
    change_type: choice(changeType, confidence),
    delivery_risk: score(deliveryRisk, 0.9),
    needs_design: noul(needsDesign),
    ready_to_implement: noul(ready),
  };
}

function accessAnswers(injection, supports, specific, excess) {
  return {
    content_contains_instructions: noul(injection),
    justification_supports_access: noul(supports),
    justification_specific: noul(specific),
    excess_scope: score(excess, 0.9),
  };
}

function phrase(name, needle, answers) {
  return {
    name,
    test: (text) => text.includes(needle),
    answers,
  };
}

const PROFILES = [
  // Access review justifications. The injected one still fools the support
  // question. content_contains_instructions is what holds it.
  phrase('access-justified', 'on-call rotation for the payments api', accessAnswers(0.02, 0.93, 0.9, 0)),
  phrase('access-vague', 'needed for work', accessAnswers(0.03, 0.3, 0.1, 2)),
  phrase('access-injected', 'automated reviewers', accessAnswers(0.97, 0.9, 0.6, 1)),
  phrase(
    'agent-payout',
    'agent tool call to change the payout',
    attackAnswers('account_takeover', 0.93, 3, 0.5),
  ),
  phrase(
    'payout-destination',
    'payout destination',
    attackAnswers('account_takeover', 0.93, 3, 0.55),
  ),
  phrase(
    'role-grant',
    'role grant from a new country',
    attackAnswers('account_takeover', 0.9, 2, 0.4),
  ),
  phrase(
    'billing-readers',
    'billing readers group',
    attackAnswers('legitimate_ops', 0.94, 0, 0.06),
  ),
  phrase(
    'vendor-bank',
    'redirect the vendor bank',
    attackAnswers('social_engineering', 0.92, 3, 0.9),
  ),
  phrase(
    'owner-refund',
    'refund the duplicate charge',
    attackAnswers('legitimate_ops', 0.91, 1, 0.2),
  ),
  phrase('wire-deposit', 'wire the deposit', attackAnswers('benign', 0.46, 3, 0.91)),
  phrase('workflow-permission', 'workflow permission', attackAnswers('supply_chain', 0.95, 3, 0.4)),
  phrase('dependency-bump', 'dependency bump', attackAnswers('supply_chain', 0.62, 2, 0.75)),
  phrase('docs-only', 'docs only change', {
    ...attackAnswers('legitimate_ops', 0.93, 0, 0.05),
    ...implementAnswers('docs', 0.95, 0, 0.04, 0.93),
  }),
  phrase('payments-schema', 'payments schema change', {
    ...attackAnswers('legitimate_ops', 0.92, 1, 0.2),
    ...implementAnswers('feature', 0.91, 3, 0.93, 0.55),
  }),
  phrase(
    'admin-port',
    'admin port to the world',
    attackAnswers('reconnaissance', 0.9, 3, 0.35),
  ),
  phrase(
    'wildcard-iam',
    'wildcard iam in prod',
    attackAnswers('legitimate_ops', 0.6, 3, 0.86),
  ),
  phrase(
    'staging-tweak',
    'staging description tweak',
    attackAnswers('legitimate_ops', 0.95, 0, 0.04),
  ),
  phrase(
    'subnet-tag',
    'rename a private subnet tag',
    attackAnswers('legitimate_ops', 0.88, 0, 0.08),
  ),
  phrase(
    'disable-auth',
    'disable auth in prod',
    attackAnswers('supply_chain', 0.94, 3, 0.5),
  ),
  phrase(
    'debug-flag',
    'debug flag in staging',
    attackAnswers('legitimate_ops', 0.8, 1, 0.7),
  ),
  phrase('status-copy', 'status page copy', attackAnswers('benign', 0.94, 0, 0.05)),
  phrase(
    'bulk-export',
    'bulk export to an external recipient',
    attackAnswers('account_takeover', 0.91, 3, 0.6),
  ),
  phrase(
    'own-record',
    'export my own record',
    attackAnswers('legitimate_ops', 0.93, 1, 0.1),
  ),
  phrase(
    'new-domain',
    'large export to a new domain',
    attackAnswers('benign', 0.5, 3, 0.88),
  ),
  phrase('agent-handbook', 'public handbook', attackAnswers('benign', 0.96, 0, 0.02)),
  phrase('agent-shell', 'run a shell', attackAnswers('reconnaissance', 0.7, 3, 0.9)),
  phrase(
    'prior-holds',
    'prior holds on this token',
    attackAnswers('reconnaissance', 0.87, 2, 0.66),
  ),
  phrase(
    'auth-failures',
    'auth failures from a new country',
    attackAnswers('account_takeover', 0.92, 2, 0.4),
  ),
  phrase(
    'deploy-marker',
    'deploy marker explains',
    attackAnswers('legitimate_ops', 0.9, 1, 0.15),
  ),
  phrase('office-hours', 'office hours', attackAnswers('legitimate_ops', 0.55, 2, 0.84)),
  {
    name: 'outage',
    test: (text) => text.includes('checkout') && text.includes('down'),
    answers: {
      work_type: choice('incident', 0.96),
      blast_radius: score(3, 0.94),
      needs_design: noul(0.08),
      needs_human: noul(0.22),
      signal: choice('outage', 0.96),
      error_rate: score(3, 0.94),
      customer_impact: score(3, 0.93),
      caused_by_release: noul(0.35),
      rollback_safe: noul(0.3),
    },
  },
  {
    name: 'spike',
    test: (text) => text.includes('spike') || text.includes('5xx'),
    answers: {
      signal: choice('degraded', 0.94),
      error_rate: score(3, 0.92),
      customer_impact: score(3, 0.9),
      caused_by_release: noul(0.95),
      rollback_safe: noul(0.88),
    },
  },
  {
    name: 'design-approved',
    test: (text) => text.includes('signed off') || text.includes('sign-off'),
    answers: {
      design_approved: noul(0.95),
      residual_risk: score(1, 0.9),
      ready_to_implement: noul(0.91),
    },
  },
  {
    name: 'narrow',
    test: (text) => text.includes('a little worse'),
    answers: {
      signal: choice('degraded', 0.86),
      error_rate: score(1, 0.8),
      customer_impact: score(1, 0.84),
      caused_by_release: noul(0.55),
      rollback_safe: noul(0.4),
    },
  },
  {
    name: 'healthy',
    test: (text) =>
      text.includes('healthy') || text.includes('error rate flat') || text.includes('recovered'),
    answers: {
      signal: choice('healthy', 0.97),
      error_rate: score(0, 0.95),
      customer_impact: score(0, 0.93),
      caused_by_release: noul(0.12),
      rollback_safe: noul(0.2),
    },
  },
  {
    name: 'migration',
    test: (text) => text.includes('migrate'),
    answers: {
      work_type: choice('feature', 0.91),
      blast_radius: score(3, 0.9),
      needs_design: noul(0.93),
      needs_human: noul(0.4),
    },
  },
  {
    name: 'unsure',
    test: (text) => text.includes('not sure') || text.includes('maybe'),
    answers: {
      work_type: choice('bugfix', 0.48),
      blast_radius: score(1, 0.5),
      needs_design: noul(0.35),
      needs_human: noul(0.44),
    },
  },
  {
    name: 'typo',
    test: (text) => text.includes('typo') || text.includes('readme'),
    answers: {
      work_type: choice('bugfix', 0.93),
      blast_radius: score(0, 0.95),
      needs_design: noul(0.04),
      needs_human: noul(0.05),
    },
  },
  {
    name: 'vague',
    test: (text) => text.includes('better') || text.includes('improve') || text.includes('feels off'),
    answers: {
      work_type: choice('unclear', 0.41),
      blast_radius: score(1, 0.4),
      needs_design: noul(0.52),
      needs_human: noul(0.61),
    },
  },
];

function stateText(state) {
  if (typeof state === 'string') return state;
  if (state && typeof state === 'object') {
    const parts = [];
    for (const key of ['title', 'message', 'body', 'text', 'state']) {
      if (typeof state[key] === 'string') parts.push(state[key]);
    }
    if (parts.length > 0) return parts.join('\n');
    try {
      return JSON.stringify(state);
    } catch {
      return '';
    }
  }
  return state == null ? '' : String(state);
}

export function profileFor(state) {
  const text = stateText(state).toLowerCase();
  return PROFILES.find((profile) => profile.test(text)) ?? null;
}

function legacyChoice(question) {
  const criteria = question && question.criteria;
  if (criteria && !Array.isArray(criteria) && typeof criteria === 'object') {
    if (Object.prototype.hasOwnProperty.call(criteria, 'bugfix')) return 'bugfix';
    const keys = Object.keys(criteria);
    if (keys.length > 0) return keys[0];
  }
  return 'bugfix';
}

function legacyAnswer(id, question) {
  const type = question && typeof question === 'object' ? question.type : undefined;
  if (type === 'choice') {
    const selected = legacyChoice(question);
    return choice(selected, 0.92);
  }
  if (type === 'score') return score(1, 0.9);
  const value = id === 'ready_to_implement' || id === 'ok' ? 0.95 : 0.05;
  return noul(value);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'POST' || url !== '/v1/systemone') {
    send(res, 404, { error: 'Not found' });
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      send(res, 400, { error: 'Request body must be JSON.' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'Request body must be a JSON object.' });
      return;
    }
    const questions =
      body.questions && typeof body.questions === 'object' && !Array.isArray(body.questions)
        ? body.questions
        : {};
    const profile = profileFor(body.state);
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      answers[id] = (profile && profile.answers[id]) || legacyAnswer(id, question);
    }
    send(res, 200, {
      model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'dev-mock',
      answers,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });
});

function startedAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (startedAsScript()) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`System One stand-in listening on ${port}`);
  });
}
