import { buildScenario, PROJECTS, PROVIDERS, provider, type GeneratedFile, type ProjectId, type ProviderId, type Scenario } from './scenarios.js';
import { Terminal } from './simulator.js';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

/* ---------- simulator ---------- */

const state: { project: ProjectId; provider: ProviderId } = { project: 'spring', provider: 'render' };
let files: GeneratedFile[] = [];
let shown = new Set<string>();
let active = '';
let blocked = false;

const sim = $('#sim');
const screen = $('#sim-screen', sim);
const filesTabs = $('#sim-files-tabs', sim);
const filesBody = $('#sim-files-body', sim);
const verdict = $('#sim-verdict', sim);

const terminal = new Terminal(screen, {
  onReveal(path) {
    shown.add(path);
    active = path;
    renderFiles();
  },
  onDone: showVerdict,
});

function pills(container: HTMLElement, items: { id: string; label: string }[], current: () => string, pick: (id: string) => void) {
  container.replaceChildren(
    ...items.map((item) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill';
      b.textContent = item.label;
      b.dataset.id = item.id;
      b.addEventListener('click', () => {
        pick(item.id);
        play();
      });
      return b;
    }),
  );
  return () => {
    for (const b of container.querySelectorAll<HTMLButtonElement>('.pill')) {
      b.setAttribute('aria-pressed', String(b.dataset.id === current()));
    }
  };
}

const syncProjects = pills(
  $('#pick-project', sim),
  PROJECTS.map((p) => ({ id: p.id, label: p.label })),
  () => state.project,
  (id) => (state.project = id as ProjectId),
);
const syncProviders = pills(
  $('#pick-provider', sim),
  PROVIDERS.map((p) => ({ id: p.id, label: p.name })),
  () => state.provider,
  (id) => (state.provider = id as ProviderId),
);

function renderFiles() {
  const visible = files.filter((f) => shown.has(f.path));
  if (!visible.length) {
    filesTabs.replaceChildren();
    filesBody.textContent = '';
    filesBody.dataset.empty = screen.dataset.state !== 'done' ? 'waiting' : blocked ? 'blocked' : 'none';
    return;
  }
  delete filesBody.dataset.empty;
  filesTabs.replaceChildren(
    ...visible.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'file-tab';
      b.textContent = f.path;
      b.setAttribute('aria-selected', String(f.path === active));
      b.addEventListener('click', () => {
        active = f.path;
        renderFiles();
      });
      return b;
    }),
  );
  const current = visible.find((f) => f.path === active) ?? visible[0]!;
  filesBody.textContent = current.contents;
}

function showVerdict(s: Scenario) {
  renderFiles();
  verdict.replaceChildren();
  if (s.ok || !s.suggestion) return;
  const alt = provider(s.suggestion);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-button';
  b.textContent = `Fine — deploy it to ${alt.name} instead →`;
  b.addEventListener('click', () => {
    state.provider = alt.id;
    play();
  });
  verdict.append(b);
}

function play() {
  syncProjects();
  syncProviders();
  const scenario = buildScenario(state.project, state.provider);
  files = scenario.files;
  blocked = !scenario.ok;
  shown = new Set();
  active = '';
  verdict.replaceChildren();
  renderFiles();
  void terminal.play(scenario);
}

$('#sim-replay', sim).addEventListener('click', play);
$('#sim-skip', sim).addEventListener('click', () => terminal.skip());

// Start when the terminal is actually on screen, not while someone reads the header.
new IntersectionObserver(
  (entries, obs) => {
    if (entries.some((e) => e.isIntersecting)) {
      obs.disconnect();
      play();
    }
  },
  { threshold: 0.3 },
).observe(screen);

/* ---------- tabs (quick start) ---------- */

for (const group of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
  const tabs = [...group.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')!)!.hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length]!;
      next.focus();
      select(next);
    });
  });
}

/* ---------- copy buttons ---------- */

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.copy!);
    const text = (target?.innerText ?? '').replace(/^\$ /gm, '').trim();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'copied';
    } catch {
      btn.textContent = 'press ⌘C';
    }
    setTimeout(() => (btn.textContent = 'copy'), 1400);
  });
}
