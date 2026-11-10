/**
 * - static:     a folder of files served by a CDN (Vite/CRA build, plain HTML)
 * - server:     a long-running process listening on $PORT (Express, Spring Boot, Django, ...)
 * - serverless: a framework the platform runs natively as functions (e.g. Next.js on Vercel)
 */
export type AppKind = 'static' | 'server' | 'serverless';
