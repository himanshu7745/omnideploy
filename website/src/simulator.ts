import type { Line, Scenario } from './scenarios.js';

const SPINNER = ['◒', '◐', '◓', '◑'];

export interface TerminalHooks {
  /** A generated file has just been "written". */
  onReveal?: (path: string) => void;
  onDone?: (scenario: Scenario) => void;
}

/**
 * A fake terminal that plays a Scenario line by line.
 * Every wait goes through `sleep`, so `skip()` (or reduced motion)
 * finishes the current run instantly instead of re-rendering.
 */
export class Terminal {
  private run = 0;
  private instant = false;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private readonly screen: HTMLElement,
    private readonly hooks: TerminalHooks = {},
  ) {}

  async play(scenario: Scenario): Promise<void> {
    const id = ++this.run;
    this.instant = this.reducedMotion.matches;
    this.screen.replaceChildren();
    this.screen.dataset.state = 'running';

    let cwd = '~';
    for (const line of scenario.lines) {
      if (id !== this.run) return;
      if (line.type === 'cmd') {
        await this.typeCommand(id, cwd, line.text);
        const cd = /^cd (.+)$/.exec(line.text);
        if (cd) cwd = `~/${cd[1]}`;
      } else if (line.type === 'spin') {
        await this.spin(id, line);
      } else {
        await this.sleep(line.pause ?? 40 + Math.random() * 60);
        if (id !== this.run) return;
        this.print(line.text, line.tone ?? 'plain');
        if (line.reveals) this.hooks.onReveal?.(line.reveals);
      }
    }
    if (id !== this.run) return;
    this.prompt(cwd).append(this.cursor());
    this.screen.dataset.state = 'done';
    this.hooks.onDone?.(scenario);
  }

  /** Finish the current animation immediately. */
  skip(): void {
    this.instant = true;
  }

  private async typeCommand(id: number, cwd: string, text: string): Promise<void> {
    const row = this.prompt(cwd);
    const typed = document.createElement('span');
    typed.className = 't-cmd';
    const cursor = this.cursor();
    row.append(typed, cursor);
    await this.sleep(350);
    for (const ch of text) {
      if (id !== this.run) return;
      typed.textContent += ch;
      // Humans type in bursts: quick runs, the odd hesitation after a space.
      await this.sleep(ch === ' ' ? 90 + Math.random() * 120 : 28 + Math.random() * 45);
    }
    await this.sleep(260);
    cursor.remove();
  }

  private async spin(id: number, line: Extract<Line, { type: 'spin' }>): Promise<void> {
    const row = this.print(`${SPINNER[0]}  ${line.text}`, 'step');
    const start = performance.now();
    let frame = 0;
    while (!this.instant && performance.now() - start < line.ms) {
      await this.sleep(90);
      if (id !== this.run) return;
      frame = (frame + 1) % SPINNER.length;
      row.textContent = `${SPINNER[frame]}  ${line.text}${'.'.repeat(Math.floor(frame / 1.5))}`;
    }
    row.textContent = line.done;
    row.className = `t-line t-${line.tone ?? 'ok'}`;
    this.scroll();
  }

  private prompt(cwd: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 't-line';
    const ps1 = document.createElement('span');
    ps1.className = 't-ps1';
    ps1.textContent = `${cwd} $ `;
    row.append(ps1);
    this.screen.append(row);
    this.scroll();
    return row;
  }

  private print(text: string, tone: string): HTMLElement {
    const row = document.createElement('div');
    row.className = `t-line t-${tone}`;
    row.textContent = text || ' ';
    this.screen.append(row);
    this.scroll();
    return row;
  }

  private cursor(): HTMLElement {
    const c = document.createElement('span');
    c.className = 't-cursor';
    c.setAttribute('aria-hidden', 'true');
    return c;
  }

  private scroll(): void {
    this.screen.scrollTop = this.screen.scrollHeight;
  }

  private sleep(ms: number): Promise<void> {
    if (this.instant) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
