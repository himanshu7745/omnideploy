import { describe, expect, it } from 'vitest';
import { findSecretsInText, looksLikeSecret, maskSecret } from '../../src/domain/index.js';

describe('looksLikeSecret (by file name)', () => {
  it.each([
    '.env', 'config/.env.local', '.env.production', 'server.key', 'certs/tls.pem', 'src/main/resources/keystore.jks', 'store.p12',
    'id_rsa', 'deploy/id_ed25519', 'credentials.json', 'client_secret_123.apps.googleusercontent.com.json', 'service-account.json',
    'src/main/resources/application-local.yml', 'application-secret.properties', '.streamlit/secrets.toml', 'local.settings.json',
    'infra/terraform.tfvars', 'terraform.tfstate', '.netrc', '.git-credentials',
  ])('%s is a secret file', (p) => expect(looksLikeSecret(p)).toBe(true));

  it.each([
    '.env.example', '.env.sample', '.env.template', 'src/main/resources/application.yml', 'application-prod.yml', 'application.properties',
    'package.json', 'src/monkey.js', 'internal/key.go', 'id_rsa.pub', 'docs/keys.md', 'config/secrets.yml',
  ])('%s is not a secret file', (p) => expect(looksLikeSecret(p)).toBe(false));
});

describe('findSecretsInText (by content)', () => {
  const kinds = (path: string, text: string) => findSecretsInText(path, text).map((m) => `${m.line}:${m.kind}`);

  it('Spring application.yml with a hard-coded password', () => {
    const yml = ['spring:', '  datasource:', '    url: jdbc:postgresql://db.example.com:5432/app', '    username: app', '    password: S3cretPass!'].join('\n');
    expect(kinds('src/main/resources/application.yml', yml)).toEqual(['5:password']);
  });

  it('Spring config that reads secrets from the environment is fine', () => {
    const yml = ['spring:', '  datasource:', '    password: ${DB_PASSWORD}', '    username: ${DB_USER:app}', 'jwt:', '  secret: ${JWT_SECRET}', 'server:', '  port: 8080'].join('\n');
    expect(kinds('application.yml', yml)).toEqual([]);
  });

  it('application.properties', () => {
    const props = ['server.port=8080', 'jwt.expiration=86400', 'spring.datasource.password=hunter22', 'app.jwt.secret = c2VjcmV0LWtleS0xMjM0NTY3OA==', 'security.csrf.token-name=X-CSRF-TOKEN', 'csrf.token=X-CSRF-TOKEN'].join('\n');
    expect(kinds('application.properties', props)).toEqual(['3:password', '4:secret']);
  });

  it('passwords inside connection URLs, but not for localhost', () => {
    expect(kinds('config.yml', 'database_url: postgres://app:pa55word@db.prod.example.com:5432/app')).toEqual(['1:password in a connection URL']);
    expect(kinds('docker-compose.yml', 'DATABASE_URL: postgres://postgres:devpass1@localhost:5432/db')).toEqual([]);
    expect(kinds('src/db.ts', 'const url = "mongodb+srv://admin:Xk29fj2@cluster0.abc.mongodb.net/app"')).toEqual(['1:password in a connection URL']);
  });

  it('.NET connection strings and Maven XML', () => {
    expect(kinds('appsettings.json', '  "Default": "Server=db;Database=app;User Id=sa;Password=Str0ngP@ss;"')).toEqual(['1:password in a connection string']);
    expect(kinds('settings.xml', '<server><id>repo</id><password>hunter22</password></server>')).toEqual(['1:password']);
  });

  it('token formats are found in code and even in comments', () => {
    expect(kinds('src/client.py', 'API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"')).toEqual(['1:Anthropic API key']);
    expect(kinds('src/aws.go', '// key: AKIAABCDEFGHIJKLMNOP')).toEqual(['1:AWS access key']);
    expect(kinds('.npmrc', '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789')).toEqual(['1:npm token']);
    expect(kinds('notes.txt', '-----BEGIN RSA PRIVATE KEY-----')).toEqual(['1:private key']);
  });

  it('does not flag ordinary code, placeholders, templates or local dev defaults', () => {
    expect(kinds('app.py', "password = request.form['password']\nsecret = os.environ['SECRET']")).toEqual([]);
    expect(kinds('.github/workflows/ci.yml', 'token: ${{ secrets.GITHUB_TOKEN }}\napi_key: ${{ secrets.KEY }}')).toEqual([]);
    expect(kinds('docker-compose.yml', 'POSTGRES_PASSWORD: postgres\nRABBITMQ_DEFAULT_PASS: guest\nMYSQL_ROOT_PASSWORD: root')).toEqual([]);
    expect(kinds('config.yml', 'password: changeme\napi_key: your-api-key-here\nsecret: "<secret>"\ntoken: xxxxxxxx')).toEqual([]);
    expect(kinds('application.yml', '# password: hunter22 (example)')).toEqual([]);
    expect(kinds('package.json', '{ "name": "app", "version": "1.0.0", "scripts": { "build": "vite build" } }')).toEqual([]);
  });

  it('never returns the full value', () => {
    const [m] = findSecretsInText('application.yml', 'password: S3cretPass!');
    expect(m!.preview).toBe('S3•••s!');
    expect(maskSecret('abc')).toBe('a•••');
  });
});

describe('SecretGuard.addToGitignore', () => {
  it('appends after content without a trailing newline and skips entries already listed', async () => {
    const { SecretGuard } = await import('../../src/application/index.js');
    const { MemoryFs, FakePrompt, MemoryLogger } = await import('../helpers/fakes.js');
    const fs = new MemoryFs(new Map([['/p/.gitignore', 'node_modules/\n/.env']]));
    const guard = new SecretGuard(fs, new FakePrompt(false), new MemoryLogger());
    expect(await guard.addToGitignore('/p', ['.env', 'certs/tls.key'])).toEqual(['certs/tls.key']);
    expect(fs.files.get('/p/.gitignore')).toBe('node_modules/\n/.env\n\n# Secrets (added by omnideploy)\ncerts/tls.key\n');
    expect(await guard.addToGitignore('/p', ['certs/tls.key'])).toEqual([]);
  });

  it('skips binary and unreadable files when scanning', async () => {
    const { SecretGuard } = await import('../../src/application/index.js');
    const { MemoryFs, FakePrompt, MemoryLogger } = await import('../helpers/fakes.js');
    const fs = new MemoryFs(new Map([['/p/logo.png', '\u0000PNG password: hunter22']]));
    const guard = new SecretGuard(fs, new FakePrompt(false), new MemoryLogger());
    expect(await guard.scan('/p', ['logo.png', 'deleted.yml'])).toEqual([]);
  });
});
