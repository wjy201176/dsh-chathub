# chatHub

A DSH plugin that puts **ChatGPT, Gemini, Claude, DeepSeek and Grok side by side** in one Edge window, so you can send a single prompt to all of them and compare the answers without switching tabs.

Each column is the provider's real web app running in a background tab, driven over the Chrome DevTools Protocol — so it uses **your own logged-in sessions**, not API keys.

## What it does

- **Five live columns** in one window: one prompt, every model.
- **Shared prompt bar** at the bottom (10% of the window height) with file attachment and voice input. One Enter sends to all columns.
- **Left rail** (10% of the window width) showing each column's state and whether it needs a sign-in.
- **New Session** clears every column back to a fresh chat.
- **History** records what you sent and what each model answered, grouped by day on a timeline. Click an entry to **load the stored answers back into the columns** — no prompt is re-sent and no quota is spent. The ⤢ button opens a read-only transcript.
- **Summarize** asks a model for one consensus summary plus a table of where the models disagreed, and opens it in its own window. It summarizes whichever source is on screen: the stored chat when you opened one, otherwise the live columns.

## Layout

```
┌──────────┬──────────────────────────────────────────────┐
│          │  ChatGPT │ Gemini │ Claude │ DeepSeek │ Grok │  ← 90% height
│   rail   ├──────────────────────────────────────────────┤
│   10%    │  prompt bar · attach · voice · send · summary │  ← 10% height
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
| `historyCaptureMs` | `180000` | how long to wait for answers before storing a turn |
| `historyPollMs` | `3000` | how often to check whether a column has finished answering |

## Signing in

The plugin seeds its Edge profile from your existing Edge cookies at launch, so most columns come up already signed in. When a provider needs a fresh sign-in, its rail entry shows **sign in** and the column offers a button.

Grok signs in through `accounts.x.ai`; that hand-off must be done by you in the column, since the provider blocks automated sign-in.

## Notes on how it works

- Columns are **screenshots** of background tabs, refreshed on a timer, with input forwarded as real key and mouse events. The tabs are never focused, so all five stay live at once.
- Cookies are imported read-only from Edge; the plugin never writes to your real Edge profile.
- History is stored in `history.json` beside the Edge profile and written atomically, so a crash cannot truncate it.
- The summarizer runs through the harness LLM service, so no provider credential is handled by this plugin.

## Requirements

- DSH with the `webServer` service.
- Microsoft Edge.
- Node.js 20+.

## License

MIT
