/*
 * AI Assistant — general-purpose voice companion on Move.
 * Push-to-talk on bottom-row pads. Sampler captures mic, OpenAI Whisper
 * transcribes, GPT-4o-mini answers in plain prose. The reply is rendered
 * in a single scrollable region (no short/detailed split) and spoken aloud
 * via the on-device screen reader if TTS is enabled.
 *
 * Best for songwriting prompts, lyric ideas, sound-design suggestions,
 * music theory questions, and open-ended brainstorming. For documented
 * Move/Schwung features use AI Manual instead — it has the manuals loaded.
 *
 * Key file is shared with AI Manual at
 * /data/UserData/schwung/secrets/openai_key.txt (set via move.local:7700/config).
 */

import * as os from 'os';

const SCREEN_WIDTH = 128;
const SCREEN_HEIGHT = 64;
const LINE_H = 8;
const TEXT_COLS = 21;
const HEADER_Y = 2;
const HEADER_DIVIDER_Y = 11;
const BODY_START_Y = 14;
const HINT_Y = SCREEN_HEIGHT - 8;
const BODY_END_Y = HINT_Y - 2;
const BODY_VISIBLE_ROWS = Math.floor((BODY_END_Y - BODY_START_Y) / LINE_H);

const CC_BACK = 51;
const CC_JOG = 14;
const CC_KNOB1 = 71;
const PAD_TALK_MIN = 68;
const PAD_TALK_MAX = 75;
const PAD_CLEAR = 99;
const KNOB1_TOUCH_NOTE = 0;  /* knob 1 capacitive-touch note: toggle TTS */

const DIR = "/data/UserData/schwung/ai-assistant";
const SECRETS_DIR = "/data/UserData/schwung/secrets";
const WAV_PATH = DIR + "/in.wav";
const STT_RESP = DIR + "/stt_resp.json";
const STT_STAT = DIR + "/stt_status.json";
const CHAT_REQ = DIR + "/chat_req.json";
const CHAT_RESP = DIR + "/chat_resp.json";
const CHAT_STAT = DIR + "/chat_status.json";
const PROBE_RESP = DIR + "/probe_resp";
const PROBE_STAT = DIR + "/probe_status.json";
const PROBE_URL = "https://www.google.com/generate_204";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const SHADOW_CFG = "/data/UserData/schwung/shadow_config.json";

const SAMPLER_SOURCE_MOVE_INPUT = 1;
const MAX_TURNS = 10;

/* Path to the default system prompt file shipped with this module. Kept as
 * a plain text file so it's a single source of truth — both this module and
 * the Schwung Manager web UI read the same file when populating/resetting
 * the prompt. */
const DEFAULT_PROMPT_PATH =
    "/data/UserData/schwung/modules/tools/ai-assistant/default_system_prompt.txt";

/* Last-resort fallback if both shadow_config.ai_assistant_system_prompt AND
 * the on-disk default file are missing (e.g. corrupted install). Kept short. */
const FALLBACK_SYSTEM_PROMPT =
    "You are a creative voice companion for a musician using the Ableton Move. " +
    "Reply in 80-200 words of plain prose, conversational and encouraging. " +
    "No markdown, no bullet lists.";

/* Resolved at init() from (in order): the saved custom prompt in
 * shadow_config.json, the bundled default file, or FALLBACK_SYSTEM_PROMPT. */
let SYSTEM_PROMPT = FALLBACK_SYSTEM_PROMPT;

let state = "idle";
/* idle | recording | waiting_record_stop | transcribing | thinking | done | error */
let messages = [];
let lastError = "";          /* short label for header */
let lastErrorDetail = "";    /* fuller message for body */
let displayLines = [];
let scrollOffset = 0;
let frameCount = 0;
let recStartFrame = 0;
let configChecked = false;

/* TTS startup state pulled from shadow_config.ai_assistant_speak_replies.
 * Only applied on module init — subsequent config refreshes update this
 * variable but don't clobber the user's in-session knob-1 toggle. */
let ttsDefaultFromConfig = false;

let providerCfg = {
    provider: "gemini",  /* "gemini" | "openai" */
    openai:  {key: null, chatModel: "gpt-4o-mini",
              baseUrl: "https://api.openai.com/v1", sttModel: "whisper-1"},
    gemini:  {key: null, chatModel: "gemini-2.5-flash"},
};
let ttsEnabled = true;       /* per-session toggle; off via knob 1 touch */

