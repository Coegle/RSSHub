import type { Route } from '@/types';

import { forwardPrivateBlob } from './xml';

export const route: Route = {
    path: '/image/:storeId/:path{.+}',
    name: 'Private image forwarding',
    categories: ['other'],
    example: '/vercel-blob/image/store-id/shanghai-affordable-house/images/example.jpg',
    maintainers: [],
    parameters: {
        storeId: 'The DNS label before .private.blob.vercel-storage.com, not a full URL.',
        path: 'The complete Blob image path. URL-encode each segment and keep directory separators as slashes.',
    },
    features: {
        requireConfig: [
            { name: 'ACCESS_KEY', description: 'Required RSSHub instance access key.' },
            { name: 'BLOB_READ_WRITE_TOKEN', description: 'Server-side private Blob token. Never include it in image URLs.' },
        ],
    },
    description: `For self-hosted instances. Uses the same authentication and private Blob access as the XML forwarding route. Supply either \`?key=<ACCESS_KEY>\` or a path-scoped \`?code=<MD5(request pathname + ACCESS_KEY)>\`. Each image pathname requires its own code; a feed subscription code cannot be reused for its images.

Returns JPEG, PNG, GIF or WebP binary data with the upstream image Content-Type, with an 8 MiB limit. Other content types are rejected. Responses are private, no-store and bypass feed serialization. The route requires both ACCESS_KEY and BLOB_READ_WRITE_TOKEN and does not provide an unauthenticated fallback. Treat image URLs as credentials.`,
    handler: (ctx) => forwardPrivateBlob(ctx, true),
};
