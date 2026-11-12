# chatHub

A DSH plugin that puts **ChatGPT, Gemini, Claude, DeepSeek and Grok side by side** in one Edge window, so you can send a single prompt to all of them and compare the answers without switching tabs.

Each column is the provider's real web app running in a background tab, driven over the Chrome DevTools Protocol — so it uses **your own logged-in sessions**, not API keys.

## What it does

- **Five live columns** in one window: one prompt, every model.
- **Language**: the sidebar's **Language** box switches the whole chatHub window between **English** (the default) and **中文** — buttons, placeholders, column headers, the history and summary labels, statuses and dates follow immediately. The choice is stored in `preferences.json` beside the history, so it survives a restart and a fresh Edge profile.
- **Full screen per column**: each column's header has a **full screen** button next to *reload*. It widens that provider tab to the size of the window — the page reflows to its desktop layout instead of a narrow screenshot — and hides the rail, the other columns, the prompt bar and the timeline. The same button (or Esc) restores the five-column view.
- **Find (Ctrl+F)**: because the columns are screenshots, the browser's own find cannot see the models' words. Ctrl+F opens chatHub's own find bar instead; it searches inside every provider tab, paints the matches with the CSS Custom Highlight API, and lands on the first match as soon as the search completes. Enter / Shift+Enter (or ↓ / ↑) steps through the matches across columns, scrolling each model's view to the active one. The bar names the column it jumped to and both positions (`Claude 3/74 · 12/569`), outlines that column, and paints the active match red. A click on ↓ while the search is still running is kept and applied when the result lands. The order starts at the column being read. Esc closes the bar and clears the marks. Works in the five-column view and in a full-screen column.
- **Shared prompt bar** at the bottom (10% of the window height) with file attachment and voice input. One Enter sends to all columns.
- **Left rail** (10% of the window width) showing each column's state and whether it needs a sign-in.
- **New Session** clears every column back to a fresh chat.
- **History** records what you sent and what each model answered, grouped by day on a timeline. Click an entry to **load the stored answers back into the columns** — no prompt is re-sent and no quota is spent. The ⤢ button opens a read-only transcript.
- **Summarize** asks a model for one consensus summary plus a table of where the models disagreed, and opens it in its own window. It summarizes whichever source is on screen: the stored chat when you opened one, otherwise the live columns. When the **answer-me-with-html** plugin is installed, the report is laid out as a designed document; otherwise the plain report is used. A **Save PDF** button in the top-right corner writes the report to a PDF file, and each model's conversation link stays clickable inside it.
- **Summary timeline** under the prompt bar keeps every report: one row per summary with the time, a **topic tag** and the counts. Click a row to reopen that report; click its tag to rename it — your label is saved and survives a restart. Clearing a tag puts back the one the model proposed.

## Layout

```
┌──────────┬──────────────────────────────────────────────┐
│          │  ChatGPT │ Gemini │ Claude │ DeepSeek │ Grok │
│   rail   ├──────────────────────────────────────────────┤
│   10%    │  prompt bar · attach · voice · send · summary │
│          ├──────────────────────────────────────────────┤
│          │  summaries · tag · time · counts (collapsible)│
└──────────┴──────────────────────────────────────────────┘
```

## Install

The plugin is a DSH bundle. Mount it into a profile and add it to that profile's `dsh.profile.bundles`:

```yaml
# cordis.patch.yml in your profile
- insert:
    - id: chathub
      name: dsh-chathub
```

`package.json` must also list it in `dependencies` **and** `dsh.profile.bundles` — a plugin missing from either is silently never mounted.

### Configuration

| key | default | meaning |
| --- | --- | --- |
| `profileDir` | `~/.dsh/chathub/edge-profile` | Edge profile used by the window |
| `windowWidth` / `windowHeight` | `1680` / `1000` | window size |
| `summaryWidth` / `summaryHeight` | `1280` / `900` | summary window size |
| `summaryTimeoutMs` | `120000` | how long the summarizer may take |
| `summaryProvider` / `summaryModel` | *(empty)* | pin the summarizer's route; empty = first available |
| `reportRenderer` | `auto` | `auto` uses answer-me-with-html; `classic` keeps the plain report page |
| `amCli` | *(empty)* | path to the answer-me-with-html `am.mjs`; empty = the profile's installed copy |
| `amTimeoutMs` | `30000` | how long one answer-me-with-html render may take before the plain report is used |
| `pdfDir` | *(empty)* | where Save writes PDFs; empty = `Downloads`, else the plugin data folder |
| `historyCaptureMs` | `180000` | how long to wait for answers before storing a turn |
| `historyPollMs` | `3000` | how often to check whether a column has finished answering |

