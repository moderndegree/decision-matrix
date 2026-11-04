/**
 * Scripts for the routing presets. They answer every question, so a host can
 * skip the server. Copy one and edit the words. Attack triage, CI, and access
 * review have none: those questions are judgments, and a keyword is not a fact.
 *
 * Steps run in order. The first match for a question wins, so a specific word
 * comes before a broad one, and else is last.
 */

export const GENERIC_TRIAGE_SCRIPTS = {
	version: 1 as const,
	scripts: [
		{
			question: 'category',
			word: ['invoice', 'refund', 'subscription', 'charge', 'charged', 'payment', 'billing', 'receipt'],
			choice: 'billing',
			confidence: 0.96,
		},
		{
			question: 'category',
			word: ['login', 'password', 'sign in', '2fa', 'mfa', 'locked out'],
			choice: 'account',
			confidence: 0.94,
		},
		{
			question: 'category',
			word: ['bug', 'crash', 'outage', 'error', 'broken', 'exception'],
			choice: 'technical',
			confidence: 0.9,
		},
		{ question: 'category', else: true, choice: 'other', confidence: 0.45 },
		{ question: 'urgency', word: ['outage', 'all users', 'safety issue'], score: 3, confidence: 0.94 },
		{ question: 'urgency', word: ['urgent', 'asap', 'today', 'right now'], score: 2, confidence: 0.9 },
		{ question: 'urgency', word: ['tomorrow', 'soon'], score: 1, confidence: 0.8 },
		{ question: 'urgency', else: true, score: 0, confidence: 0.7 },
		{ question: 'needs_human', word: ['please review', 'call me', 'talk to a person'], noul: 0.93 },
		{ question: 'needs_human', else: true, noul: 0.08 },
	],
};

export const SUPPORT_OPS_SCRIPTS = {
	version: 1 as const,
	scripts: [
		{
			question: 'severity',
			word: ['outage', 'service down', 'all customers', 'data loss'],
			choice: 'sev1',
			confidence: 0.94,
		},
		{
			question: 'severity',
			word: ['degraded', '5xx', 'error rate', 'many customers'],
			choice: 'sev2',
			confidence: 0.9,
		},
		{ question: 'severity', word: ['workaround', 'some users', 'minor'], choice: 'sev3', confidence: 0.88 },
		{ question: 'severity', word: ['how do i', 'how to', 'cosmetic'], choice: 'sev4', confidence: 0.9 },
		{ question: 'severity', else: true, choice: 'sev4', confidence: 0.4 },
		{
			question: 'customer_impact',
			word: ['all customers', 'everyone', 'data loss'],
			score: 3,
			confidence: 0.93,
		},
		{ question: 'customer_impact', word: ['many customers', 'widespread'], score: 2, confidence: 0.88 },
		{ question: 'customer_impact', word: ['single user', 'one account'], score: 1, confidence: 0.85 },
		{ question: 'customer_impact', else: true, score: 0, confidence: 0.7 },
		{
			question: 'page_oncall',
			word: ['outage', 'service down', 'all customers', 'data loss', 'wake me'],
			noul: 0.95,
		},
		{ question: 'page_oncall', else: true, noul: 0.05 },
	],
};

const COMMIT_TAGS = ['feat', 'feature', 'fix', 'bugfix', 'bug', 'refactor', 'docs', 'doc', 'chore', 'build', 'ci'];
const COMMIT_PATHS = ['title', 'subject', 'message'];

export const SDLC_SCRIPTS = {
	version: 1 as const,
	scripts: [
		{ question: 'change_type', equals: { path: 'commit.type', value: 'feat' }, choice: 'feature', confidence: 1 },
		{ question: 'change_type', equals: { path: 'commit.type', value: 'feature' }, choice: 'feature', confidence: 1 },
		{ question: 'change_type', equals: { path: 'commit.type', value: 'fix' }, choice: 'bugfix', confidence: 1 },
		{ question: 'change_type', equals: { path: 'commit.type', value: 'bugfix' }, choice: 'bugfix', confidence: 1 },
		{ question: 'change_type', equals: { path: 'commit.type', value: 'refactor' }, choice: 'refactor', confidence: 1 },
		{ question: 'change_type', equals: { path: 'commit.type', value: 'docs' }, choice: 'docs', confidence: 1 },
		{ question: 'change_type', equals: { path: 'commit.type', value: 'chore' }, choice: 'chore', confidence: 1 },
		{ question: 'change_type', tag: ['feat', 'feature'], choice: 'feature', confidence: 0.99 },
		{ question: 'change_type', path: COMMIT_PATHS, tag: ['feat', 'feature'], choice: 'feature', confidence: 0.99 },
		{ question: 'change_type', tag: ['fix', 'bugfix', 'bug'], choice: 'bugfix', confidence: 0.99 },
		{ question: 'change_type', path: COMMIT_PATHS, tag: ['fix', 'bugfix', 'bug'], choice: 'bugfix', confidence: 0.99 },
		{ question: 'change_type', tag: 'refactor', choice: 'refactor', confidence: 0.99 },
		{ question: 'change_type', path: COMMIT_PATHS, tag: 'refactor', choice: 'refactor', confidence: 0.99 },
		{ question: 'change_type', tag: ['docs', 'doc'], choice: 'docs', confidence: 0.99 },
		{ question: 'change_type', path: COMMIT_PATHS, tag: ['docs', 'doc'], choice: 'docs', confidence: 0.99 },
		{ question: 'change_type', tag: ['chore', 'build', 'ci'], choice: 'chore', confidence: 0.99 },
		{ question: 'change_type', path: COMMIT_PATHS, tag: ['chore', 'build', 'ci'], choice: 'chore', confidence: 0.99 },
		{ question: 'change_type', word: ['readme', 'documentation'], choice: 'docs', confidence: 0.86 },
		{ question: 'change_type', word: ['typo', 'bug'], choice: 'bugfix', confidence: 0.8 },
		{ question: 'change_type', word: 'refactor', choice: 'refactor', confidence: 0.86 },
		{ question: 'change_type', else: true, choice: 'chore', confidence: 0.4 },
		{
			question: 'risk',
			word: ['migrate', 'migration', 'breaking', 'security', 'authentication', 'payment', 'credential'],
			score: 3,
			confidence: 0.9,
		},
		{ question: 'risk', word: ['api', 'schema', 'database'], score: 2, confidence: 0.85 },
		{ question: 'risk', else: true, score: 0, confidence: 0.75 },
		{ question: 'needs_design', word: ['migrate', 'migration', 'breaking', 'redesign', 'architecture'], noul: 0.92 },
		{ question: 'needs_design', else: true, noul: 0.08 },
		{ question: 'ready_to_implement', word: ['not sure', 'tbd', 'unclear', 'to be determined'], noul: 0.15 },
		{ question: 'ready_to_implement', tag: COMMIT_TAGS, noul: 0.9 },
		{ question: 'ready_to_implement', path: COMMIT_PATHS, tag: COMMIT_TAGS, noul: 0.9 },
		{ question: 'ready_to_implement', word: ['acceptance criteria', 'steps to reproduce', 'repro'], noul: 0.92 },
		{ question: 'ready_to_implement', else: true, noul: 0.55 },
	],
};

export const SCRIPT_PRESETS = {
	generic: GENERIC_TRIAGE_SCRIPTS,
	sdlc: SDLC_SCRIPTS,
	support: SUPPORT_OPS_SCRIPTS,
} as const;