/* Connectivity probe state. See ai-manual/ui.js for the same logic. */
let online = null;
let probeInFlight = false;
let lastProbeFrame = -9999;
const PROBE_RE_INTERVAL_FRAMES = 44 * 10;

function ensureDir() {
    if (typeof host_ensure_dir === "function") host_ensure_dir(DIR);
}

function safeUnlink(path) {
    try { os.remove(path); } catch (e) { /* file may not exist — ignore */ }
}

function cleanupTransientFiles() {
    safeUnlink(WAV_PATH);
    safeUnlink(STT_RESP);
    safeUnlink(STT_STAT);
    safeUnlink(CHAT_REQ);
    safeUnlink(CHAT_RESP);
    safeUnlink(CHAT_STAT);
    safeUnlink(PROBE_RESP);
    safeUnlink(PROBE_STAT);
}

function startConnectivityProbe() {
    if (probeInFlight) return;
    if (typeof host_http_request_background !== "function") {
        online = false;
        return;
    }
    probeInFlight = true;
    lastProbeFrame = frameCount;
    safeUnlink(PROBE_STAT);
    /* GET (not HEAD) because curl's -X HEAD doesn't set the internal nobody
     * flag — curl waits for a body that never comes and times out. GET hits
     * generate_204 which returns an empty body, so no extra data either way. */
    const ok = host_http_request_background({
        url: PROBE_URL,
        method: "GET",
        response_path: PROBE_RESP,
        status_path: PROBE_STAT,
        timeout_seconds: 10
    });
    if (!ok) { probeInFlight = false; online = false; }
}

function pollConnectivityProbe() {
    if (!probeInFlight) return;
    if (!host_file_exists(PROBE_STAT)) return;
    const txt = host_read_file(PROBE_STAT);
    if (!txt || txt.length === 0) return;
    let parsed;
    try { parsed = JSON.parse(txt); } catch (e) { return; }
    online = (parsed.http_status > 0);
    probeInFlight = false;
    safeUnlink(PROBE_RESP);
    safeUnlink(PROBE_STAT);
}

function readSecret(filename) {
    const path = SECRETS_DIR + "/" + filename;
    if (!host_file_exists(path)) return null;
    const s = host_read_file(path);
    return s ? s.trim() : null;
}

function loadConfig() {
    providerCfg.openai.key = readSecret("openai_key.txt");
    providerCfg.gemini.key = readSecret("gemini_key.txt");

    let customPrompt = "";
    if (host_file_exists(SHADOW_CFG)) {
        try {
            const cfg = JSON.parse(host_read_file(SHADOW_CFG) || "{}");
            if (cfg.ai_provider) providerCfg.provider = String(cfg.ai_provider).trim();
            if (cfg.openai_model) providerCfg.openai.chatModel = String(cfg.openai_model).trim();
            if (cfg.openai_base_url) {
                providerCfg.openai.baseUrl = String(cfg.openai_base_url).trim().replace(/\/+$/, "");
            }
            if (cfg.gemini_model) providerCfg.gemini.chatModel = String(cfg.gemini_model).trim();
            if (typeof cfg.ai_assistant_system_prompt === "string") {
                customPrompt = cfg.ai_assistant_system_prompt.trim();
            }
            ttsDefaultFromConfig = (cfg.ai_assistant_speak_replies === true);
        } catch (e) { /* ignore */ }
    }

    /* Resolve SYSTEM_PROMPT: user's custom override first, bundled default
     * file second, terse inline fallback last. */
    if (customPrompt) {
        SYSTEM_PROMPT = customPrompt;
    } else if (host_file_exists(DEFAULT_PROMPT_PATH)) {
        const def = host_read_file(DEFAULT_PROMPT_PATH);
        SYSTEM_PROMPT = (def && def.trim()) ? def.trim() : FALLBACK_SYSTEM_PROMPT;
    } else {
        SYSTEM_PROMPT = FALLBACK_SYSTEM_PROMPT;
    }
    configChecked = true;
}