## Signing in

The plugin seeds its Edge profile from your existing Edge cookies at launch, so most columns come up already signed in. When a provider needs a fresh sign-in, its rail entry shows **sign in** and the column offers a button.

Grok signs in through `accounts.x.ai`; that hand-off must be done by you in the column, since the provider blocks automated sign-in.

## Notes on how it works

- Columns are **screenshots** of background tabs, refreshed on a timer, with input forwarded as real key and mouse events. The tabs are never focused, so all five stay live at once.
- A full-screen column resizes that tab's emulated viewport to the window (`Emulation.setDeviceMetricsOverride`), so the provider page reflows to its wide layout and the screenshot stays sharp; the shell maps pointer input against the viewport size the Host reports with each frame. Restoring the five-column view puts the tab back to the shared 520×1180 viewport. While a column is full screen only that column is captured.
- Find runs a small script inside each provider tab (`Runtime.evaluate`) that walks the rendered text and keeps every match as a `Range`; the CSS Custom Highlight API paints them without touching the provider's DOM, so the marks appear in the screenshots the shell shows. Matching is case-insensitive and skips hidden elements, scripts, styles and textareas. Only rendered text can be found: messages a provider keeps virtualized off-screen are not in the DOM and are not searched.
- The DSH panel uses the theme's own token pairs: the primary button's fill is near-white in the dark theme, so its label comes from `--dsw-alias-label-primary-foreground` (not from a fixed white), and the report's native `<select>` options pin their own colours. `test/ui-theme.test.mjs` fails if the panel references a token the theme does not define, because such a declaration is silently dropped — which is how a selected control can end up white-on-white.
- Cookies are imported read-only from Edge; the plugin never writes to your real Edge profile.
- History is stored in `history.json` beside the Edge profile and written atomically, so a crash cannot truncate it.
- Saved summaries live in `summaries.json` beside it, written the same way. Only the digest and the per-model conversation links are kept — not the answer bodies.
- The summarizer runs through the harness LLM service, so no provider credential is handled by this plugin.
- The report page is rendered by the answer-me-with-html CLI into `reports/` beside the Edge profile, then served by this plugin's own route. When the CLI is unavailable the plain report page is used instead; both pages carry the Save control.
- Save runs `am export` on that page file: a headless Edge prints it with print media, CSS backgrounds, A4 paper and no header or footer, so the PDF holds the same content as the window. Chromium keeps every `<a href>` as a link annotation, which is why the conversation links stay clickable in the PDF. Without the CLI, Save falls back to `msedge --headless --print-to-pdf`. Saved PDFs go to `Downloads` unless `pdfDir` names another folder.
- The report page is a normal page: its Save script is admitted by a sha256 in the page's own Content-Security-Policy, and the button is hidden under `@media print` so it never appears in the PDF.

## Tests

```bash
node test/run.mjs        # or: npm test
```

Plain Node, no dependencies. The suites cover the tag normaliser and digest parser, the summary store (including upgrading reports written before tags existed), the report page, the answer-me-with-html draft and Save control (including its CSP hash), the CLI runners with a fake spawn, the per-column full-screen viewport (clamped sizes and the shell wiring), the Ctrl+F find script and find bar, the interface dictionaries and language switch, the Host preferences route, the controller's summary methods, and the real Host routes booted against a stub cordis context and driven over a socket.

## Requirements

- DSH with the `webServer` service.
- Microsoft Edge.
- Node.js 20+ (the PDF export uses the CLI's built-in WebSocket, which needs Node.js 22+; without it Save falls back to headless Edge).
- Optional: the `answer-me-with-html` bundle for the designed report page. Without it the plain report still opens and saves.

## License

MIT
