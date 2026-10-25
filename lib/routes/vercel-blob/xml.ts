import type { Context } from 'hono';
import { fetch } from 'undici';

import { config } from '@/config';
import type { Route } from '@/types';
import { hasValidAccessCredential } from '@/utils/weibo-oauth';

export const route: Route = {
    path: '/xml/:storeId/:path{.+}',
    name: 'Private XML forwarding',
    categories: ['other'],
    example: '/vercel-blob/xml/store-id/feeds/example.xml',
    maintainers: [],
    parameters: {
        storeId: 'The DNS label before .private.blob.vercel-storage.com, not a full URL.',
        path: 'The complete Blob file path, including directories. URL-encode each path segment; keep directory separators as slashes.',
    },
    features: {
        requireConfig: [
            { name: 'ACCESS_KEY', description: 'Required instance access key, separate from the Blob token. Also protects other RSSHub routes.' },
            { name: 'BLOB_READ_WRITE_TOKEN', description: 'Server-side token for the private Blob store. Never include it in the subscription URL.' },
        ],
    },
    description: `For self-hosted instances. Authenticates with RSSHub's existing \`?key=<ACCESS_KEY>\` or \`?code=<MD5(request pathname + ACCESS_KEY)>\` mechanism, then reads \`https://<storeId>.private.blob.vercel-storage.com/<path>\`. Blob-related configuration only requires \`BLOB_READ_WRITE_TOKEN\`; the store and file are route parameters. Missing access key/token or reusing the token as the access key disables forwarding (503); invalid parameters return 400, upstream failures return 502, and timeouts return 504. The token must have access to the requested store.

Only a single lowercase DNS label is accepted as storeId. Empty or dot path segments, backslashes, control characters, literal percent signs and query/fragment delimiters in filenames are rejected. Neither parameter can supply an arbitrary upstream URL.

The original XML bytes are forwarded without parsing or regenerating entries; RSSHub's format, limit and filtering parameters do not apply. Responses use private, no-store and are not stored in RSSHub's feed cache. Redirects are forbidden. REQUEST_TIMEOUT controls the complete upstream read (default 30000 milliseconds). Vercel's own Blob CDN may briefly return the previous version after an overwrite; HTTP no-store is not a guarantee of bypassing that upstream CDN.

Unlike a file allowlist, this route lets an authorized subscriber select any file the server-side token can read in the requested store. Treat subscription URLs as credentials. Prefer path-scoped code URLs when sharing a single subscription, use HTTPS, and redact query strings in proxy/hosting/tracing logs. Configure secrets locally or in your deployment environment, rebuild this source, and restart/redeploy manually. Node.js/Vercel only; no browser automation, collection or public fallback. See [Vercel's documented authenticated HTTP reads](https://vercel.com/docs/vercel-blob/private-storage#accessing-without-the-sdk).`,
    handler: forwardPrivateBlobXml,
};

export function buildPrivateBlobUrl(storeId: string | undefined, path: string | undefined): string | undefined {
    // One DNS label only: never accept a URL, port, credentials or domain suffix.
    // Hono decodes path parameters once. Reject residual escapes to prevent
    // double decoding, as well as URL delimiters and Windows path separators.
    // oxlint-disable-next-line no-control-regex
    if (!storeId || !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(storeId) || !path || /[\u{0000}-\u{001F}\u{007F}\\?#%]/u.test(path)) {
        return;
    }
    const segments = path.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        return;
    }
    try {
        const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/');
        return `https://${storeId}.private.blob.vercel-storage.com/${encodedPath}`;
    } catch {
        return;
    }
}

async function forwardPrivateBlobXml(ctx: Context) {
    // Opt out of feed serialization without setting cacheable RSSHub Data.
    ctx.set('rawResponse', true);
    ctx.header('Cache-Control', 'private, no-store');
    ctx.header('CDN-Cache-Control', 'no-store');
    ctx.header('Vercel-CDN-Cache-Control', 'no-store');
    ctx.header('X-Content-Type-Options', 'nosniff');
    ctx.header('Referrer-Policy', 'no-referrer');

    const { token } = config.vercelBlob;
    if (!config.accessKey || !token || config.accessKey === token) {
        return ctx.text('Private feed is not configured.', 503);
    }
    if (!hasValidAccessCredential(ctx)) {
        return ctx.text('Authentication failed.', 403);
    }
    const blobUrl = buildPrivateBlobUrl(ctx.req.param('storeId'), ctx.req.param('path'));
    if (!blobUrl) {
        return ctx.text('Invalid Blob store ID or file path.', 400);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeout);
    try {
        // Official authenticated HTTP read (no new SDK dependency):
        // https://vercel.com/docs/vercel-blob/private-storage#accessing-without-the-sdk
        // Use undici directly to avoid the global request wrapper's logging.
        const upstream = await fetch(blobUrl, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
        });
        if (upstream.status !== 200) {
            await upstream.body?.cancel();
            return ctx.text('Unable to read private feed.', 502);
        }
        // Read fully before responding so body errors/timeouts do not produce a
        // partial successful feed. Do not parse or reserialize the original XML.
        const body = await upstream.arrayBuffer();
        ctx.header('Content-Type', 'application/xml');
        return ctx.body(body);
    } catch {
        return controller.signal.aborted ? ctx.text('Private feed request timed out.', 504) : ctx.text('Unable to read private feed.', 502);
    } finally {
        clearTimeout(timeout);
    }
}
