/** Thrown when the decision server cannot be called or its body cannot be read. */
export class SystemOneError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SystemOneError';
	}
}
