/** Turns a directory or package name into a slug that is valid on every provider. */
export function toServiceName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  return slug || 'app';
}
