/**
 * The model columns.
 *
 * `composer` lists the selectors tried, in order, when chatHub has to focus a
 * provider's prompt box before typing into it. `login` describes how to steer a
 * signed-out column to the login method the user prefers.
 */
export const PROVIDERS = [
  {
    id: 'chatgpt',
    title: 'ChatGPT',
    url: 'https://chatgpt.com/',
    composer: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea'],
    attach: ['[data-testid="composer-attach-button"]', 'button[aria-label*="Attach" i]', 'button[aria-label*="upload" i]'],
    loginHints: ['/auth/login', '/auth/', 'login'],
    login: {
      // Prefer the plain email/password form over an SSO hand-off.
      prefer: ['Log in with email', 'Continue with email', 'Use email', 'email'],
      url: 'https://chatgpt.com/auth/login',
    },
  },
  {
    id: 'gemini',
    title: 'Gemini',
    url: 'https://gemini.google.com/app',
    composer: ['rich-textarea .ql-editor', 'div[contenteditable="true"]', 'textarea'],
    attach: ['button[aria-label*="Add files" i]', 'button[aria-label*="upload" i]', 'button[aria-label*="file" i]'],
    loginHints: ['accounts.google.com', 'signin'],
    login: { prefer: [], url: 'https://gemini.google.com/app' },
  },
  {
    id: 'claude',
    title: 'Claude',
    url: 'https://claude.ai/new',
    composer: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]', 'textarea'],
    attach: ['button[aria-label*="attach" i]', 'button[aria-label*="file" i]', '[data-testid*="attach"]'],
    loginHints: ['/login', 'signin'],
    login: {
      // Claude offers Google / Apple / email / SSO. "Continue with email" is the
      // method chatHub prefers, so the user never lands on the Apple account.
      prefer: ['Continue with email', 'Log in with email', 'Use email', 'email'],
      url: 'https://claude.ai/login',
    },
  },
  {
    id: 'deepseek',
    title: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    composer: ['textarea#chat-input', 'textarea', 'div[contenteditable="true"]'],
    attach: ['button[aria-label*="upload" i]', 'button[aria-label*="file" i]', 'input[type=file] + label'],
    loginHints: ['/sign_in', 'login'],
    login: { prefer: ['email', 'Continue with email'], url: 'https://chat.deepseek.com/sign_in' },
  },
  {
    id: 'grok',
    title: 'Grok',
    url: 'https://grok.com/',
    // Grok's composer is a tiptap ProseMirror editor (measured 2026-10-25); the
    // hidden textarea beside it is not the editing surface.
    composer: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    attach: ['button[aria-label*="attach" i]', 'button[aria-label*="file" i]', 'input[type=file]'],
    // Signing in leaves grok.com for accounts.x.ai, so the path never shows a
    // login hint; a signed-out column is recognised by the missing composer.
    loginHints: ['/sign-in', '/sign-up', 'accounts.x.ai'],
    // Grok renders its composer to anonymous visitors too (measured 2026-10-25),
    // so the header's Sign in / Sign up links are what actually distinguish a
    // signed-out column.
    signedOutMarkers: ['a[href^="/sign-in"]', 'a[href^="/sign-up"]'],
    login: {
      prefer: ['Continue with email', 'Sign in with email', 'email', 'Sign in'],
      url: 'https://grok.com/sign-in',
    },
  },
]

/** Host names whose cookies are imported from the user's Edge profile. */
export const PROVIDER_HOST_PATTERNS = [
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'auth.openai.com',
  'gemini.google.com',
  'accounts.google.com',
  'google.com',
  'claude.ai',
  'anthropic.com',
  'deepseek.com',
  'grok.com',
  'x.ai',
]

/** Does a cookie host belong to one of the provider columns? */
export function isProviderHost(hostKey) {
  const host = String(hostKey ?? '').replace(/^\./, '').toLowerCase()
  return PROVIDER_HOST_PATTERNS.some((pattern) => host === pattern || host.endsWith(`.${pattern}`))
}

/**
 * Build the in-page script that focuses a provider's composer.
 * @param selectors - candidate CSS selectors, most specific first.
 * @returns an expression evaluating to a small status object.
 */
