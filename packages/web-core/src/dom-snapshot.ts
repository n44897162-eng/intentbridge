/**
 * DOM observation helpers that run inside the page.
 *
 * Both the recorder and the executor use exactly this snapshot code, so the
 * anchors a flow is recorded with are the anchors the engine later matches.
 * The function must stay self-contained: it is serialized into the page by
 * Playwright and by the MV3 content script.
 */
import type { Candidate } from '@intentbridge/protocol';

export interface PageCandidate extends Candidate {
  /** Frame selector chain, empty for the main frame. */
  frame_path?: string[];
}

export interface SnapshotResult {
  url: string;
  title: string;
  origin: string;
  candidates: PageCandidate[];
  /** candidate_id -> locator metadata (not part of the engine protocol). */
  index: Record<string, { frame_path: string[]; selector: string }>;
  window_stable_ms: number;
  now: number;
  viewport: { w: number; h: number };
  device_scale: number;
}

export interface RecorderEvent {
  type: 'click' | 'input' | 'select';
  candidate: PageCandidate;
  value?: string;
  password: boolean;
  url: string;
  title: string;
  taken_at: number;
  after?: {
    url: string;
    testIds: string[];
    candidates_by_testid: Record<string, PageCandidate>;
  };
}

export function installHelpersInPage(): void {
  const root = window as unknown as Record<string, any>;
  if (root.__ibHelpers && root.__ibHelpers.version === 1) return;

  let lastMutation = performance.now();
  try {
    new MutationObserver((mutations) => {
      // Our own candidate markers must not count as application changes.
      const meaningful = mutations.some(
        (mutation) =>
          mutation.type !== 'attributes' || !(mutation.attributeName ?? '').startsWith('data-ib-'),
      );
      if (meaningful) lastMutation = performance.now();
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  } catch {
    /* document may not be ready; stability falls back to 0 */
  }

  const KEEP_TAGS = new Set([
    'MAIN',
    'FORM',
    'NAV',
    'HEADER',
    'FOOTER',
    'DIALOG',
    'TABLE',
    'UL',
    'OL',
    'SECTION',
  ]);

  function hash(text: string): string {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(36);
  }

  function cssEscape(value: string): string {
    const api = (window as unknown as { CSS?: { escape?: (input: string) => string } }).CSS;
    if (api?.escape) return api.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }

  function isVisible(element: Element): boolean {
    const candidate = element as HTMLElement & {
      checkVisibility?: (options?: Record<string, boolean>) => boolean;
    };
    if (typeof candidate.checkVisibility === 'function') {
      try {
        if (
          !candidate.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          } as Record<string, boolean>)
        ) {
          return false;
        }
      } catch {
        /* older engines: fall through to geometry */
      }
    }
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isEnabled(element: Element): boolean {
    if (element.hasAttribute('disabled')) return false;
    if ((element as HTMLElement).getAttribute('aria-disabled') === 'true') return false;
    if (element.closest('[aria-disabled="true"]')) return false;
    return true;
  }

  function isEditable(element: Element): boolean {
    if ((element as HTMLElement).isContentEditable) return true;
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (element instanceof HTMLInputElement) {
      const type = (element.type || 'text').toLowerCase();
      return (
        !element.disabled &&
        !element.readOnly &&
        ['text', 'search', 'email', 'password', 'number', 'tel', 'url', ''].includes(type)
      );
    }
    return false;
  }

  function roleOf(element: Element): string {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    const input = element as HTMLInputElement;
    switch (tag) {
      case 'button':
        return 'button';
      case 'a':
        return element.hasAttribute('href') ? 'link' : 'generic';
      case 'input': {
        const type = (input.type || 'text').toLowerCase();
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (['text', 'search', 'email', 'tel', 'url', 'password', 'number', ''].includes(type)) {
          return 'textbox';
        }
        return 'textbox';
      }
      case 'textarea':
        return 'textbox';
      case 'select':
        return 'combobox';
      case 'form':
        return 'form';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'header':
        return 'banner';
      case 'footer':
        return 'contentinfo';
      case 'dialog':
        return 'dialog';
      case 'ul':
      case 'ol':
        return 'list';
      case 'li':
        return 'listitem';
      case 'table':
        return 'table';
      case 'img':
        return 'img';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'output':
        return 'status';
      default:
        return 'generic';
    }
  }

  function textOf(element: Element, max = 500): string {
    const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
    return text.replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function labelOf(element: Element): string | undefined {
    const id = element.getAttribute('id');
    if (id) {
      const labels = document.querySelectorAll(`label[for="${cssEscape(id)}"]`);
      if (labels.length > 0) return textOf(labels[0] as Element);
    }
    const wrapping = element.closest('label');
    if (wrapping) return textOf(wrapping);
    return undefined;
  }

  function accessibleName(element: Element): string | undefined {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => textOf(node as Element))
        .filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }
    const label = labelOf(element);
    if (label) return label;
    const placeholder = element.getAttribute('placeholder');
    if (
      placeholder &&
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    ) {
      return placeholder;
    }
    if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement) {
      const text = textOf(element);
      if (text) return text;
    }
    const title = element.getAttribute('title');
    if (title) return title;
    if (element.tagName === 'IMG') return element.getAttribute('alt') ?? undefined;
    const text = textOf(element, 120);
    return text || undefined;
  }

  function tokenOf(element: Element): string {
    const tag = element.tagName.toLowerCase();
    const id = element.getAttribute('id');
    if (id) return `${tag}#${id}`;
    const testId = element.getAttribute('data-testid');
    if (testId) return `${tag}[data-testid="${testId}"]`;
    const className = (element.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name && !name.startsWith('ib-'))
      .map((name) => name.replace(/[^a-zA-Z0-9_-]/g, '-'))
      .slice(0, 1)
      .join('');
    if (className) return `${tag}.${className}`;
    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (item) => item.tagName === element.tagName,
      );
      if (siblings.length > 1) {
        return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
      }
    }
    return tag;
  }

  function pathOf(element: Element): string[] {
    const tokens: string[] = [];
    let node: Element | null = element;
    while (node && node !== document.documentElement && node !== document.body) {
      const id = node.getAttribute('id');
      const testId = node.getAttribute('data-testid');
      if (id || testId || KEEP_TAGS.has(node.tagName)) tokens.unshift(tokenOf(node));
      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }
      const rootNode = node.getRootNode();
      if (rootNode instanceof ShadowRoot) {
        // Include the host chain so two identical components produce distinct
        // candidate signatures/selectors.
        node = rootNode.host;
        continue;
      }
      break;
    }
    return tokens.slice(-8);
  }

  function siblingInfo(element: Element): { index: number; count: number } {
    const parent = element.parentElement;
    if (!parent) return { index: 0, count: 1 };
    const siblings = Array.from(parent.children).filter((item) => item.tagName === element.tagName);
    return { index: Math.max(0, siblings.indexOf(element)), count: siblings.length };
  }

  function candidateFor(element: Element, mark = true, framePath: string[] = []): PageCandidate {
    const rect = element.getBoundingClientRect();
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const testId = element.getAttribute('data-testid') ?? undefined;
    const id = element.getAttribute('id') ?? undefined;
    const role = roleOf(element);
    const name = accessibleName(element);
    const label = labelOf(element);
    const placeholder = element.getAttribute('placeholder') ?? undefined;
    const sibling = siblingInfo(element);
    const signature = [
      framePath.join('>'),
      pathOf(element).join('>'),
      testId ?? '',
      id ?? '',
      role,
      name ?? '',
      element.tagName,
      String(sibling.index),
    ].join('|');
    const candidateId = `c-${hash(signature)}`;
    if (mark) {
      try {
        element.setAttribute('data-ib-candidate', candidateId);
      } catch {
        /* read-only DOM nodes are ignored */
      }
    }
    const inViewport =
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    const candidate: PageCandidate = {
      candidate_id: candidateId,
      native_identity: testId
        ? { kind: 'web-test-id', value: testId }
        : id
          ? { kind: 'web-dom-id', value: id }
          : undefined,
      semantic: {
        role,
        ...(name ? { name } : {}),
        ...(label ? { label } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(testId ? { test_id: testId } : {}),
        control_type: `${element.tagName.toLowerCase()}${element instanceof HTMLInputElement ? `:${element.type}` : ''}`,
        ...(textOf(element, 500) ? { text: textOf(element, 500) } : {}),
      },
      structure: {
        path: pathOf(element),
        ...(element.parentElement ? { parent: tokenOf(element.parentElement) } : {}),
        ...(element.closest('form,main,[role="dialog"],section')
          ? { container: tokenOf(element.closest('form,main,[role="dialog"],section') as Element) }
          : {}),
        sibling_index: sibling.index,
        sibling_count: sibling.count,
      },
      visual: {
        norm_rect: {
          x: rect.left / Math.max(1, viewport.w),
          y: rect.top / Math.max(1, viewport.h),
          w: rect.width / Math.max(1, viewport.w),
          h: rect.height / Math.max(1, viewport.h),
        },
        viewport,
        device_scale: window.devicePixelRatio || 1,
      },
      context: {
        app_scope: location.origin,
        window_title: document.title,
        url: location.href,
      },
      visible: true,
      enabled: isEnabled(element),
      editable: isEditable(element),
      in_viewport: inViewport,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      text: textOf(element, 1000) || undefined,
    };
    if (framePath.length > 0) candidate.frame_path = framePath;
    return candidate;
  }

  function collectFromDocument(
    doc: Document,
    framePath: string[],
    output: PageCandidate[],
    max: number,
    depth: number,
  ): void {
    const elements: Element[] = [];
    const walk = (rootNode: Document | ShadowRoot): void => {
      const walker = doc.createTreeWalker(rootNode as Node, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const element = node as Element;
        elements.push(element);
        if ((element as HTMLElement).shadowRoot)
          walk((element as HTMLElement).shadowRoot as ShadowRoot);
        node = walker.nextNode();
      }
    };
    try {
      walk(doc);
    } catch {
      return;
    }
    for (const element of elements) {
      if (output.length >= max) break;
      if (
        ['HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'NOSCRIPT'].includes(
          element.tagName,
        )
      ) {
        continue;
      }
      if (!isVisible(element)) continue;
      output.push(candidateFor(element, true, framePath));
    }
    if (depth >= 2) return;
    for (const iframe of Array.from(doc.querySelectorAll('iframe'))) {
      if (output.length >= max) break;
      let subDocument: Document | null = null;
      try {
        subDocument = iframe.contentDocument;
        void iframe.contentWindow?.location.href;
      } catch {
        subDocument = null;
      }
      if (!subDocument) continue;
      const frameId = `f-${hash(`${framePath.join('>')}|${iframe.getAttribute('src') ?? ''}|${iframe.getAttribute('id') ?? ''}`)}`;
      try {
        iframe.setAttribute('data-ib-frame', frameId);
      } catch {
        continue;
      }
      collectFromDocument(
        subDocument,
        [...framePath, `iframe[data-ib-frame="${frameId}"]`],
        output,
        max,
        depth + 1,
      );
    }
  }

  function snapshot(args?: { max?: number }): SnapshotResult {
    const max = Math.min(800, Math.max(20, args?.max ?? 400));
    const candidates: PageCandidate[] = [];
    const index: SnapshotResult['index'] = {};
    collectFromDocument(document, [], candidates, max, 0);
    for (const candidate of candidates) {
      index[candidate.candidate_id] = {
        frame_path: candidate.frame_path ?? [],
        selector: `[data-ib-candidate="${candidate.candidate_id}"]`,
      };
    }
    return {
      url: location.href,
      title: document.title,
      origin: location.origin,
      candidates,
      index,
      window_stable_ms: Math.max(0, performance.now() - lastMutation),
      now: performance.now(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      device_scale: window.devicePixelRatio || 1,
    };
  }

  function clearRoot(root: Document | ShadowRoot | HTMLElement): void {
    for (const element of Array.from(root.querySelectorAll('[data-ib-candidate]'))) {
      element.removeAttribute('data-ib-candidate');
    }
    for (const element of Array.from(root.querySelectorAll('*'))) {
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow) clearRoot(shadow);
    }
  }

  function clearMarkers(): void {
    clearRoot(document);
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      try {
        if (frame.contentDocument) clearRoot(frame.contentDocument);
      } catch {
        /* cross-origin */
      }
    }
  }

  root.__ibHelpers = {
    version: 1,
    snapshot,
    candidateFor,
    clearMarkers,
    stableMs: () => Math.max(0, performance.now() - lastMutation),
  };
  try {
    if (window.sessionStorage.getItem('__ibRecorderState')) installRecorderInPage();
  } catch {
    /* storage can be unavailable in sandboxed documents */
  }
}

