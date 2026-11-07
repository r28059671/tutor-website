type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
	interface Locals extends Runtime {
		isAdmin: boolean;
	}
}

// lib.dom's CacheStorage shadows the Workers one in worker-configuration.d.ts, hiding this property.
interface CacheStorage {
	readonly default: Cache;
}
