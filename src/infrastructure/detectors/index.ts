import type { FileSystemPort, ProjectDetector } from '../../domain/index.js';
import { DockerDetector } from './DockerDetector.js';
import { DotnetDetector } from './DotnetDetector.js';
import { GoDetector } from './GoDetector.js';
import { JavaDetector } from './JavaDetector.js';
import { NodeDetector } from './NodeDetector.js';
import { PhpDetector } from './PhpDetector.js';
import { PythonDetector } from './PythonDetector.js';
import { RubyDetector } from './RubyDetector.js';
import { RustDetector } from './RustDetector.js';
import { StaticDetector } from './StaticDetector.js';

export function builtInDetectors(fs: FileSystemPort): ProjectDetector[] {
  return [
    new NodeDetector(fs),
    new PythonDetector(fs),
    new JavaDetector(fs),
    new GoDetector(fs),
    new RustDetector(fs),
    new RubyDetector(fs),
    new PhpDetector(fs),
    new DotnetDetector(fs),
    new StaticDetector(fs),
    new DockerDetector(fs),
  ];
}
