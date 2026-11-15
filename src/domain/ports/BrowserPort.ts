/** Opens URLs in the user's browser. */
export interface BrowserPort {
  /** Resolves false if no browser could be opened (e.g. headless machine). */
  open(url: string): Promise<boolean>;
}