export function installRecorderInPage(options: { reset?: boolean } = {}): void {
  const root = window as unknown as Record<string, any>;

  function installRecorderListeners(root: Record<string, any>): void {
    if (root.__ibRecorderListeners) return;
    const record = (type: 'click' | 'input' | 'select', target: Element | null): void => {
      const recorder = root.__ibRecorder;
      const helpers = root.__ibHelpers;
      if (!recorder?.active || !target) return;
      if (recorder.events.length >= 200) {
        recorder.warnings.push('recording event limit reached; recording paused');
        recorder.active = false;
        return;
      }
      const isPassword = (() => {
        if (!(target instanceof HTMLInputElement)) return false;
        const type = (target.type || '').toLowerCase();
        return (
          type === 'password' ||
          (target.getAttribute('autocomplete') ?? '').toLowerCase().includes('password')
        );
      })();
      if (isPassword) recorder.warnings.push('password-like field was not recorded');
      let candidate: PageCandidate;
      try {
        candidate = helpers.candidateFor(target, true) as PageCandidate;
      } catch {
        recorder.warnings.push('could not snapshot an event target');
        return;
      }
      const value =
        (type === 'input' || type === 'select') &&
        !isPassword &&
        (target as HTMLInputElement).value !== undefined
          ? String((target as HTMLInputElement).value)
          : undefined;
      const event: RecorderEvent = {
        type,
        candidate,
        ...(value !== undefined ? { value } : {}),
        password: isPassword,
        url: location.href,
        title: document.title,
        taken_at: performance.now() - recorder.started_at,
      };
      recorder.events.push(event);
      try {
        window.sessionStorage.setItem(
          '__ibRecorderState',
          JSON.stringify({
            version: 1,
            active: recorder.active,
            events: recorder.events,
            warnings: recorder.warnings,
            started_at_wall: Date.now() - (performance.now() - recorder.started_at),
          }),
        );
      } catch {
        /* ignore */
      }
      const captureAfter = (recorded: RecorderEvent): void => {
        window.setTimeout(() => {
          try {
            const afterSnapshot = helpers.snapshot({ max: 400 });
            recorded.after = {
              url: location.href,
              testIds: afterSnapshot.candidates
                .map((item: PageCandidate) => item.semantic?.test_id)
                .filter((item: string | undefined): item is string => Boolean(item)),
              candidates_by_testid: Object.fromEntries(
                afterSnapshot.candidates
                  .filter((item: PageCandidate) => item.semantic?.test_id)
                  .map((item: PageCandidate) => [item.semantic!.test_id!, item]),
              ),
            };
            try {
              window.sessionStorage.setItem(
                '__ibRecorderState',
                JSON.stringify({
                  version: 1,
                  active: recorder.active,
                  events: recorder.events,
                  warnings: recorder.warnings,
                  started_at_wall: Date.now() - (performance.now() - recorder.started_at),
                }),
              );
            } catch {
              /* ignore */
            }
          } catch {
            /* snapshot failure is non-fatal */
          }
        }, 320);
      };
      captureAfter(event);
    };
    root.__ibRecorderListeners = {
      click: (event: Event) => record('click', event.target as Element),
      change: (event: Event) => {
        const target = event.target as Element;
        if (target instanceof HTMLSelectElement) {
          record('select', target);
          return;
        }
        if (
          target instanceof HTMLInputElement &&
          (target.type === 'checkbox' || target.type === 'radio')
        ) {
          return;
        }
        record('input', target);
      },
    };
    window.addEventListener('click', root.__ibRecorderListeners.click, true);
    window.addEventListener('change', root.__ibRecorderListeners.change, true);
  }

  if (root.__ibRecorder) return;
  const helpers = root.__ibHelpers;
  if (!helpers) throw new Error('snapshot helpers must be installed before the recorder');
  const STORAGE_KEY = '__ibRecorderState';
  if (options.reset) {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  let restored: Record<string, any> | null = null;
  if (!options.reset) {
    try {
      restored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Record<
        string,
        any
      > | null;
    } catch {
      restored = null;
    }
  }
  if (restored?.active && Array.isArray(restored.events)) {
    const elapsed = Date.now() - Number(restored.started_at_wall ?? Date.now());
    root.__ibRecorder = {
      ...restored,
      active: true,
      started_at: performance.now() - Math.max(0, elapsed),
    };
    installRecorderListeners(root);
    return;
  }

  const recorder = {
    version: 1,
    active: true,
    events: [] as RecorderEvent[],
    started_at: performance.now(),
    warnings: [] as string[],
  };
  root.__ibRecorder = recorder;

  const persist = (): void => {
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          active: recorder.active,
          events: recorder.events,
          warnings: recorder.warnings,
          started_at_wall: Date.now() - (performance.now() - recorder.started_at),
        }),
      );
    } catch {
      // Quota errors must not break the page; events stay in memory.
    }
  };
  persist();

  const isPasswordField = (element: Element): boolean => {
    if (!(element instanceof HTMLInputElement)) return false;
    const type = (element.type || '').toLowerCase();
    const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase();
    return (
      type === 'password' ||
      autocomplete.includes('password') ||
      autocomplete === 'one-time-code' ||
      /pass(word|wd)?|密码/i.test(element.getAttribute('aria-label') ?? '')
    );
  };

  const captureAfter = (event: RecorderEvent): void => {
    window.setTimeout(() => {
      try {
        const snap = helpers.snapshot({ max: 300 }) as SnapshotResult;
        const testIds: string[] = [];
        const candidatesByTestId: Record<string, PageCandidate> = {};
        for (const candidate of snap.candidates) {
          const testId = candidate.semantic?.test_id;
          if (testId) {
            testIds.push(testId);
            candidatesByTestId[testId] = candidate;
          }
        }
        event.after = { url: snap.url, testIds, candidates_by_testid: candidatesByTestId };
      } catch (error) {
        recorder.warnings.push(`after-snapshot failed: ${String(error)}`);
      }
    }, 320);
  };

  const record = (type: 'click' | 'input' | 'select', target: Element | null): void => {
    if (!recorder.active || !target) return;
    if (recorder.events.length >= 200) {
      recorder.warnings.push('recording event limit reached; recording paused');
      recorder.active = false;
      return;
    }
    const password = isPasswordField(target);
    if (password) {
      recorder.warnings.push('password-like field was not recorded');
    }
    let candidate: PageCandidate;
    try {
      candidate = helpers.candidateFor(target, true) as PageCandidate;
    } catch {
      recorder.warnings.push('could not snapshot an event target');
      return;
    }
    const value =
      (type === 'input' || type === 'select') &&
      !password &&
      (target as HTMLInputElement).value !== undefined
        ? String((target as HTMLInputElement).value)
        : undefined;
    const event: RecorderEvent = {
      type,
      candidate,
      ...(value !== undefined ? { value } : {}),
      password,
      url: location.href,
      title: document.title,
      taken_at: performance.now() - recorder.started_at,
    };
    recorder.events.push(event);
    persist();
    captureAfter(event);
  };

  installRecorderListeners(root);
  root.__ibPersist = persist;
  window.addEventListener('pagehide', persist);
}

