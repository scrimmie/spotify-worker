import { Router, error, json } from 'itty-router';

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const router = Router();
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
	actions: {
		interrupting_playback: boolean;
		pausing: boolean;
		resuming: boolean;
		seeking: boolean;
		skipping_next: boolean;
		skipping_prev: boolean;
		toggling_repeat_context: boolean;
		toggling_shuffle: boolean;
		toggling_repeat_track: boolean;
		transferring_playback: boolean;
	};
}

async function getAccessToken(env: Env) {
	const cachedAccessToken = await env.KV_DAVID_PORTFOLIO.get(`access_token:${env.SPOTIFY_CLIENT_ID}`);
	if (cachedAccessToken) {
		return cachedAccessToken;
	}
	const refresh_token = await env.KV_DAVID_PORTFOLIO.get(`refresh:${env.SPOTIFY_CLIENT_ID}`);
	if (!refresh_token) {
		throw new Error(`no refresh token for '${env.SPOTIFY_CLIENT_ID}'`);
	}

	const authBody = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token,
	});
	const authHeader = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
	const tokenResp = await fetch('https://accounts.spotify.com/api/token', {
		body: authBody,
		headers: {
			Authorization: `Basic ${authHeader}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		method: 'POST',
	});
	const accessToken = ((await tokenResp.json()) as any).access_token;
	await env.KV_DAVID_PORTFOLIO.put(`access_token:${env.SPOTIFY_CLIENT_ID}`, accessToken, {
		expirationTtl: 3500,
	});
	return accessToken;
}

router.get('/currentTrack', async (request, env, context) => {
	const accessToken = await getAccessToken(env);
	const currentlyPlayingResponse = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	console.log(currentlyPlayingResponse.status);
	if (currentlyPlayingResponse.status === 204) {
		return '';
	}
	const currentlyPlaying: SpotifyPlayerResponse = await currentlyPlayingResponse.json();
	return {
		isPlaying: currentlyPlaying.is_playing,
		currentTrack: currentlyPlaying.item,
		currentTrackProgress: currentlyPlaying.progress_ms,
	};
});

router.all('*', () => new Response('404, not found!', { status: 404 }));

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => router.handle(request, env, ctx).then(json).catch(error),
};