function activeProvider() {
    const p = providerCfg.provider;
    if (p === "gemini" && providerCfg.gemini.key) {
        return {kind: "gemini", key: providerCfg.gemini.key,
                model: providerCfg.gemini.chatModel};
    }
    if (p === "openai" && providerCfg.openai.key) {
        return {kind: "openai", key: providerCfg.openai.key,
                baseUrl: providerCfg.openai.baseUrl,
                chatModel: providerCfg.openai.chatModel,
                sttModel: providerCfg.openai.sttModel};
    }
    return null;
}

function wrapText(text, cols) {
    const out = [];
    const paragraphs = String(text).split("\n");
    for (const para of paragraphs) {
        if (para === "") { out.push(""); continue; }
        const words = para.split(/\s+/);
        let cur = "";
        for (const w of words) {
            if (!w) continue;
            if (cur.length === 0) {
                cur = w;
            } else if (cur.length + 1 + w.length <= cols) {
                cur += " " + w;
            } else {
                out.push(cur);
                cur = w;
            }
            while (cur.length > cols) {
                out.push(cur.slice(0, cols));
                cur = cur.slice(cols);
            }
        }
        if (cur.length) out.push(cur);
    }
    return out;
}

function setReply(text) {
    displayLines = text ? wrapText(text, TEXT_COLS) : [];
    scrollOffset = 0;
}

function applyTtsEnabled() {
    /* Drive the global Schwung TTS state so the screen reader actually
     * speaks. host_send_screenreader is a no-op when global TTS is off. */
    if (typeof tts_set_enabled === "function") tts_set_enabled(ttsEnabled);
}

function speak(text) {
    if (!ttsEnabled) return;
    if (typeof host_send_screenreader !== "function") return;
    /* Make sure the global flag reflects our session state right before
     * speaking — defends against another process flipping it under us. */
    applyTtsEnabled();
    /* The screen reader buffer caps at 8KB. Truncate defensively — most
     * responses fit comfortably under 1KB. */
    const t = String(text || "").trim();
    if (!t) return;
    host_send_screenreader(t.length > 4000 ? t.substring(0, 4000) : t);
}

function startRecording() {
    if (state === "recording" || state === "waiting_record_stop") return;
    if (!configChecked) loadConfig();
    else loadConfig();  /* refresh every attempt so provider/key changes stick */
    const prov = activeProvider();
    if (!prov) {
        state = "error";
        lastError = "Set API key";
        return;
    }
    /* Don't block on online===false — the probe can latch stale state on
     * networks where the probe URL is flaky. Kick a fresh probe and let the
     * real API call flip online back via readStatus on success, or surface
     * a specific curl error on a real failure. */
    if (online === false) startConnectivityProbe();
    if (typeof host_sampler_start !== "function") {
        state = "error";
        lastError = "no sampler";
        return;
    }
    ensureDir();
    if (typeof host_sampler_set_source === "function") {
        host_sampler_set_source(SAMPLER_SOURCE_MOVE_INPUT);
    }
    if (host_file_exists(STT_STAT)) host_write_file(STT_STAT, "");
    if (host_file_exists(CHAT_STAT)) host_write_file(CHAT_STAT, "");
    host_sampler_start(WAV_PATH);
    state = "recording";
    recStartFrame = frameCount;
}

function stopRecording() {
    if (state !== "recording") return;
    if (typeof host_sampler_stop === "function") host_sampler_stop();
    state = "waiting_record_stop";
}

function readStatus(path) {
    if (!host_file_exists(path)) return null;
    const txt = host_read_file(path);
    if (!txt || txt.length === 0) return null;
    let stat;
    try { stat = JSON.parse(txt); } catch (e) { return null; }
    /* Any HTTP response (even 401/429) proves the network works — flips a
     * stale-offline flag back to true. DNS (6) or connect-refused (7) proves
     * it doesn't. Other curl errors are ambiguous; leave online alone. */
    if (stat && typeof stat.http_status === "number" && stat.http_status > 0) {
        online = true;
    } else if (stat && (stat.curl_exit === 6 || stat.curl_exit === 7)) {
        online = false;
    }
    return stat;
}

/* Robust JSON extraction — tolerates ```json fences and stray leading text
 * that Gemini sometimes emits despite responseMimeType:"application/json". */
function extractJsonObject(raw) {
    if (!raw) return null;
    let t = String(raw).trim();
    if (t.startsWith("```")) {
        t = t.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first > 0 || (first === 0 && last < t.length - 1)) {
        if (first >= 0 && last > first) t = t.substring(first, last + 1);
    }
    try { return JSON.parse(t); } catch (e) { return null; }
}

