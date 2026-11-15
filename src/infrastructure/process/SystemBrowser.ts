import type { BrowserPort, ProcessRunnerPort } from '../../domain/index.js';

export class SystemBrowser implements BrowserPort {
  constructor(
    private readonly proc: ProcessRunnerPort,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async open(url: string): Promise<boolean> {
    if (!/^https:\/\//.test(url)) return false;
    const [bin, args] =
      this.platform === 'darwin' ? ['open', [url]] : this.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    return (await this.proc.run(bin as string, args as string[])).exitCode === 0;
  }
}
