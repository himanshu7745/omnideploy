import { XMLParser } from 'fast-xml-parser';
import type { DetectionResult, FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { extractVersion, hasDockerfile } from './support.js';

const JVM_FRAMEWORKS: Array<[marker: RegExp, framework: string]> = [
  [/spring-boot|org\.springframework\.boot/, 'spring-boot'],
  [/io\.quarkus/, 'quarkus'],
  [/io\.micronaut/, 'micronaut'],
];

/** System property each framework reads to choose its HTTP port. */
const PORT_PROPERTY: Record<string, string> = {
  'spring-boot': 'server.port',
  quarkus: 'quarkus.http.port',
  micronaut: 'micronaut.server.port',
};

export class JavaDetector implements ProjectDetector {
  readonly id = 'java';
  constructor(private readonly fs: FileSystemPort) {}

  async detect(root: string): Promise<DetectionResult | null> {
    const read = (f: string) => this.fs.readTextIfExists(this.fs.join(root, f));
    const pom = await read('pom.xml');
    const gradle = (await read('build.gradle.kts')) ?? (await read('build.gradle'));
    if (pom === null && gradle === null) return null;

    const buildTool = pom !== null ? 'maven' : 'gradle';
    const source = pom ?? gradle!;
    const framework = JVM_FRAMEWORKS.find(([re]) => re.test(source))?.[1];
    const hasWrapper = await this.fs.exists(this.fs.join(root, buildTool === 'maven' ? 'mvnw' : 'gradlew'));

    let name = '';
    let javaVersion: string | undefined;
    if (pom !== null) {
      const project = new XMLParser({ ignoreAttributes: true }).parse(pom)?.project ?? {};
      name = String(project.artifactId ?? '');
      const props = project.properties ?? {};
      javaVersion = extractVersion(String(props['java.version'] ?? props['maven.compiler.release'] ?? props['maven.compiler.source'] ?? ''), 1);
    } else {
      javaVersion =
        extractVersion(gradle!.match(/JavaLanguageVersion\.of\((\d+)\)/)?.[1], 1) ??
        extractVersion(gradle!.match(/VERSION_(\d+)/)?.[1], 1) ??
        extractVersion(gradle!.match(/sourceCompatibility\s*=\s*['"]?([\d.]+)/)?.[1], 1);
      const settings = (await read('settings.gradle.kts')) ?? (await read('settings.gradle'));
      name = settings?.match(/rootProject\.name\s*=\s*['"]([^'"]+)/)?.[1] ?? '';
    }
    // Java 1.8 → 8
    if (javaVersion === '1') javaVersion = '8';
    const runtimeVersion = javaVersion ?? '21';

    const tool = buildTool === 'maven' ? (hasWrapper ? './mvnw' : 'mvn') : hasWrapper ? './gradlew' : 'gradle';
    const buildCommand =
      buildTool === 'maven'
        ? `${tool} -B -DskipTests package`
        : `${tool} ${framework === 'spring-boot' ? 'bootJar' : 'build'} -x test --no-daemon`;
    const portProp = framework ? PORT_PROPERTY[framework] : undefined;

    return {
      profile: {
        rootDir: root,
        language: 'java',
        framework,
        kind: 'server',
        runtimeVersion,
        packageManager: buildTool,
        buildCommand,
        startCommand: `java ${portProp ? `-D${portProp}=$PORT ` : ''}-jar app.jar`,
        port: 8080,
        hasDockerfile: await hasDockerfile(this.fs, root),
        meta: {
          name,
          buildTool,
          wrapper: String(hasWrapper),
          jarDir: buildTool === 'maven' ? 'target' : 'build/libs',
          portProperty: portProp ?? '',
          quarkus: String(framework === 'quarkus'),
        },
      },
      confidence: 85,
    };
  }
}