/* Translate an HTTP status + provider error body into a short header label
 * and a scrollable body message. Handles both OpenAI-shape and Gemini-shape
 * error JSON. */
function setHttpError(status, bodyPath) {
    let shortLabel;
    switch (status) {
        case 400: shortLabel = "Bad request"; break;
        case 401: shortLabel = "Bad API key"; break;
        case 402: shortLabel = "Quota exceeded"; break;
        case 403: shortLabel = "Access denied"; break;
        case 404: shortLabel = "Not found"; break;
        case 408: shortLabel = "Timed out"; break;
        case 413: shortLabel = "Audio too big"; break;
        case 429: shortLabel = "Rate limited"; break;
        default:
            if (status >= 500 && status < 600) shortLabel = "Provider error";
            else shortLabel = "HTTP " + status;
    }
    let detail = "";
    if (bodyPath && host_file_exists(bodyPath)) {
        const body = host_read_file(bodyPath);
        if (body) {
            try {
                const parsed = JSON.parse(body);
                if (parsed && parsed.error) {
                    if (typeof parsed.error.message === "string") {
                        detail = parsed.error.message.trim();
                    } else if (typeof parsed.error === "string") {
                        detail = parsed.error.trim();
                    }
                }
            } catch (e) {
                if (body.length < 200) detail = body.trim();
            }
        }
    }
    if (detail.length > 400) detail = detail.substring(0, 397) + "...";
    state = "error";
    lastError = shortLabel;
    lastErrorDetail = detail;
}

function setNetworkError(curlExit) {
    let shortLabel;
    let detail = "";
    switch (curlExit) {
        case 6:  shortLabel = "No internet"; detail = "DNS lookup failed. Check your Wi-Fi network."; break;
        case 7:  shortLabel = "Can't connect"; detail = "The provider refused the connection."; break;
        case 28: shortLabel = "Timed out"; detail = "Network or provider took too long to respond."; break;
        case 35: shortLabel = "TLS failed"; detail = "Could not establish a secure connection."; break;
        case 60: shortLabel = "Cert error"; detail = "TLS certificate could not be verified."; break;
        default: shortLabel = "Net err " + curlExit;
    }
    state = "error";
    lastError = shortLabel;
    lastErrorDetail = detail;
}

/* ---- Provider dispatch ---- */

function startProviderRequest() {
    if (!host_file_exists(WAV_PATH)) {
        state = "error"; lastError = "no audio"; return;
    }
    const prov = activeProvider();
    if (!prov) { state = "error"; lastError = "Set API key"; return; }
    if (prov.kind === "gemini") startGeminiTranscription(prov);
    else startOpenAITranscription(prov);
}

function pollProviderRequest() {
    const prov = activeProvider();
    if (!prov) return;
    if (state === "transcribing") {
        if (prov.kind === "gemini") pollGeminiTranscription(prov);
        else pollOpenAITranscription(prov);
    } else if (state === "thinking") {
        if (prov.kind === "gemini") pollGeminiAnswer();
        else pollOpenAIChat();
    }
}

/* ---- OpenAI / OpenAI-compatible ---- */

function startOpenAITranscription(prov) {
    host_write_file(STT_STAT, "");
    const ok = host_http_request_background({
        url: prov.baseUrl + "/audio/transcriptions",
        method: "POST",
        headers: ["Authorization: Bearer " + prov.key],
        body_form: [
            {name: "model", value: prov.sttModel},
            {name: "file", file: WAV_PATH, type: "audio/wav"}
        ],
        response_path: STT_RESP,
        status_path: STT_STAT,
        timeout_seconds: 30
    });
    if (!ok) { state = "error"; lastError = "STT launch failed"; return; }
    state = "transcribing";
}

