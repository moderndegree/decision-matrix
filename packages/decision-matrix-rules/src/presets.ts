/**
 * Example rulesets paired with the question presets in decision-matrix-systemone.
 * Hosts may copy these. They are not applied unless a caller passes them.
 */

/** Pairs with GENERIC_TRIAGE_QUESTIONS. This is the node's default ruleset. */
export const GENERIC_TRIAGE_RULES = {
	version: 1 as const,
	owner: 'decision-matrix',
	ticket: 'generic',
	default_action: {
		type: 'escalate',
		target: 'human',
		reason: 'No matching rule',
		gate: true,
	},
	thresholds: {
		high_confidence: 0.85,
		medium_confidence: 0.7,
	},
	rules: [
		{
			id: 'urgent-human',
			description: 'High urgency or an explicit human-review signal goes to a person',
			when: {
				any: [
					{ question: 'needs_human', gte: 'high_confidence' },
					{ question: 'urgency', gte: 2 },
				],
			},
			action: {
				type: 'escalate',
				target: 'human',
				reason: 'Urgency or human review signal crossed the threshold',
				gate: true,
			},
		},
		{
			id: 'route-category',
			description: 'Route to the chosen queue when the choice is confident enough',
			when: {
				all: [{ question: 'category', confidence_gte: 'medium_confidence' }],
			},
			action: {
				type: 'route',
				target: '{{answers.category.choice}}',
				reason: 'Category {{answers.category.choice}} with sufficient confidence',
				gate: false,
			},
		},
	],
};

/** Pairs with SDLC_QUESTIONS. */
export const SDLC_RULES = {
	version: 1 as const,
	owner: 'decision-matrix',
	ticket: 'sdlc',
	default_action: {
		type: 'escalate',
		target: 'human',
		reason: 'No matching rule',
		gate: true,
	},
	thresholds: {
		high_confidence: 0.85,
		medium_confidence: 0.7,
		high_risk: 2,
	},
	rules: [
		{
			id: 'needs-design',
			description: 'Unclear or high-risk work goes to design review',
			when: {
				any: [
					{ question: 'needs_design', gte: 'medium_confidence' },
					{ question: 'risk', gte: 'high_risk' },
					{ question: 'ready_to_implement', lt: 0.4 },
				],
			},
			action: {
				type: 'review',
				target: 'design',
				reason: 'Change needs design review before implementation',
				gate: true,
			},
		},
		{
			id: 'ready-implementer',
			description: 'Specific, lower-risk work can go to an implementer',
			when: {
				all: [
					{ question: 'ready_to_implement', gte: 'high_confidence' },
					{ question: 'risk', lt: 'high_risk' },
					{
						question: 'change_type',
						in: ['feature', 'bugfix', 'refactor', 'docs', 'chore'],
						confidence_gte: 'medium_confidence',
					},
				],
			},
			action: {
				type: 'route',
				target: 'implementer',
				reason: 'Ready to implement as {{answers.change_type.choice}}',
				gate: false,
			},
		},
	],
};

/** Pairs with SUPPORT_OPS_QUESTIONS. */
export const SUPPORT_OPS_RULES = {
	version: 1 as const,
	owner: 'decision-matrix',
	ticket: 'support',
	default_action: {
		type: 'escalate',
		target: 'human',
		reason: 'No matching rule',
		gate: true,
	},
	thresholds: {
		page_threshold: 0.8,
		high_confidence: 0.85,
	},
	rules: [
		{
			id: 'page-oncall',
			description: 'Page on-call for a confident high severity or a strong page signal',
			when: {
				any: [
					{ question: 'page_oncall', gte: 'page_threshold' },
					{
						question: 'severity',
						in: ['sev1', 'sev2'],
						confidence_gte: 'high_confidence',
					},
				],
			},
			action: {
				type: 'page',
				target: 'oncall',
				reason: 'Severity {{answers.severity.choice}} warrants a page',
				gate: true,
			},
		},
		{
			id: 'queue-ticket',
			description: 'Queue everything else that has a confident severity',
			when: {
				all: [{ question: 'severity', confidence_gte: 'high_confidence' }],
			},
			action: {
				type: 'route',
				target: 'ticket-queue',
				reason: 'Queue as {{answers.severity.choice}}',
				gate: false,
			},
		},
	],
};

/**
 * Pairs with ATTACK_TRIAGE_QUESTIONS.
 * A starter hold policy: block a confident hostile intent, hold high risk or a
 * human-review signal, and allow only a confident low-risk legitimate event.
 * The default action also holds. Copy it and edit the labels before relying on it.
 * The host still has to put deterministic facts in the state.
 */
