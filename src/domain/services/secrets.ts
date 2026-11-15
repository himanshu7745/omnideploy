const SECRET = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|.+\.pem|.+\.key|.+\.p12|credentials\.json)$/;
const SECRET_OK = /(^|\/)\.env\.(example|sample|template|dist)$/;

/** Paths that should never be committed automatically (env files, private keys, ...). */
export function looksLikeSecret(path: string): boolean {
  return SECRET.test(path) && !SECRET_OK.test(path);
}