function pollOpenAITranscription(prov) {
    const stat = readStatus(STT_STAT);
    if (!stat) return;
    if (stat.curl_exit !== 0) {
        setNetworkError(stat.curl_exit);
        safeUnlink(WAV_PATH);
        return;
    }
    if (stat.http_status !== 200) {
        setHttpError(stat.http_status, STT_RESP);
        safeUnlink(WAV_PATH);
        return;
    }
    const resp = host_read_file(STT_RESP);
    if (!resp) { state = "error"; lastError = "no STT body"; return; }
    let parsed;
    try { parsed = JSON.parse(resp); } catch (e) {
        state = "error"; lastError = "bad STT JSON"; return;
    }
    const text = parsed && parsed.text ? String(parsed.text).trim() : "";
    if (!text) {
        state = "error"; lastError = "(silence)";
        safeUnlink(WAV_PATH);
        return;
    }
    messages.push({role: "user", content: text});
    trimMessageHistory();
    safeUnlink(WAV_PATH);
    safeUnlink(STT_RESP);
    safeUnlink(STT_STAT);
    startOpenAIChat(prov);
}

function startOpenAIChat(prov) {
    const body = {
        model: prov.chatModel,
        messages: [{role: "system", content: SYSTEM_PROMPT}].concat(messages),
        max_tokens: 500,
        temperature: 0.8
    };
    if (!host_write_file(CHAT_REQ, JSON.stringify(body))) {
        state = "error"; lastError = "write chat req"; return;
    }
    host_write_file(CHAT_STAT, "");
    const ok = host_http_request_background({
        url: prov.baseUrl + "/chat/completions",
        method: "POST",
        headers: [
            "Authorization: Bearer " + prov.key,
            "Content-Type: application/json"
        ],
        body_path: CHAT_REQ,
        response_path: CHAT_RESP,
        status_path: CHAT_STAT,
        timeout_seconds: 60
    });
    if (!ok) { state = "error"; lastError = "chat launch failed"; return; }
    state = "thinking";
}

function pollOpenAIChat() {
    const stat = readStatus(CHAT_STAT);
    if (!stat) return;
    if (stat.curl_exit !== 0) { setNetworkError(stat.curl_exit); return; }
    if (stat.http_status !== 200) {
        setHttpError(stat.http_status, CHAT_RESP);
        return;
    }
    const resp = host_read_file(CHAT_RESP);
    if (!resp) { state = "error"; lastError = "no chat body"; return; }
    let parsed;
    try { parsed = JSON.parse(resp); } catch (e) {
        state = "error"; lastError = "bad chat JSON"; return;
    }
    const reply = parsed && parsed.choices && parsed.choices[0]
        && parsed.choices[0].message && parsed.choices[0].message.content
        ? String(parsed.choices[0].message.content).trim() : "";
    if (!reply) { state = "error"; lastError = "(empty reply)"; return; }
    messages.push({role: "assistant", content: reply});
    trimMessageHistory();
    setReply(reply);
    state = "done";
    speak(reply);
    safeUnlink(CHAT_REQ);
    safeUnlink(CHAT_RESP);
    safeUnlink(CHAT_STAT);
}

/* ---- Gemini (two-call flow: transcribe, then answer) ----
 * Mirrors the OpenAI path: call 1 is audio → {transcript}; call 2 is
 * history → reply. Simpler per-call schemas + no history-format drift than
 * the old single-call flow, which tended to return malformed JSON on
 * follow-up turns. */

function startGeminiTranscription(prov) {
    if (typeof host_read_file_base64 !== "function") {
        state = "error"; lastError = "no base64 host fn"; return;
    }
    const audioB64 = host_read_file_base64(WAV_PATH);
    if (!audioB64) { state = "error"; lastError = "read wav failed"; return; }
    const body = {
        contents: [{
            role: "user",
            parts: [
                {inline_data: {mime_type: "audio/wav", data: audioB64}},
                {text: "Transcribe this audio verbatim. Return only the spoken " +
                       "text, no translation, no commentary."}
            ]
        }],
        generationConfig: {
            temperature: 0.0,
            maxOutputTokens: 300,
            responseMimeType: "application/json",
            responseSchema: {
                type: "object",
                properties: {transcript: {type: "string"}},
                required: ["transcript"]
            }
        }
    };
    if (!host_write_file(CHAT_REQ, JSON.stringify(body))) {
        state = "error"; lastError = "write stt req"; return;
    }
    host_write_file(STT_STAT, "");
    const url = GEMINI_BASE + "/models/" + prov.model + ":generateContent";
    const ok = host_http_request_background({
        url: url,
        method: "POST",
        headers: [
            "x-goog-api-key: " + prov.key,
            "Content-Type: application/json"
        ],
        body_path: CHAT_REQ,
        response_path: STT_RESP,
        status_path: STT_STAT,
        timeout_seconds: 30
    });
    if (!ok) { state = "error"; lastError = "STT launch failed"; return; }
    state = "transcribing";
}

