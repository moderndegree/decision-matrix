/** Thrown when a ruleset is invalid or an evaluation cannot be completed safely. */
export class RulesError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RulesError';
	}
}
