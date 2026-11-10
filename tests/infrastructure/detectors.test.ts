import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetectProject } from '../../src/application/index.js';
import { builtInDetectors } from '../../src/infrastructure/detectors/index.js';
import { NodeFileSystem } from '../../src/infrastructure/fs/NodeFileSystem.js';
import { MemoryConfigRepo } from '../helpers/fakes.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const detect = (name: string) => new DetectProject(builtInDetectors(new NodeFileSystem()), new MemoryConfigRepo()).execute(join(FIXTURES, name));

describe('project detection', () => {
  it.each([
    ['spring-maven', { language: 'java', framework: 'spring-boot', kind: 'server', runtimeVersion: '21', port: 8080, packageManager: 'maven' }],
    ['spring-gradle', { language: 'java', framework: 'spring-boot', runtimeVersion: '17', packageManager: 'gradle' }],
    ['vite', { language: 'node', framework: 'vite-react', kind: 'static', outputDir: 'dist', buildCommand: 'npm run build' }],
    ['next', { language: 'node', framework: 'nextjs', kind: 'serverless', packageManager: 'pnpm', runtimeVersion: '20' }],
    ['express', { language: 'node', framework: 'express', kind: 'server', startCommand: 'npm start' }],
    ['django', { language: 'python', framework: 'django', runtimeVersion: '3.11', port: 8000 }],
    ['fastapi', { language: 'python', framework: 'fastapi', packageManager: 'uv', runtimeVersion: '3.12' }],
    ['go', { language: 'go', framework: 'gin', runtimeVersion: '1.22' }],
    ['rust', { language: 'rust', framework: 'axum' }],
    ['rails', { language: 'ruby', framework: 'rails', runtimeVersion: '3.3' }],
    ['laravel', { language: 'php', framework: 'laravel', runtimeVersion: '8.2' }],
    ['dotnet', { language: 'dotnet', framework: 'aspnetcore', runtimeVersion: '8.0' }],
    ['plain-html', { language: 'static', kind: 'static', outputDir: '.' }],
    ['dockerfile', { language: 'docker', kind: 'server', port: 9000, hasDockerfile: true }],
  ])('%s', async (fixture, expected) => {
    const { profile } = await detect(fixture);
    expect(profile).toMatchObject(expected);
  });

  it('derives start commands that honour $PORT', async () => {
    expect((await detect('django')).profile.startCommand).toBe('gunicorn mysite.wsgi:application --bind 0.0.0.0:$PORT');
    expect((await detect('fastapi')).profile.startCommand).toBe('uvicorn app.main:api --host 0.0.0.0 --port $PORT');
    expect((await detect('spring-maven')).profile.startCommand).toBe('java -Dserver.port=$PORT -jar app.jar');
  });

  it('records where the Go main package lives', async () => {
    expect((await detect('go')).profile.meta?.mainPath).toBe('./cmd/server');
  });

  it('uses the project name for services', async () => {
    expect((await detect('spring-gradle')).profile.meta?.name).toBe('orders-service');
  });

  it('applies omnideploy.json overrides on top of detection', async () => {
    const repo = new MemoryConfigRepo({ providers: {}, build: { output: 'build' }, app: { port: 4000 } });
    const { profile } = await new DetectProject(builtInDetectors(new NodeFileSystem()), repo).execute(join(FIXTURES, 'vite'));
    expect(profile).toMatchObject({ outputDir: 'build', port: 4000 });
  });

  it('fails with a helpful error for unknown projects', async () => {
    await expect(detect('does-not-exist')).rejects.toThrow(/Could not detect a supported project/);
  });
});
