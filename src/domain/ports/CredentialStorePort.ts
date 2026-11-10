export interface StoredCredential {
  token: string;
  source: 'env' | 'store';
}

export interface CredentialStorePort {
  /** Looks up the env var first, then the persisted store. */
  get(providerId: string, envVar: string): Promise<StoredCredential | null>;
  set(providerId: string, token: string): Promise<void>;
  delete(providerId: string): Promise<boolean>;
}