function pollGeminiTranscription(prov) {
    const stat = readStatus(STT_STAT);
    if (!stat) return;
    if (stat.curl_exit !== 0) {
        setNetworkError(stat.curl_exit);
        safeUnlink(WAV_PATH);
        return;
    }
    if (stat.http_status !== 200) {
        setHttpError(stat.http_status, STT_RESP);
        safeUnlink(WAV_PATH);
        return;
    }
    const resp = host_read_file(STT_RESP);
    if (!resp) { state = "error"; lastError = "no STT body"; return; }
    let parsed;
    try { parsed = JSON.parse(resp); } catch (e) {
        state = "error"; lastError = "bad STT JSON"; return;
    }
    const text = parsed && parsed.candidates && parsed.candidates[0]
        && parsed.candidates[0].content && parsed.candidates[0].content.parts
        && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text
        ? String(parsed.candidates[0].content.parts[0].text).trim() : "";
    if (!text) { state = "error"; lastError = "(silence)";
                 safeUnlink(WAV_PATH); return; }
    const obj = extractJsonObject(text);
    const transcript = obj && typeof obj.transcript === "string"
        ? obj.transcript.trim()
        : text.replace(/^[\s{"]+|[\s}"]+$/g, "").trim();
    if (!transcript) {
        state = "error"; lastError = "(silence)";
        safeUnlink(WAV_PATH);
        return;
    }
    messages.push({role: "user", content: transcript});
    trimMessageHistory();
    safeUnlink(WAV_PATH);
    safeUnlink(STT_RESP);
    safeUnlink(STT_STAT);
    startGeminiAnswer(prov);
}

function startGeminiAnswer(prov) {
    const contents = messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{text: m.content}]
    }));
    const body = {
        contents,
        systemInstruction: {parts: [{text: SYSTEM_PROMPT}]},
        generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 700
            /* Plain-text reply here (no JSON schema) — AI Assistant doesn't
             * use the short/detailed split. Matches the OpenAI flow. */
        }
    };
    if (!host_write_file(CHAT_REQ, JSON.stringify(body))) {
        state = "error"; lastError = "write chat req"; return;
    }
    host_write_file(CHAT_STAT, "");
    const url = GEMINI_BASE + "/models/" + prov.model + ":generateContent";
    const ok = host_http_request_background({
        url: url,
        method: "POST",
        headers: [
            "x-goog-api-key: " + prov.key,
            "Content-Type: application/json"
        ],
        body_path: CHAT_REQ,
        response_path: CHAT_RESP,
        status_path: CHAT_STAT,
        timeout_seconds: 60
    });
    if (!ok) { state = "error"; lastError = "chat launch failed"; return; }
    state = "thinking";
}

function pollGeminiAnswer() {
    const stat = readStatus(CHAT_STAT);
    if (!stat) return;
    if (stat.curl_exit !== 0) { setNetworkError(stat.curl_exit); return; }
    if (stat.http_status !== 200) {
        setHttpError(stat.http_status, CHAT_RESP);
        return;
    }
    const resp = host_read_file(CHAT_RESP);
    if (!resp) { state = "error"; lastError = "no chat body"; return; }
    let parsed;
    try { parsed = JSON.parse(resp); } catch (e) {
        state = "error"; lastError = "bad chat JSON"; return;
    }
    const reply = parsed && parsed.candidates && parsed.candidates[0]
        && parsed.candidates[0].content && parsed.candidates[0].content.parts
        && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text
        ? String(parsed.candidates[0].content.parts[0].text).trim() : "";
    if (!reply) { state = "error"; lastError = "(empty reply)"; return; }
    messages.push({role: "assistant", content: reply});
    trimMessageHistory();
    setReply(reply);
    state = "done";
    speak(reply);
    safeUnlink(CHAT_REQ);
    safeUnlink(CHAT_RESP);
    safeUnlink(CHAT_STAT);
}

function trimMessageHistory() {
    while (messages.length > MAX_TURNS * 2) {
        messages.shift();
        if (messages.length && messages[0].role === "assistant") {
            messages.shift();
        }
    }
}

