export const LANGUAGES = [
  'node',
  'python',
  'java',
  'go',
  'rust',
  'ruby',
  'php',
  'dotnet',
  'static',
  'docker',
] as const;

/** The primary runtime of a project. `docker` means "a Dockerfile defines the runtime". */
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<Language, string> = {
  node: 'Node.js',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  php: 'PHP',
  dotnet: '.NET',
  static: 'Static site',
  docker: 'Docker',
};