export const ATTACK_TRIAGE_RULES = {
	version: 1 as const,
	owner: 'decision-matrix',
	ticket: 'attack-triage',
	default_action: {
		type: 'escalate',
		target: 'human',
		reason: 'No matching rule',
		gate: true,
	},
	thresholds: {
		high_confidence: 0.85,
		high_risk: 2,
	},
	rules: [
		{
			id: 'hold-hostile',
			description: 'A confident hostile intent is blocked before any other route',
			when: {
				all: [
					{
						question: 'intent',
						in: ['account_takeover', 'social_engineering', 'supply_chain', 'reconnaissance'],
						confidence_gte: 'high_confidence',
					},
				],
			},
			action: {
				type: 'block',
				target: 'security',
				reason: 'Hold {{answers.intent.choice}} before any automated action',
				gate: true,
			},
		},
		{
			id: 'hold-uncertain',
			description: 'High risk or a human-review signal goes to a person',
			when: {
				any: [
					{ question: 'needs_human', gte: 'high_confidence' },
					{ question: 'risk', gte: 'high_risk' },
				],
			},
			action: {
				type: 'escalate',
				target: 'human',
				reason: 'Risk or human-review signal crossed the threshold',
				gate: true,
			},
		},
		{
			id: 'allow-legitimate',
			description: 'Only a confident, low-risk, legitimate event can be automated',
			when: {
				all: [
					{
						question: 'intent',
						in: ['legitimate_ops', 'benign'],
						confidence_gte: 'high_confidence',
					},
					{ question: 'risk', lt: 'high_risk' },
				],
			},
			action: {
				type: 'allow',
				target: 'automation',
				reason: 'Allow {{answers.intent.choice}} below risk {{thresholds.high_risk}}',
				gate: false,
			},
		},
	],
};


/**
 * Pairs with CI_CHANGE_QUESTIONS. A required check on a pull request.
 *
 * Facts come from git and the platform API on the runner, never from the PR
 * text. Fact-only holds run first, so a CI, script, or new-dependency change
 * is held without calling the server. The model can then only add holds.
 * Every rule that passes needs facts too (`open_gate_requires_facts`).
 *
 * `pass` means the check is green and normal human review still applies.
 * `auto_merge` is only for a bot's patch-level dependency update.
 */
export const CI_CHANGE_RULES = {
	version: 1 as const,
	open_gate_requires_facts: true,
	owner: 'decision-matrix',
	ticket: 'ci-change',
	agreements: [{ question: 'changes_runtime_behavior', fact: 'docs_only', relation: 'inverse' as const }],
	default_action: {
		type: 'hold',
		target: 'human',
		reason: 'No rule passed this change',
		gate: true,
	},
	thresholds: {
		high_confidence: 0.85,
		injection: 0.5,
		suspicion: 0.3,
		high_risk: 2,
		max_files: 20,
	},
	rules: [
		{
			id: 'hold-ci-config',
			description: 'CI, build, release, or policy files changed. Facts only, so the model is not asked.',
			when: { all: [{ fact: 'touches_ci', eq: true }] },
			action: {
				type: 'hold',
				target: 'security',
				reason: 'Changes CI, build, release, or review policy files',
				gate: true,
			},
		},
		{
			id: 'hold-package-scripts',
			description: 'Install and build scripts run on developer machines and runners',
			when: { all: [{ fact: 'changes_package_scripts', eq: true }] },
			action: {
				type: 'hold',
				target: 'security',
				reason: 'Changes package scripts that run at install or build time',
				gate: true,
			},
		},
		{
			id: 'hold-new-dependency',
			description: 'A new package name is a supply-chain decision for a person',
			when: { all: [{ fact: 'new_package_count', gt: 0 }] },
			action: {
				type: 'hold',
				target: 'security',
				reason: 'Adds {{facts.new_package_count}} new package(s)',
				gate: true,
			},
		},
		{
			id: 'hold-injection',
			description: 'Any sign that the PR text or code comments address the reviewer or a model',
			when: { all: [{ question: 'content_contains_instructions', gte: 'injection' }] },
			action: {
				type: 'block',
				target: 'security',
				reason: 'The change text tries to instruct the reviewer',
				gate: true,
			},
		},
		{
			id: 'hold-suspicious-code',
			description: 'Obfuscation, credential access, new egress, or build-time execution',
			when: { all: [{ question: 'suspicious_code', gte: 'suspicion' }] },
			action: {
				type: 'hold',
				target: 'security',
				reason: 'The diff contains code a person should inspect',
				gate: true,
			},
		},
		{
			id: 'hold-mismatch',
			description:
				'The diff does not match its description, or the model disagrees with a verified fact. Either the change hides something or the model was steered.',
			when: {
				any: [
					{ question: 'description_matches_diff', lt: 0.5 },
					{
						all: [
							{ fact: 'docs_only', eq: true },
							{ question: 'changes_runtime_behavior', gte: 0.5 },
						],
					},
				],
			},
			action: {
				type: 'hold',
				target: 'human',
				reason: 'The description, the diff, and the facts do not agree',
				gate: true,
			},
		},
		{
			id: 'hold-risk',
			when: { all: [{ question: 'risk', gte: 'high_risk' }] },
			action: {
				type: 'hold',
				target: 'human',
				reason: 'Security risk {{answers.risk.score}} is at or above {{thresholds.high_risk}}',
				gate: true,
			},
		},
		{
			id: 'auto-merge-dependency-patch',
			description: 'A dependency bot patch update with nothing else in the diff',
			when: {
				all: [
					{ fact: 'author_is_dependency_bot', eq: true },
					{ fact: 'dependency_update_type', eq: 'patch' },
					{ fact: 'diff_truncated', eq: false },
					{ question: 'suspicious_code', lt: 0.1 },
					{ question: 'description_matches_diff', gte: 'high_confidence' },
				],
			},
			action: {
				type: 'auto_merge',
				target: 'automation',
				reason: 'Patch update from {{facts.author}} with nothing unexpected in the diff',
				gate: false,
			},
		},
		{
			id: 'pass-docs',
			when: {
				all: [
					{ fact: 'docs_only', eq: true },
					{ fact: 'diff_truncated', eq: false },
					{ question: 'risk', lt: 1 },
				],
			},
			action: {
				type: 'pass',
				target: 'review',
				reason: 'Documentation only',
				gate: false,
			},
		},
		{
			id: 'pass-small-change',
			description: 'Small, fully seen, outside sensitive paths, and the model agrees',
			when: {
				all: [
					{ fact: 'touches_sensitive', eq: false },
					{ fact: 'touches_dependencies', eq: false },
					{ fact: 'diff_truncated', eq: false },
					{ fact: 'files_changed', lte: 'max_files' },
					{ question: 'risk', lt: 'high_risk' },
					{ question: 'description_matches_diff', gte: 'high_confidence' },
					{ question: 'suspicious_code', lt: 0.1 },
				],
			},
			action: {
				type: 'pass',
				target: 'review',
				reason: 'Small change outside sensitive paths at risk {{answers.risk.score}}',
				gate: false,
			},
		},
	],
};