function clearConversation() {
    messages = [];
    displayLines = [];
    scrollOffset = 0;
    state = "idle";
    lastError = "";
    lastErrorDetail = "";
}

function drawHeader() {
    let label = "AI Assistant";
    if (state === "recording") {
        const secs = Math.max(1, Math.floor((frameCount - recStartFrame) / 44));
        label = "Listening " + secs + "s";
    } else if (state === "waiting_record_stop") {
        label = "Saving...";
    } else if (state === "transcribing") {
        label = "Transcribing" + ".".repeat(1 + Math.floor(frameCount / 8) % 3);
    } else if (state === "thinking") {
        label = "Thinking" + ".".repeat(1 + Math.floor(frameCount / 8) % 3);
    } else if (state === "error") {
        label = "Err: " + (lastError || "?");
    } else if (state === "done") {
        label = ttsEnabled ? "Reply  TTS on" : "Reply";
    } else if (!activeProvider()) {
        label = "Set key in /config";
    } else if (online === false) {
        label = "Offline";
    } else {
        /* idle with provider configured */
        label = ttsEnabled ? "Ready  TTS on" : "Ready  TTS off";
    }
    if (label.length > TEXT_COLS) label = label.substring(0, TEXT_COLS);
    print(2, HEADER_Y, label, 1);
    draw_line(0, HEADER_DIVIDER_Y, 127, HEADER_DIVIDER_Y, 1);
}

function drawBody() {
    if (state === "idle") {
        if (!activeProvider()) {
            const lines = wrapText(
                "Open move.local:7700 in a browser, go to Settings > Assistant, pick a provider (Gemini is free), paste its API key.",
                TEXT_COLS);
            for (let i = 0; i < Math.min(lines.length, BODY_VISIBLE_ROWS); i++) {
                print(2, BODY_START_Y + i * LINE_H, lines[i], 1);
            }
            return;
        }
        if (online === false) {
            const lines = wrapText(
                "Unavailable. Connect to a Wi-Fi network with internet. Retrying...",
                TEXT_COLS);
            for (let i = 0; i < Math.min(lines.length, BODY_VISIBLE_ROWS); i++) {
                print(2, BODY_START_Y + i * LINE_H, lines[i], 1);
            }
            return;
        }
        print(2, BODY_START_Y, "Hold a bottom pad", 1);
        print(2, BODY_START_Y + LINE_H, "to brainstorm.", 1);
        print(2, BODY_START_Y + LINE_H * 3, "Knob 1 touch:", 1);
        print(2, BODY_START_Y + LINE_H * 4, "toggle TTS", 1);
        return;
    }

    if (state === "recording" || state === "waiting_record_stop"
        || state === "transcribing" || state === "thinking") {
        if (state === "recording" || state === "waiting_record_stop") {
            const sec = Math.max(0, Math.floor((frameCount - recStartFrame) / 44));
            print(2, BODY_START_Y, "Speak now... " + sec + "s", 1);
        }
        if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.role === "user") {
                const lines = wrapText("> " + lastMsg.content, TEXT_COLS);
                const startRow = (state === "transcribing" || state === "thinking") ? 0 : 2;
                for (let i = 0; i < Math.min(lines.length, BODY_VISIBLE_ROWS - startRow); i++) {
                    print(2, BODY_START_Y + (startRow + i) * LINE_H, lines[i], 1);
                }
            }
        }
        return;
    }

    /* done or error: render the (possibly multi-page) reply, scrollable. */
    const errBody = lastErrorDetail || lastError || "";
    const lines = displayLines.length ? displayLines :
        (state === "error" ? wrapText(errBody, TEXT_COLS) : []);
    const visible = BODY_VISIBLE_ROWS;
    const maxOffset = Math.max(0, lines.length - visible);
    if (scrollOffset > maxOffset) scrollOffset = maxOffset;
    if (scrollOffset < 0) scrollOffset = 0;
    for (let i = 0; i < visible; i++) {
        const idx = scrollOffset + i;
        if (idx >= lines.length) break;
        print(2, BODY_START_Y + i * LINE_H, lines[idx], 1);
    }
    if (lines.length > visible) {
        const trackTop = BODY_START_Y;
        const trackBottom = BODY_END_Y;
        const trackH = trackBottom - trackTop;
        const knobH = Math.max(4, Math.floor(trackH * visible / lines.length));
        const knobY = trackTop + Math.floor((trackH - knobH) * scrollOffset / Math.max(1, maxOffset));
        draw_line(125, trackTop, 125, trackBottom, 1);
        fill_rect(124, knobY, 3, knobH, 1);
    }
}

