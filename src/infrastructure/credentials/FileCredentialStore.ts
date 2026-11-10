import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CredentialStorePort, StoredCredential } from '../../domain/index.js';

interface CredentialFile {
  providers: Record<string, { token: string; savedAt: string }>;
}

/** Env var first, then a JSON file readable only by the current user (mode 0600). */
export class FileCredentialStore implements CredentialStorePort {
  constructor(
    private readonly filePath: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async get(providerId: string, envVar: string): Promise<StoredCredential | null> {
    const fromEnv = this.env[envVar]?.trim();
    if (fromEnv) return { token: fromEnv, source: 'env' };
    const stored = (await this.read()).providers[providerId];
    return stored ? { token: stored.token, source: 'store' } : null;
  }

  async set(providerId: string, token: string): Promise<void> {
    const data = await this.read();
    data.providers[providerId] = { token, savedAt: new Date().toISOString() };
    await this.write(data);
  }

  async delete(providerId: string): Promise<boolean> {
    const data = await this.read();
    if (!data.providers[providerId]) return false;
    delete data.providers[providerId];
    await this.write(data);
    return true;
  }

  private async read(): Promise<CredentialFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<CredentialFile>;
      return { providers: parsed.providers ?? {} };
    } catch {
      return { providers: {} };
    }
  }

  private async write(data: CredentialFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await chmod(this.filePath, 0o600);
  }
}
