import type { ProjectProfile } from '../entities/ProjectProfile.js';

export interface DetectionResult {
  profile: ProjectProfile;
  /** 0–100. The highest-confidence result wins. */
  confidence: number;
}

/** Recognises one language/ecosystem. Return null when the project is not of this kind. */
export interface ProjectDetector {
  readonly id: string;
  detect(rootDir: string): Promise<DetectionResult | null>;
}
