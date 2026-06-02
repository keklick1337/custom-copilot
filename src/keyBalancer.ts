import { logger } from "./logger";

/**
 * Per-key health state used to balance requests across multiple API keys.
 */
interface KeyState {
	/** Accumulated error score (decays over time and on success). */
	errors: number;
	/** Timestamp (ms) of the last recorded error, used for decay. */
	lastErrorAt: number;
	/** While `Date.now()` is below this value the key is benched. */
	cooldownUntil: number;
}

interface ProviderState {
	states: Map<string, KeyState>;
	/** Round-robin cursor shared across concurrent requests for this provider. */
	cursor: number;
}

// One error is forgiven every DECAY_INTERVAL_MS so benched keys recover.
const DECAY_INTERVAL_MS = 15000;
// A key whose error score exceeds the current minimum by more than this is excluded.
const BENCH_THRESHOLD = 2;
// Hitting this error score benches the key for COOLDOWN_MS.
const BENCH_ERROR_LIMIT = 5;
const COOLDOWN_MS = 30000;
// A successful request forgives this many accumulated errors.
const SUCCESS_RECOVERY = 2;

/**
 * Balances requests across a pool of API keys for a single logical provider.
 *
 * Selection prefers the healthiest keys (fewest recent errors) and round-robins
 * among keys of comparable health so load is spread evenly. Keys that accumulate
 * many errors are temporarily benched until their error score decays below the
 * others. The balancer is concurrency-safe for the simple round-robin/score model
 * because all mutation happens synchronously inside its methods.
 */
class KeyBalancer {
	private readonly providers = new Map<string, ProviderState>();

	private getProvider(provider: string): ProviderState {
		let state = this.providers.get(provider);
		if (!state) {
			state = { states: new Map<string, KeyState>(), cursor: 0 };
			this.providers.set(provider, state);
		}
		return state;
	}

	private getKeyState(providerState: ProviderState, key: string): KeyState {
		let state = providerState.states.get(key);
		if (!state) {
			state = { errors: 0, lastErrorAt: 0, cooldownUntil: 0 };
			providerState.states.set(key, state);
		}
		return state;
	}

	/** Forgive accumulated errors based on elapsed time since the last error. */
	private decay(state: KeyState, now: number): void {
		if (state.errors <= 0 || state.lastErrorAt <= 0) {
			return;
		}
		const steps = Math.floor((now - state.lastErrorAt) / DECAY_INTERVAL_MS);
		if (steps > 0) {
			state.errors = Math.max(0, state.errors - steps);
			state.lastErrorAt = now;
			if (state.errors === 0) {
				state.cooldownUntil = 0;
			}
		}
	}

	/**
	 * Select the next key to use from the provided pool.
	 * @param provider Normalized provider id (lowercase).
	 * @param keys The available API keys for this provider.
	 * @returns The chosen key, or an empty string when the pool is empty.
	 */
	public selectKey(provider: string, keys: string[]): string {
		if (keys.length === 0) {
			return "";
		}
		if (keys.length === 1) {
			return keys[0];
		}

		const providerState = this.getProvider(provider);
		const now = Date.now();

		// Refresh decay for every key in the pool.
		for (const key of keys) {
			this.decay(this.getKeyState(providerState, key), now);
		}

		const minErrors = Math.min(...keys.map((key) => this.getKeyState(providerState, key).errors));

		// Healthy candidates: not benched and within BENCH_THRESHOLD of the best key.
		let candidates = keys.filter((key) => {
			const state = this.getKeyState(providerState, key);
			return state.cooldownUntil <= now && state.errors <= minErrors + BENCH_THRESHOLD;
		});

		// If everything is benched, fall back to the keys with the fewest errors.
		if (candidates.length === 0) {
			candidates = keys.filter((key) => this.getKeyState(providerState, key).errors === minErrors);
		}
		if (candidates.length === 0) {
			candidates = keys;
		}

		const index = providerState.cursor % candidates.length;
		providerState.cursor = (providerState.cursor + 1) % Number.MAX_SAFE_INTEGER;
		return candidates[index];
	}

	/** Record a failed request for a key, benching it once it gets too unhealthy. */
	public reportError(provider: string, key: string): void {
		if (!key) {
			return;
		}
		const providerState = this.getProvider(provider);
		const state = this.getKeyState(providerState, key);
		state.errors += 1;
		state.lastErrorAt = Date.now();
		if (state.errors >= BENCH_ERROR_LIMIT) {
			state.cooldownUntil = state.lastErrorAt + COOLDOWN_MS;
		}
		logger.debug("keyBalancer.error", {
			provider,
			errors: state.errors,
			benched: state.cooldownUntil > Date.now(),
		});
	}

	/** Record a successful request for a key, recovering part of its error score. */
	public reportSuccess(provider: string, key: string): void {
		if (!key) {
			return;
		}
		const providerState = this.getProvider(provider);
		const state = this.getKeyState(providerState, key);
		if (state.errors > 0) {
			state.errors = Math.max(0, state.errors - SUCCESS_RECOVERY);
		}
		if (state.errors === 0) {
			state.cooldownUntil = 0;
		}
	}
}

export const keyBalancer = new KeyBalancer();

/**
 * Parse a stored secret value into a list of distinct API keys.
 * Keys may be separated by newlines (preferred), or commas. A single key
 * (the legacy format) yields a one-element array, preserving backward
 * compatibility.
 */
export function parseApiKeys(secretValue: string | undefined | null): string[] {
	if (!secretValue) {
		return [];
	}
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const raw of secretValue.split(/[\r\n,]+/)) {
		const key = raw.trim();
		if (key && !seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
	}
	return keys;
}