export function focusComposerScript(selectors) {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const visible = (el) => {
      if (el === null) return false;
      const box = el.getBoundingClientRect();
      if (box.width < 40 || box.height < 12) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        el.focus();
        try { el.click(); } catch {}
        if (document.activeElement === el || el.contains(document.activeElement)) {
          return { ok: true, selector, editable: el.isContentEditable === true, tag: el.tagName };
        }
      }
    }
    return { ok: false, reason: 'composer-not-found' };
  })()`
}

/** Report whether the pane looks ready, signed out, or still loading.
 * @param selectors - composer selectors, most specific first.
 * @param loginHints - URL fragments that mean "this page is a login page".
 * @param signedOutMarkers - optional selectors that only exist while signed out.
 *   Grok needs them: its composer renders for anonymous visitors too, so the
 *   absence of a composer cannot be what identifies a signed-out column.
 */
export function probePaneScript(selectors, loginHints, signedOutMarkers = []) {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const hints = ${JSON.stringify(loginHints)};
    const markers = ${JSON.stringify(signedOutMarkers)};
    const href = String(location.href);
    const visible = (el) => {
      const box = el.getBoundingClientRect();
      return box.width > 40 && box.height > 12;
    };
    let composer = false;
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (visible(el)) { composer = true; break; }
      }
      if (composer) break;
    }
    const onLoginUrl = hints.some((hint) => href.toLowerCase().includes(hint.toLowerCase()));
    // A marker counts only when it is actually on screen; a hidden one is a
    // template the app keeps in the DOM regardless of session state.
    const markedOut = markers.some((selector) =>
      [...document.querySelectorAll(selector)].some((el) => {
        const box = el.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
      }),
    );
    const signedOut = onLoginUrl || markedOut;
    return {
      composer,
      href,
      title: document.title,
      ready: composer && !signedOut,
      loginRequired: signedOut,
    };
  })()`
}

/**
 * Locate a provider's preferred login control so chatHub can click it with a
 * trusted mouse event.
 *
 * Claude offers Google / Apple / email / SSO; chatHub must not leave the user on
 * an Apple account hand-off, so it clicks the email option instead. The script
 * only reports coordinates — the caller dispatches the real click.
 * @param {string[]} prefer - label fragments, most preferred first.
 * @returns an expression evaluating to `{ ok, x, y, label }`.
 */
export function loginButtonScript(prefer) {
  return `(() => {
    const prefer = ${JSON.stringify(prefer)};
    const visible = (el) => {
      if (el === null) return false;
      const box = el.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    const center = (el) => {
      const box = el.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    };
    const label = (el) => [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')]
      .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    const candidates = [...document.querySelectorAll('button, a, div[role=button], [role=button]')].filter(visible);
    for (const wanted of prefer) {
      const needle = wanted.toLowerCase();
      for (const el of candidates) {
        const text = label(el).toLowerCase();
        if (text === '') continue;
        // Exact-ish match first so "email" never selects an unrelated control.
        if (text === needle || text.includes(needle)) {
          return { ok: true, label: label(el).slice(0, 60), ...center(el) };
        }
      }
    }
    return { ok: false, labels: candidates.map((el) => label(el).slice(0, 40)).filter(Boolean).slice(0, 12) };
  })()`
}

/**
 * Locate a provider's attach control so chatHub can click it with a real
 * (trusted) mouse event. A scripted `el.click()` carries no user activation, so
 * Chromium refuses to open the file chooser; a dispatched mouse event does.
 * @returns an expression evaluating to `{ ok, x, y, selector }`.
 */
export function attachButtonScript(selectors) {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const visible = (el) => {
      if (el === null) return false;
      const box = el.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    };
    const center = (el) => {
      const box = el.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    };
    const label = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent]
      .filter(Boolean).join(' ').toLowerCase();
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        return { ok: true, selector, ...center(el) };
      }
    }
    for (const el of document.querySelectorAll('button, [role=button], label')) {
      if (!visible(el)) continue;
      if (!/attach|upload|file|附件|上传|添加文件/.test(label(el))) continue;
      return { ok: true, selector: 'label-match', ...center(el) };
    }
    return { ok: false };
  })()`
}
