import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { fetch } from 'undici';

import { config } from '@/config';
import type { Route } from '@/types';
import { hasValidAccessCredential } from '@/utils/weibo-oauth';

import { buildPrivateBlobUrl } from './xml';

export const route: Route = {
    path: '/video/:storeId/:path{.+}',
    name: 'Private video forwarding',
    categories: ['other'],
    example: '/vercel-blob/video/store-id/shanghai-affordable-house/videos/example.mp4',
    maintainers: [],
    parameters: {
        storeId: 'The DNS label before .private.blob.vercel-storage.com.',
        path: 'The complete MP4 file path. URL-encode each segment and keep directory separators as slashes.',
    },
    features: {
        requireConfig: [
            { name: 'ACCESS_KEY', description: 'Required RSSHub instance access key.' },
            { name: 'BLOB_READ_WRITE_TOKEN', description: 'Server-side private Blob token.' },
        ],
    },
    description: `Streams private MP4 files with RSSHub's existing key or path-scoped code authentication. Each video pathname needs its own code. Supports HEAD and a single HTTP byte range, preserving Content-Length, Content-Range and Accept-Ranges for playback and seeking. No feed serialization or public fallback. Video responses stream without buffering the entire file. REQUEST_TIMEOUT applies to the complete upstream request, including streaming. Rebuild and redeploy this route before using its URLs.`,
    handler: forwardPrivateBlobVideo,
};

export async function forwardPrivateBlobVideo(ctx: Context) {
    ctx.set('rawResponse', true);
    ctx.header('Cache-Control', 'private, no-store');
    ctx.header('CDN-Cache-Control', 'no-store');
    ctx.header('Vercel-CDN-Cache-Control', 'no-store');
    ctx.header('X-Content-Type-Options', 'nosniff');
    ctx.header('Referrer-Policy', 'no-referrer');
    const { token } = config.vercelBlob;
    if (!config.accessKey || !token || config.accessKey === token) {
        return ctx.text('Private media is not configured.', 503);
    }
    if (!hasValidAccessCredential(ctx)) {
        return ctx.text('Authentication failed.', 403);
    }
    const blobUrl = buildPrivateBlobUrl(ctx.req.param('storeId'), ctx.req.param('path'));
    if (!blobUrl) {
        return ctx.text('Invalid Blob store ID or file path.', 400);
    }
    const range = ctx.req.header('Range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
        return ctx.text('Only a single byte range is supported.', 416);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeout);
    let streaming = false;
    try {
        const upstream = await fetch(blobUrl, {
            method: ctx.req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: { Authorization: `Bearer ${token}`, ...(range && { Range: range }) },
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
        });
        if (upstream.status === 416) {
            const contentRange = upstream.headers.get('content-range');
            if (contentRange) {
                ctx.header('Content-Range', contentRange);
            }
            await upstream.body?.cancel();
            return ctx.body(null, 416);
        }
        if (![200, 206].includes(upstream.status) || upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'video/mp4') {
            await upstream.body?.cancel();
            return ctx.text('Unable to read private MP4 video.', 502);
        }
        ctx.header('Content-Type', 'video/mp4');
        for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
            const value = upstream.headers.get(name);
            if (value) {
                ctx.header(name, value);
            }
        }
        const status = upstream.status === 206 ? 206 : 200;
        if (ctx.req.method === 'HEAD') {
            await upstream.body?.cancel();
            return ctx.body(null, status);
        }
        const body = upstream.body;
        if (!body) {
            return ctx.text('Video body is missing.', 502);
        }
        ctx.status(status);
        streaming = true;
        return stream(ctx, async (writer) => {
            writer.onAbort(() => controller.abort());
            try {
                await writer.pipe(body);
            } finally {
                clearTimeout(timeout);
            }
        });
    } catch {
        return controller.signal.aborted ? ctx.text('Video request timed out.', 504) : ctx.text('Unable to read private video.', 502);
    } finally {
        if (!streaming) {
            clearTimeout(timeout);
        }
    }
}
