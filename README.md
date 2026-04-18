# AI Assistant

General-purpose voice companion for Ableton Move — songwriting prompts, lyric brainstorms, sound design ideas, music theory, or just chatting while you make music. Hold a bottom-row pad to speak, release to send. Long-form conversational replies, optionally read aloud via the Schwung screen reader.

Installs under **Tools** in the Schwung menu.

## Requirements

- Schwung host with the voice-tool host bindings (`host_http_request_background`, `host_sampler_set_source`, `host_sampler_set_silent`, `host_read_file_base64`). Minimum host version is declared in `module-catalog.json` on the Schwung main repo.
- A Gemini or OpenAI API key. Free Gemini keys at https://aistudio.google.com/.
- Wi-Fi connection.
- For spoken replies: Schwung's screen reader must be enabled (**Settings → Screen Reader**).

## Setup

1. Install via **Tools → Module Store → AI Assistant**.
2. Open `http://move.local:7700/config` and scroll to **Assistant**. Pick a provider and paste your key. Shared with AI Manual if installed — set it once.
3. Launch **Tools → AI Assistant**.
4. Hold any pad in the bottom row, speak, release to send.

## Controls

| Input | Action |
|---|---|
| Bottom-row pad (hold) | Record question |
| Jog wheel / Knob 1 | Scroll long replies |
| Knob 1 touch | Toggle text-to-speech on/off for this session |
| Top-right pad | Clear conversation history |
| Back | Exit to Tools menu |

## Customizing the personality

The system prompt is editable in the web UI under **Assistant → AI Assistant System Prompt**. The default is tuned for creative music-making; rewrite it if you want a different personality (jazz-pianist-from-1962, terse-technical-mentor, etc.). Click **Reset to default** to restore the shipped prompt.

Text-to-speech is off by default. Flip **Speak AI Assistant Replies** in the config, or touch knob 1 in-session for a one-time toggle.

## Privacy

Audio is recorded locally, sent to the chosen provider for transcription + answer, then deleted from disk when the reply is received. API keys never leave the device except over TLS to the chosen provider.

## Building locally

```bash
./scripts/build.sh
# -> dist/ai-assistant-module.tar.gz
```

## Releasing

1. Bump `version` in `src/module.json`
2. Commit and tag: `git tag v0.1.1 && git push origin main --tags`
3. GitHub Actions builds the tarball, cuts a release, and updates `release.json` on main
