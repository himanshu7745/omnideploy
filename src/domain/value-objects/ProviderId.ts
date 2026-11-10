/** Provider ids are open-ended so third-party providers can be registered. */
export type ProviderId = string;

export const BUILT_IN_PROVIDERS = ['vercel', 'netlify', 'github-pages', 'railway', 'render'] as const;
