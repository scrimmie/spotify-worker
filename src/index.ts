/**
 * spotify-worker — returns David's "currently playing" Spotify track for the
 * portfolio site (https://dapice.dev). The Spotify client secret + refresh
 * token live in Cloudflare secrets/KV and never leave the worker.
 *
 * This is a public, read-only endpoint: it is NOT protected by a client secret
 * (a static site can't hold one). Abuse is limited by a CORS origin allowlist,
 * short-lived edge caching, and (optionally) a Cloudflare rate-limit rule.
 */

export interface Env {
	KV_DAVID_PORTFOLIO: KVNamespace;
	SPOTIFY_CLIENT_ID: string;
	SPOTIFY_CLIENT_SECRET: string;
}

export interface SpotifyPlayerResponse {
	device: {
		id: string;
		is_active: boolean;
		is_private_session: boolean;
		is_restricted: boolean;
		name: string;
		type: string;
		volume_percent: number;
		supports_volume: boolean;
	};
	repeat_state: string;
	shuffle_state: boolean;
	context: {
		type: string;
		href: string;
		external_urls: {
			spotify: string;
		};
		uri: string;
	};
	timestamp: number;
	progress_ms: number;
	is_playing: boolean;
	item: {
		album: {
			album_type: string;
			total_tracks: number;
			available_markets: Array<string>;
			external_urls: {
				spotify: string;
			};
			href: string;
			id: string;
			images: Array<{
				url: string;
				height: number;
				width: number;
			}>;
			name: string;
			release_date: string;
			release_date_precision: string;
			restrictions: {
				reason: string;
			};
			type: string;
			uri: string;
			artists: Array<{
				external_urls: {
					spotify: string;
				};
				href: string;
				id: string;
				name: string;
				type: string;
				uri: string;
			}>;
		};
		artists: Array<{
			external_urls: {
				spotify: string;
			};
			followers: {
				href: string;
				total: number;
			};
			genres: Array<string>;
			href: string;
			id: string;
			images: Array<{
				url: string;
				height: number;
				width: number;
			}>;
			name: string;
			popularity: number;
			type: string;
			uri: string;
		}>;
		available_markets: Array<string>;
		disc_number: number;
		duration_ms: number;
		explicit: boolean;
		external_ids: {
			isrc: string;
			ean: string;
			upc: string;
		};
		external_urls: {
			spotify: string;
		};
		href: string;
		id: string;
		is_playable: boolean;
		linked_from: {};
		restrictions: {
			reason: string;
		};
		name: string;
		popularity: number;
		preview_url: string;
		track_number: number;
		type: string;
		uri: string;
		is_local: boolean;
	};
	currently_playing_type: string;
}

const ALLOWED_ORIGINS = ['https://www.dapice.dev', 'https://dapice.dev'];
const CACHE_TTL_SECONDS = 10;
const IDLE_PAYLOAD = { isPlaying: false };

// --- CORS (explicit, race-free, cache-safe) ---

function corsHeaders(request: Request): Record<string, string> {
	const headers: Record<string, string> = {
		Vary: 'Origin',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
	const origin = request.headers.get('Origin');
	if (origin && ALLOWED_ORIGINS.includes(origin)) {
		headers['Access-Control-Allow-Origin'] = origin;
	}
	return headers;
}

// Clone a response and attach per-request CORS headers. Applied AFTER cache
// reads so the cached body stays origin-independent and never serves one
// origin's Allow-Origin header to another.
function withCors(request: Request, response: Response): Response {
	const res = new Response(response.body, response);
	for (const [key, value] of Object.entries(corsHeaders(request))) {
		res.headers.set(key, value);
	}
	// Now-playing data is volatile. The short edge cache (caches.default) above
	// is enough to throttle Spotify calls; the *client* must never cache, or a
	// paused `isPlaying:false` gets pinned in the browser/CDN (the zone's Browser
	// Cache TTL was inflating our max-age=10 to hours), showing "idle" forever.
	res.headers.set('Cache-Control', 'no-store');
	return res;
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { 'Content-Type': 'application/json', ...init.headers },
	});
}

// --- Spotify ---

async function getAccessToken(env: Env, forceRefresh = false): Promise<string> {
	const cacheKey = `access_token:${env.SPOTIFY_CLIENT_ID}`;

	if (!forceRefresh) {
		const cached = await env.KV_DAVID_PORTFOLIO.get(cacheKey);
		if (cached) return cached;
	}

	const refreshToken = await env.KV_DAVID_PORTFOLIO.get(`refresh:${env.SPOTIFY_CLIENT_ID}`);
	if (!refreshToken) {
		throw new Error('no refresh token configured in KV');
	}

	const resp = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: {
			Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
	});

	// Never cache a bad token: bail loudly on failure so we retry next request.
	if (!resp.ok) {
		throw new Error(`spotify token refresh failed: ${resp.status}`);
	}
	const data = (await resp.json()) as { access_token?: string; expires_in?: number };
	if (!data.access_token) {
		throw new Error('spotify token refresh returned no access_token');
	}

	// Honor Spotify's real expiry (default 3600s) minus a safety margin.
	await env.KV_DAVID_PORTFOLIO.put(cacheKey, data.access_token, {
		expirationTtl: Math.max(60, (data.expires_in ?? 3600) - 60),
	});
	return data.access_token;
}

function fetchCurrentlyPlaying(token: string): Promise<Response> {
	return fetch('https://api.spotify.com/v1/me/player/currently-playing', {
		headers: { Authorization: `Bearer ${token}` },
	});
}

async function buildNowPlaying(env: Env): Promise<unknown> {
	let resp = await fetchCurrentlyPlaying(await getAccessToken(env));

	// A cached token can expire mid-flight — force one refresh and retry.
	if (resp.status === 401) {
		resp = await fetchCurrentlyPlaying(await getAccessToken(env, true));
	}

	// 204 (nothing playing), 429 (rate limited), 5xx, etc. → degrade to idle so
	// the cosmetic widget never hard-fails.
	if (resp.status !== 200) {
		return IDLE_PAYLOAD;
	}

	const data = (await resp.json()) as SpotifyPlayerResponse;
	return {
		isPlaying: data.is_playing,
		currentTrack: data.item,
		currentTrackProgress: data.progress_ms,
	};
}

async function handleCurrentTrack(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const cache = caches.default;
	// Origin-independent cache key so all callers share one cached payload;
	// CORS headers are layered on per-request afterwards.
	const cacheKey = new Request(new URL('/currentTrack', request.url).toString(), { method: 'GET' });

	let cached = await cache.match(cacheKey);
	if (!cached) {
		const payload = await buildNowPlaying(env);
		// Vary: Origin on the stored entry is defense-in-depth — keeps the cache
		// origin-safe even if CORS injection is ever moved before cache.put.
		cached = jsonResponse(payload, {
			headers: { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`, Vary: 'Origin' },
		});
		ctx.waitUntil(cache.put(cacheKey, cached.clone()));
	}
	return withCors(request, cached);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(request) });
		}

		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/currentTrack') {
			try {
				return await handleCurrentTrack(request, env, ctx);
			} catch (err) {
				// Log server-side (visible in `wrangler tail`); return a generic message.
				console.error('worker error', err instanceof Error ? err.stack : err);
				return withCors(request, jsonResponse({ error: 'something went wrong' }, { status: 500 }));
			}
		}

		return withCors(request, jsonResponse({ error: 'not found' }, { status: 404 }));
	},
};
