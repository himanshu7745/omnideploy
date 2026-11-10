import { parse as parseToml } from 'smol-toml';
import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { extractVersion, firstExisting, hasDockerfile } from './support.js';

export class PythonDetector implements ProjectDetector {
  readonly id = 'python';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const read = (f: string) => this.fs.readTextIfExists(this.fs.join(root, f));
    const [requirements, pyprojectRaw, pipfile, hasManage] = await Promise.all([
      read('requirements.txt'),
      read('pyproject.toml'),
      read('Pipfile'),
      this.fs.exists(this.fs.join(root, 'manage.py')),
    ]);
    if (requirements === null && pyprojectRaw === null && pipfile === null && !hasManage) return null;

    let pyproject: Record<string, any> = {};
    try {
      pyproject = pyprojectRaw ? (parseToml(pyprojectRaw) as Record<string, any>) : {};
    } catch {
      /* tolerate invalid pyproject */
    }
    const depsText = [requirements, pyprojectRaw, pipfile].filter(Boolean).join('\n').toLowerCase();
    const has = (name: string) => new RegExp(`(^|[\\s"'\\[,])${name}([\\s"'<>=~!\\[,;]|$)`, 'm').test(depsText);

    const packageManager = (await this.fs.exists(this.fs.join(root, 'uv.lock')))
      ? 'uv'
      : (await this.fs.exists(this.fs.join(root, 'poetry.lock'))) || pyproject.tool?.poetry
        ? 'poetry'
        : 'pip';
    const runtimeVersion =
      extractVersion(await read('.python-version')) ??
      extractVersion((await read('runtime.txt'))?.replace('python-', '')) ??
      extractVersion(pyproject.project?.['requires-python']) ??
      '3.12';

    const name: string = pyproject.project?.name ?? pyproject.tool?.poetry?.name ?? '';
    const base = {
      rootDir: root,
      language: 'python' as const,
      kind: 'server' as const,
      packageManager: packageManager as 'uv' | 'poetry' | 'pip',
      runtimeVersion,
      hasDockerfile: await hasDockerfile(this.fs, root),
    };
    const requirementsMeta = { requirements: String(requirements !== null) };

    if (hasManage || has('django')) {
      const project = await this.findDjangoProject(root);
      return {
        profile: {
          ...base,
          framework: 'django',
          port: 8000,
          startCommand: `gunicorn ${project}.wsgi:application --bind 0.0.0.0:$PORT`,
          buildCommand: 'python manage.py collectstatic --noinput',
          meta: { ...requirementsMeta, name, extraPackages: has('gunicorn') ? '' : 'gunicorn' },
        },
        confidence: 85,
      };
    }
    if (has('fastapi')) {
      const mod = (await this.findAppModule(root, 'FastAPI(')) ?? 'main:app';
      return {
        profile: { ...base, framework: 'fastapi', port: 8000, startCommand: `uvicorn ${mod} --host 0.0.0.0 --port $PORT`, meta: { ...requirementsMeta, name, extraPackages: has('uvicorn') ? '' : 'uvicorn' } },
        confidence: 85,
      };
    }
    if (has('flask')) {
      const mod = (await this.findAppModule(root, 'Flask(')) ?? 'app:app';
      return {
        profile: { ...base, framework: 'flask', port: 5000, startCommand: `gunicorn ${mod} --bind 0.0.0.0:$PORT`, meta: { ...requirementsMeta, name, extraPackages: has('gunicorn') ? '' : 'gunicorn' } },
        confidence: 85,
      };
    }
    if (has('streamlit')) {
      const entry = (await firstExisting(this.fs, root, ['streamlit_app.py', 'app.py', 'main.py'])) ?? 'app.py';
      return {
        profile: { ...base, framework: 'streamlit', port: 8501, startCommand: `streamlit run ${entry} --server.port $PORT --server.address 0.0.0.0`, meta: { ...requirementsMeta, name } },
        confidence: 85,
      };
    }
    const entry = await firstExisting(this.fs, root, ['main.py', 'app.py', 'server.py']);
    return {
      profile: { ...base, port: 8000, startCommand: entry ? `python ${entry}` : undefined, meta: { ...requirementsMeta, name } },
      confidence: 60,
    };
  }

  private async findDjangoProject(root: string): Promise<string> {
    for (const entry of await this.fs.list(root)) {
      if (await this.fs.exists(this.fs.join(root, entry, 'wsgi.py'))) return entry;
    }
    return 'config';
  }

  /** Finds "module:app" for the file that instantiates the framework app. */
  private async findAppModule(root: string, marker: string): Promise<string | undefined> {
    for (const file of ['main.py', 'app.py', 'server.py', 'app/main.py', 'src/main.py', 'api/main.py', 'app/__init__.py']) {
      const src = await this.fs.readTextIfExists(this.fs.join(root, file));
      if (!src?.includes(marker)) continue;
      const varName = src.match(new RegExp(`^(\\w+)\\s*=\\s*${marker.replace('(', '\\(')}`, 'm'))?.[1] ?? 'app';
      const mod = file.replace(/\/__init__\.py$/, '').replace(/\.py$/, '').replace(/\//g, '.');
      return `${mod}:${varName}`;
    }
    return undefined;
  }
}