export async function stopRecorderInPage(): Promise<{
  events: RecorderEvent[];
  warnings: string[];
  started_at: number;
  stopped_at: number;
}> {
  const root = window as unknown as Record<string, any>;
  let recorder = root.__ibRecorder;
  if (!recorder) {
    try {
      const stored = JSON.parse(
        window.sessionStorage.getItem('__ibRecorderState') ?? 'null',
      ) as Record<string, any> | null;
      if (stored?.active && Array.isArray(stored.events)) {
        recorder = { ...stored, active: false };
      }
    } catch {
      /* ignore */
    }
  }
  if (!recorder) throw new Error('no active recorder');
  // Flush a still-focused field while listeners are still active so its final
  // change is part of the recording.
  try {
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  } catch {
    /* ignore */
  }
  recorder.active = false;
  if (root.__ibRecorderListeners) {
    window.removeEventListener('click', root.__ibRecorderListeners.click, true);
    window.removeEventListener('change', root.__ibRecorderListeners.change, true);
    delete root.__ibRecorderListeners;
  }
  if (root.__ibPersist) {
    window.removeEventListener('pagehide', root.__ibPersist);
    delete root.__ibPersist;
  }
  // Allow the last after-snapshots to settle without blocking the page.
  await new Promise((resolve) => window.setTimeout(resolve, 420));
  const result = {
    events: recorder.events as RecorderEvent[],
    warnings: (recorder.warnings ?? []) as string[],
    started_at: recorder.started_at as number,
    stopped_at: performance.now(),
  };
  // Read the final events from storage as well: the page may have navigated
  // since the in-memory recorder was created.
  try {
    const stored = JSON.parse(
      window.sessionStorage.getItem('__ibRecorderState') ?? 'null',
    ) as Record<string, any> | null;
    if (
      stored?.active &&
      Array.isArray(stored.events) &&
      stored.events.length > result.events.length
    ) {
      result.events = stored.events as RecorderEvent[];
      result.warnings = (stored.warnings ?? result.warnings) as string[];
    }
    window.sessionStorage.removeItem('__ibRecorderState');
  } catch {
    /* ignore */
  }
  delete root.__ibRecorder;
  return result;
}
