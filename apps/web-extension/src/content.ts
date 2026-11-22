/**
 * MV3 content script: DOM observation, recording and DOM-level actions.
 * It is injected only on the tab the user explicitly activates.
 */
import {
  installHelpersInPage,
  installRecorderInPage,
  stopRecorderInPage,
  type ActionRequest,
  type Recording,
} from '@intentbridge/web-core';

type SnapshotFn = (args?: { max?: number }) => unknown;

interface Installed {
  version: number;
}

(() => {
  const root = window as unknown as Record<string, any>;
  if (root.__ibExtensionContent?.version === 1) return;
  root.__ibExtensionContent = { version: 1 } satisfies Installed;

  installHelpersInPage();

  function helpers(): {
    snapshot: SnapshotFn;
    candidateFor: (element: Element) => unknown;
    clearMarkers: () => void;
    stableMs: () => number;
  } {
    const api = root.__ibHelpers;
    if (!api) throw new Error('snapshot helpers missing');
    return api;
  }

  function cssEscape(value: string): string {
    const css = (window as unknown as { CSS?: { escape?: (input: string) => string } }).CSS;
    if (css?.escape) return css.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }

  function deepFind(rootNode: Document | ShadowRoot, candidateId: string): Element | null {
    const selector = `[data-ib-candidate="${cssEscape(candidateId)}"]`;
    const direct = rootNode.querySelector(selector);
    if (direct) return direct;
    for (const element of Array.from(rootNode.querySelectorAll('*'))) {
      const shadow = (element as HTMLElement).shadowRoot;
      if (shadow) {
        const found = deepFind(shadow, candidateId);
        if (found) return found;
      }
    }
    return null;
  }

  function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function performAct(request: ActionRequest): {
    text?: string;
    error?: { code: string; message: string };
  } {
    if (!request.candidate_id) {
      return { error: { code: 'TARGET_NOT_FOUND', message: 'no candidate id' } };
    }
    const element = deepFind(document, request.candidate_id);
    if (!element) {
      return { error: { code: 'STALE_TARGET', message: 'candidate is no longer attached' } };
    }
    const action = request.action;
    try {
      if (action === 'click') {
        (element as HTMLElement).click();
        return {};
      }
      if (action === 'input') {
        const field = element as HTMLInputElement | HTMLTextAreaElement;
        if (field.disabled || (field as HTMLInputElement).readOnly) {
          return { error: { code: 'PRECONDITION_FAILED', message: 'field is not editable' } };
        }
        field.focus();
        const incoming = String(request.params['value'] ?? '');
        const next =
          request.params['clear_first'] === false ? `${field.value}${incoming}` : incoming;
        setInputValue(field, next);
        if (request.params['submit'] === true) {
          if (field.form) field.form.requestSubmit();
          else
            field.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
            );
        }
        return {};
      }
      if (action === 'select') {
        const select = element as HTMLSelectElement;
        const by = String(request.params['by'] ?? 'value');
        const raw = String(request.params['value'] ?? '');
        let option: HTMLOptionElement | undefined;
        if (by === 'label') {
          option = Array.from(select.options).find(
            (item) => (item.label || item.textContent || '').trim() === raw,
          );
        } else if (by === 'index') {
          option = select.options.item(Number(raw)) ?? undefined;
        } else {
          option = Array.from(select.options).find((item) => item.value === raw);
        }
        if (!option) {
          return { error: { code: 'PRECONDITION_FAILED', message: 'select option not found' } };
        }
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return {};
      }
      if (action === 'scroll') {
        const direction = String(request.params['direction'] ?? 'down');
        const amount = Number(request.params['amount'] ?? 600);
        const signed = direction === 'up' || direction === 'left' ? -amount : amount;
        element.scrollIntoView({ block: 'center' });
        if (direction === 'left' || direction === 'right') window.scrollBy(signed, 0);
        else window.scrollBy(0, signed);
        return {};
      }
      if (action === 'read-text') {
        const field = element as HTMLInputElement;
        const text =
          typeof field.value === 'string' && field.tagName !== 'BUTTON'
            ? field.value
            : ((element as HTMLElement).innerText ?? element.textContent ?? '');
        return { text: String(text).slice(0, Number(request.params['max_chars'] ?? 10_000)) };
      }
      return { error: { code: 'UNSUPPORTED_CAPABILITY', message: `unsupported action ${action}` } };
    } catch (error) {
      return {
        error: { code: 'INTERNAL_ERROR', message: String((error as Error).message).slice(0, 300) },
      };
    }
  }

  chrome.runtime.onMessage.addListener(
    (message: Record<string, unknown>, _sender, sendResponse) => {
      const type = String(message['type'] ?? '');
      if (!type.startsWith('ib:')) return false;
      void (async () => {
        try {
          if (type === 'ib:ping') {
            sendResponse({ ok: true, url: location.href });
            return;
          }
          if (type === 'ib:snapshot') {
            sendResponse({ ok: true, snapshot: helpers().snapshot({ max: 400 }) });
            return;
          }
          if (type === 'ib:facts') {
            sendResponse({
              ok: true,
              facts: {
                url: location.href,
                origin: location.origin,
                title: document.title,
                window_stable_ms: helpers().stableMs(),
              },
            });
            return;
          }
          if (type === 'ib:start-recording') {
            installRecorderInPage();
            sendResponse({ ok: true });
            return;
          }
          if (type === 'ib:stop-recording') {
            const recording = (await stopRecorderInPage()) as Recording;
            sendResponse({ ok: true, recording });
            return;
          }
          if (type === 'ib:act') {
            sendResponse({ ok: true, result: performAct(message['request'] as ActionRequest) });
            return;
          }
          if (type === 'ib:state') {
            sendResponse({ ok: true, recording: Boolean(root.__ibRecorder) });
            return;
          }
          sendResponse({ ok: false, error: `unknown message ${type}` });
        } catch (error) {
          sendResponse({ ok: false, error: String((error as Error).message) });
        }
      })();
      return true;
    },
  );
})();
