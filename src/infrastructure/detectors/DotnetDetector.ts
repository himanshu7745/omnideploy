import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { hasDockerfile } from './support.js';

export class DotnetDetector implements ProjectDetector {
  readonly id = 'dotnet';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const csproj = (await this.fs.list(root)).find((f) => f.endsWith('.csproj') || f.endsWith('.fsproj'));
    if (!csproj) return null;
    const xml = await this.fs.readText(this.fs.join(root, csproj));
    const assembly = xml.match(/<AssemblyName>([^<]+)</)?.[1] ?? csproj.replace(/\.[cf]sproj$/, '');
    const version = xml.match(/<TargetFramework>net(\d+\.\d+)</)?.[1] ?? '8.0';
    const web = /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(xml);

    return {
      profile: {
        rootDir: root,
        language: 'dotnet',
        framework: web ? 'aspnetcore' : undefined,
        kind: 'server',
        packageManager: 'dotnet',
        runtimeVersion: version,
        buildCommand: 'dotnet publish -c Release -o out',
        startCommand: `dotnet ${assembly}.dll`,
        port: 8080,
        hasDockerfile: await hasDockerfile(this.fs, root),
        meta: { name: assembly, assembly, projectFile: csproj },
      },
      confidence: web ? 85 : 70,
    };
  }
}