/**
 * Pairs with ACCESS_REVIEW_QUESTIONS. One grant per evaluation, on a schedule.
 *
 * Revocation comes only from facts (an inactive principal, unused privileged
 * access). The model judges the written justification, which the grantee
 * wrote, so its answers can only send a grant to a person. `keep` needs
 * recent use, an owner approval, and a current review, plus the model's
 * agreement.
 */
export const ACCESS_REVIEW_RULES = {
	version: 1 as const,
	open_gate_requires_facts: true,
	owner: 'decision-matrix',
	ticket: 'access-review',
	default_action: {
		type: 'review',
		target: 'owner',
		reason: 'No rule kept this grant',
		gate: true,
	},
	thresholds: {
		high_confidence: 0.85,
		injection: 0.5,
		stale_privileged_days: 90,
		stale_days: 30,
		review_days: 365,
	},
	rules: [
		{
			id: 'revoke-inactive-principal',
			description: 'HR or the directory says the person or service is gone',
			when: { all: [{ fact: 'principal.active', eq: false }] },
			action: {
				type: 'revoke',
				target: 'iam',
				reason: '{{facts.principal.id}} is no longer active',
				gate: true,
			},
		},
		{
			id: 'revoke-stale-privileged',
			when: {
				all: [
					{ fact: 'grant.privileged', eq: true },
					{ fact: 'grant.days_since_last_use', gte: 'stale_privileged_days' },
				],
			},
			action: {
				type: 'revoke',
				target: 'iam',
				reason: 'Privileged {{facts.grant.role}} unused for {{facts.grant.days_since_last_use}} days',
				gate: true,
			},
		},
		{
			id: 'review-human-without-mfa',
			when: {
				all: [
					{ fact: 'principal.type', eq: 'human' },
					{ fact: 'principal.mfa', eq: false },
				],
			},
			action: {
				type: 'review',
				target: 'security',
				reason: '{{facts.principal.id}} holds {{facts.grant.role}} without MFA',
				gate: true,
			},
		},
		{
			id: 'review-injection',
			description: 'The grantee wrote the justification. Text that addresses the reviewer goes to security.',
			when: { all: [{ question: 'content_contains_instructions', gte: 'injection' }] },
			action: {
				type: 'review',
				target: 'security',
				reason: 'The justification for {{facts.grant.role}} tries to instruct the reviewer',
				gate: true,
			},
		},
		{
			id: 'review-weak-justification',
			when: {
				any: [
					{ question: 'justification_supports_access', lt: 0.5 },
					{ question: 'justification_specific', lt: 0.5 },
					{ question: 'excess_scope', gte: 2 },
				],
			},
			action: {
				type: 'review',
				target: 'owner',
				reason: 'The justification does not support {{facts.grant.role}} as granted',
				gate: true,
			},
		},
		{
			id: 'keep-justified',
			when: {
				all: [
					{ fact: 'grant.owner_approved', eq: true },
					{ fact: 'grant.days_since_last_use', lte: 'stale_days' },
					{ fact: 'grant.days_since_review', lte: 'review_days' },
					{ question: 'justification_supports_access', gte: 'high_confidence' },
					{ question: 'excess_scope', lt: 2 },
				],
			},
			action: {
				type: 'keep',
				target: 'audit-log',
				reason: 'In use, approved, reviewed, and justified',
				gate: false,
			},
		},
	],
};