function drawSeparator() {
    draw_line(0, BODY_END_Y, 127, BODY_END_Y, 1);
}

function drawFooter() {
    let hint;
    if (state === "done") {
        hint = "Jog: scroll  Pad: ask";
    } else if (state === "error") {
        hint = "Pad: retry  Back: exit";
    } else if (state === "idle" && activeProvider()) {
        hint = "Back: exit";
    } else {
        hint = "";
    }
    if (hint) print(2, HINT_Y, hint, 1);
}

globalThis.init = function() {
    state = "idle";
    messages = [];
    lastError = "";
    lastErrorDetail = "";
    displayLines = [];
    scrollOffset = 0;
    frameCount = 0;
    configChecked = false;
    online = null;
    probeInFlight = false;
    lastProbeFrame = -9999;
    ensureDir();
    cleanupTransientFiles();
    loadConfig();
    /* TTS starts off by default. Users who want replies spoken aloud can
     * either flip the "Speak AI Assistant Replies" setting in the web UI
     * (persistent) or touch knob 1 in-session (transient). */
    ttsEnabled = ttsDefaultFromConfig;
    if (ttsEnabled) applyTtsEnabled();
    /* Mute the system sampler chatter ("Sample saved" etc.) so the only
     * voice the user hears is the assistant's own reply. */
    if (typeof host_sampler_set_silent === "function") host_sampler_set_silent(true);
    /* Probe internet right away so the user sees an "Offline" message before
     * recording. */
    startConnectivityProbe();
};

globalThis.tick = function() {
    frameCount++;

    if (state === "waiting_record_stop") {
        if (typeof host_sampler_is_recording === "function") {
            if (!host_sampler_is_recording()) {
                startProviderRequest();
            }
        } else {
            startProviderRequest();
        }
    } else if (state === "transcribing" || state === "thinking") {
        pollProviderRequest();
    }

    if (probeInFlight) pollConnectivityProbe();
    else if (online === false &&
             (frameCount - lastProbeFrame) > PROBE_RE_INTERVAL_FRAMES) {
        startConnectivityProbe();
    }

    if (state === "idle" && !activeProvider() && (frameCount % 44) === 0) {
        loadConfig();
    }

    clear_screen();
    drawHeader();
    drawBody();
    drawSeparator();
    drawFooter();
};

globalThis.onMidiMessageInternal = function(data) {
    const status = data[0] & 0xF0;
    const d1 = data[1];
    const d2 = data[2];

    /* Knob 1 capacitive-touch (note 0): toggle TTS for this session. */
    if (status === 0x90 && d1 === KNOB1_TOUCH_NOTE && d2 > 0) {
        ttsEnabled = !ttsEnabled;
        applyTtsEnabled();
        if (ttsEnabled && typeof host_send_screenreader === "function") {
            /* Only confirm on enable — the screen reader is now off when
             * disabling, so we couldn't speak the "off" message anyway. */
            host_send_screenreader("Speaking on");
        }
        return;
    }

    /* Filter the rest of the knob touches (notes 1-9). */
    if ((status === 0x90 || status === 0x80) && d1 < 16) return;

    if (status === 0x90 && d2 > 0) {
        if (d1 >= PAD_TALK_MIN && d1 <= PAD_TALK_MAX) {
            startRecording();
        } else if (d1 === PAD_CLEAR) {
            clearConversation();
        }
    } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
        if (d1 >= PAD_TALK_MIN && d1 <= PAD_TALK_MAX) {
            stopRecording();
        }
    } else if (status === 0xB0) {
        if (d1 === CC_BACK && d2 > 0) {
            /* Restore default sampler chatter for the next non-tool user
             * (Shift+Sample workflow expects "Sample saved" announcements). */
            if (typeof host_sampler_set_silent === "function") host_sampler_set_silent(false);
            host_exit_module();
        } else if (d1 === CC_JOG || d1 === CC_KNOB1) {
            const delta = d2 < 64 ? d2 : d2 - 128;
            if (delta !== 0) scrollOffset += delta > 0 ? 1 : -1;
        }
    }
};
