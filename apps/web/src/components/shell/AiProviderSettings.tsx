import { useEffect, useMemo, useState } from "react";
import { API_PROVIDERS, DEFAULT_MUSIC_MODEL, type ApiProviderId, type ApiProviderModel, type ApiProviderStatus } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { useHostsStore } from "../../stores/hosts";
import { Icon, InlineError, SectionTitle, Spinner, Toggle } from "../ui/primitives";

/**
 * AirWaves: Settings → AI providers. Each provider is added in four steps that unlock in order:
 * enter the API key and test it, load the provider's models and pick one, test the model, then save.
 * A saved provider shows up in the model picker beside the command-line agents.
 */
export function AiProviderSettings() {
  const [providers, setProviders] = useState<ApiProviderStatus[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api.apiProviders().then(r => setProviders(r.providers)).catch(e => setError(errorMessage(e)));
  useEffect(() => { void load(); }, []);

  return (
    <section className="card p-5" aria-labelledby="ai-providers-heading">
      <SectionTitle><span id="ai-providers-heading">AI providers</span></SectionTitle>
      <p className="text-[13px] text-muted mb-4 max-w-[640px]">
        Use your own API key to edit with Google Gemini or any model on OpenRouter, without installing a command-line agent.
        Test the key, pick a model, test the model, then save. Saved providers appear in the model picker.
      </p>
      <InlineError>{error}</InlineError>
      {!providers && !error && <Spinner />}
      <div className="space-y-4">
        {providers?.map(p => <ProviderCard key={p.id} status={p} onChanged={() => void load()} />)}
      </div>
    </section>
  );
}

type StepState = "idle" | "busy" | "ok" | "fail";

function StepBadge({ n, state, title }: { n: number; state: StepState; title: string }) {
  const tone = state === "ok" ? "bg-ok/15 text-ok border-ok/40" : state === "fail" ? "bg-bad/10 text-bad border-bad/40" : "bg-raised text-muted border-line";
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className={`inline-flex size-5 items-center justify-center rounded-full border text-[11px] font-semibold ${tone}`} aria-hidden>
        {state === "ok" ? <Icon name="check" size={11} /> : state === "fail" ? <Icon name="x" size={11} /> : n}
      </span>
      <span className="text-[13px] font-medium text-fg">{title}</span>
      {state === "busy" && <Spinner className="size-3" />}
    </div>
  );
}

function ProviderCard({ status, onChanged }: { status: ApiProviderStatus; onChanged: () => void }) {
  const info = API_PROVIDERS[status.id];
  const [editing, setEditing] = useState(!status.configured);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyState, setKeyState] = useState<StepState>("idle");
  const [keyMsg, setKeyMsg] = useState("");
  const [models, setModels] = useState<ApiProviderModel[] | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [filter, setFilter] = useState("");
  const [toolsOnly, setToolsOnly] = useState(true);
  const [model, setModel] = useState(status.model ?? "");
  const [modelState, setModelState] = useState<StepState>("idle");
  const [modelMsg, setModelMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedNote, setSavedNote] = useState("");

  /** Blank key while changing a saved provider: the engine tests the saved key. */
  const typedKey = apiKey.trim() || undefined;
  const canUseSavedKey = status.configured && !typedKey;

  const resetFrom = (step: "key" | "model") => {
    if (step === "key") {
      setKeyState("idle"); setKeyMsg(""); setModels(null); setModelsError("");
    }
    setModelState("idle"); setModelMsg(""); setSaveError(""); setSavedNote("");
  };

  const testKey = async () => {
    setKeyState("busy"); setKeyMsg(""); setModels(null); setModelsError("");
    try {
      const r = await api.testApiKey(status.id, typedKey);
      setKeyState(r.ok ? "ok" : "fail");
      setKeyMsg(r.ok ? r.detail ?? "Key accepted." : r.error ?? "The key did not work.");
      if (r.ok) await loadModels();
    } catch (e) {
      setKeyState("fail"); setKeyMsg(errorMessage(e));
    }
  };

  const loadModels = async () => {
    setModelsBusy(true); setModelsError("");
    try {
      const r = await api.apiProviderModels(status.id, typedKey);
      setModels(r.models);
      if (!r.models.some(m => m.id === model)) setModel(r.models.find(m => m.tools)?.id ?? r.models[0]?.id ?? "");
    } catch (e) {
      setModelsError(errorMessage(e));
    } finally {
      setModelsBusy(false);
    }
  };

  const testModel = async () => {
    setModelState("busy"); setModelMsg(""); setSaveError("");
    try {
      const r = await api.testApiModel(status.id, model, typedKey);
      setModelState(r.ok ? "ok" : "fail");
      setModelMsg(r.ok
        ? `“${r.reply}” · ${((r.ms ?? 0) / 1000).toFixed(1)} s${r.tools ? " · tool calls work" : " · answered without a tool call; editing may not work well"}`
        : r.error ?? "The model did not answer.");
    } catch (e) {
      setModelState("fail"); setModelMsg(errorMessage(e));
    }
  };

  const save = async () => {
    setSaving(true); setSaveError("");
    try {
      const label = models?.find(m => m.id === model)?.label;
      await api.saveApiProvider(status.id, { apiKey: typedKey, model, modelLabel: label, enabled: true });
      setApiKey(""); setEditing(false); setSavedNote("Saved. It will appear in the model picker in a few seconds.");
      onChanged();
      void useHostsStore.getState().refreshModels().catch(() => undefined);
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api.removeApiProvider(status.id);
      setApiKey(""); setModel(""); resetFrom("key"); setEditing(true);
      onChanged();
      void useHostsStore.getState().refreshModels().catch(() => undefined);
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (!status.model) return;
    try {
      await api.saveApiProvider(status.id, { model: status.model, modelLabel: status.modelLabel, enabled });
      onChanged();
      void useHostsStore.getState().refreshModels().catch(() => undefined);
    } catch (e) {
      setSaveError(errorMessage(e));
    }
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (models ?? []).filter(m => (!toolsOnly || m.tools) && (!q || `${m.label} ${m.id}`.toLowerCase().includes(q)));
  }, [models, filter, toolsOnly]);
  const selected = models?.find(m => m.id === model);

  const keyOk = keyState === "ok";
  const modelOk = modelState === "ok";
  const inputId = `key-${status.id}`;

  return (
    <div className="rounded-xl border border-line bg-bg/40 p-4" data-provider={status.id}>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <ProviderMark id={status.id} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-fg">{info.label}</div>
          <div className="text-[12px] text-muted">
            {status.configured
              ? <>Key {status.keyPreview} · {status.modelLabel ?? status.model}{status.enabled ? "" : " · off"}</>
              : <>Not set up. <a className="underline hover:text-fg" href={info.keyUrl} target="_blank" rel="noreferrer">Get a key</a></>}
          </div>
        </div>
        {status.configured && !editing && (
          <>
            <Toggle checked={status.enabled} onChange={v => void toggleEnabled(v)} label={`Use ${info.label}`} />
            <button type="button" className="btn-ghost" onClick={() => { resetFrom("key"); setModel(status.model ?? ""); setEditing(true); }}>
              <Icon name="pencil" /> Change
            </button>
            <button type="button" className="btn-danger" disabled={saving} onClick={() => void remove()}>
              <Icon name="trash" /> Remove
            </button>
          </>
        )}
      </div>
      {savedNote && !editing && <div className="text-[12px] text-ok mb-1" role="status">{savedNote}</div>}
      {status.id === "openrouter" && status.configured && !editing && <MusicSettings status={status} onChanged={onChanged} />}

      {editing && (
        <ol className="space-y-4">
          {/* Step 1 */}
          <li>
            <StepBadge n={1} state={keyState} title="API key" />
            <div className="flex flex-wrap gap-2">
              <input
                id={inputId}
                className="field flex-1 min-w-[220px] border border-line font-mono"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                aria-label={`${info.label} API key`}
                placeholder={status.configured ? `Leave blank to keep ${status.keyPreview}` : info.keyHint}
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); resetFrom("key"); }}
                onKeyDown={e => { if (e.key === "Enter" && (typedKey || canUseSavedKey)) void testKey(); }}
              />
              <button type="button" className="btn-quiet" onClick={() => setShowKey(v => !v)}>{showKey ? "Hide" : "Show"}</button>
              <button type="button" className="btn-primary" disabled={!(typedKey || canUseSavedKey) || keyState === "busy"} onClick={() => void testKey()}>
                Test key
              </button>
            </div>
            {keyMsg && <div className={`text-[12px] mt-1.5 ${keyOk ? "text-ok" : "text-bad"}`} role={keyOk ? "status" : "alert"}>{keyMsg}</div>}
          </li>

          {/* Step 2 */}
          <li aria-disabled={!keyOk} className={keyOk ? "" : "opacity-50 pointer-events-none"}>
            <StepBadge n={2} state={selected && keyOk ? "ok" : modelsBusy ? "busy" : "idle"} title="Model" />
            {modelsError && <InlineError>{modelsError}</InlineError>}
            {keyOk && models && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input className="field flex-1 min-w-[180px] border border-line" placeholder={`Search ${models.length} models`} value={filter} onChange={e => setFilter(e.target.value)} aria-label="Search models" />
                  <label className="flex items-center gap-1.5 text-[12px] text-muted">
                    <input type="checkbox" checked={toolsOnly} onChange={e => setToolsOnly(e.target.checked)} /> Only models with tool calls
                  </label>
                  <button type="button" className="btn-quiet" onClick={() => void loadModels()} disabled={modelsBusy}><Icon name="refresh" /> Reload</button>
                </div>
                <div role="listbox" aria-label="Choose a model" className="max-h-[220px] overflow-y-auto rounded-lg border border-line bg-bg p-1">
                  {shown.map(m => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={m.id === model}
                      data-model={m.id}
                      onClick={() => { setModel(m.id); resetFrom("model"); }}
                      className={`flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${m.id === model ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}
                    >
                      <span className="truncate">{m.label}</span>
                      {m.label !== m.id && <span className="truncate font-mono text-[11px] text-dim">{m.id}</span>}
                      <span className="ml-auto shrink-0 text-[11px] text-dim">{m.contextLength ? formatContext(m.contextLength) : ""}{m.tools ? "" : " · no tools"}</span>
                    </button>
                  ))}
                </div>
                {!shown.length && <div className="text-[12px] text-muted">No models match.</div>}
                {selected && !selected.tools && <div className="text-[12px] text-warn">This model doesn’t list tool calls, which AirWaves needs to edit. Test it before saving.</div>}
              </div>
            )}
          </li>

          {/* Step 3 */}
          <li aria-disabled={!keyOk || !model} className={keyOk && model ? "" : "opacity-50 pointer-events-none"}>
            <StepBadge n={3} state={modelState} title="Test the model" />
            <button type="button" className="btn-ghost" disabled={!keyOk || !model || modelState === "busy"} onClick={() => void testModel()}>
              Test {selected?.label ?? model ?? "model"}
            </button>
            {modelMsg && <div className={`text-[12px] mt-1.5 ${modelOk ? "text-ok" : "text-bad"}`} role={modelOk ? "status" : "alert"}>{modelMsg}</div>}
          </li>

          {/* Step 4 */}
          <li aria-disabled={!modelOk} className={modelOk ? "" : "opacity-50 pointer-events-none"}>
            <StepBadge n={4} state={saving ? "busy" : "idle"} title="Save" />
            <div className="flex gap-2">
              <button type="button" className="btn-primary" disabled={!keyOk || !modelOk || saving} onClick={() => void save()}>
                Save {info.label.split(" (")[0]}
              </button>
              {status.configured && <button type="button" className="btn-quiet" onClick={() => { setEditing(false); setApiKey(""); resetFrom("key"); }}>Cancel</button>}
            </div>
            <InlineError>{saveError}</InlineError>
          </li>
        </ol>
      )}
    </div>
  );
}

function formatContext(tokens: number) {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M ctx` : `${Math.round(tokens / 1000)}K ctx`;
}

function ProviderMark({ id }: { id: ApiProviderId }) {
  return (
    <span aria-hidden className={`inline-flex size-9 items-center justify-center rounded-lg text-[13px] font-bold ${id === "aistudio" ? "bg-[#1a73e8]/15 text-[#8ab4f8]" : "bg-[#6467f2]/15 text-[#a5a7ff]"}`}>
      {id === "aistudio" ? "G" : "OR"}
    </span>
  );
}

/**
 * AirWaves: the music model behind the music_generate tool. OpenRouter's audio models (Google Lyria) are listed with
 * the saved key; a sample can be generated and heard here before saving. Lyria Pro costs about $0.08 a track.
 */
function MusicSettings({ status, onChanged }: { status: ApiProviderStatus; onChanged: () => void }) {
  const [models, setModels] = useState<ApiProviderModel[] | null>(null);
  const [model, setModel] = useState(status.musicModel ?? DEFAULT_MUSIC_MODEL);
  const [loadError, setLoadError] = useState("");
  const [prompt, setPrompt] = useState("Upbeat cinematic electronic track for a drone video over the sea, 125 BPM, instrumental");
  const [testState, setTestState] = useState<StepState>("idle");
  const [testMsg, setTestMsg] = useState("");
  const [audioUrl, setAudioUrl] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    let alive = true;
    api.musicModels().then(r => {
      if (!alive) return;
      const list = r.models.some(m => m.id === model) ? r.models : [{ id: model, label: model }, ...r.models];
      setModels(list);
    }).catch(e => alive && setLoadError(errorMessage(e)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  const test = async () => {
    setTestState("busy"); setTestMsg(""); setAudioUrl(undefined); setSaved("");
    try {
      const r = await api.testMusic(model, prompt);
      if (!r.ok || !r.audioBase64) {
        setTestState("fail"); setTestMsg(r.error ?? "No audio came back."); return;
      }
      const bin = atob(r.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      setAudioUrl(URL.createObjectURL(new Blob([bytes], { type: r.mime ?? "audio/wav" })));
      setTestState("ok");
      setTestMsg(`Generated in ${((r.ms ?? 0) / 1000).toFixed(0)} s · ${((r.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB ${r.mime?.replace("audio/", "").toUpperCase() ?? ""}`);
    } catch (e) {
      setTestState("fail"); setTestMsg(errorMessage(e));
    }
  };

  const save = async () => {
    if (!status.model) return;
    setSaving(true); setSaved("");
    try {
      await api.saveApiProvider("openrouter", { model: status.model, modelLabel: status.modelLabel, enabled: status.enabled, musicModel: model });
      setSaved("Music model saved. Ask for music in any request, e.g. “compose a track for this montage and put it under the video”.");
      onChanged();
    } catch (e) {
      setSaved(""); setTestMsg(errorMessage(e)); setTestState("fail");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-4" data-section="music">
      <div className="flex items-center gap-2 mb-1">
        <Icon name="audio" />
        <span className="text-[13px] font-semibold text-fg">Music generation</span>
        <span className="text-[12px] text-muted">{status.musicModel ? `· ${status.musicModel}` : "· not set (uses Lyria 3 Pro)"}</span>
      </div>
      <p className="text-[12px] text-muted mb-3">Lets the editing agent compose a track with Google Lyria and add it to your media. About $0.08 per track on OpenRouter; a track is a whole song (around two minutes) that the edit trims to fit.</p>
      <InlineError>{loadError}</InlineError>
      <div className="flex flex-wrap gap-2 mb-2">
        <div role="listbox" aria-label="Music model" className="flex flex-wrap gap-1.5">
          {(models ?? [{ id: model, label: model }]).map(m => (
            <button key={m.id} type="button" role="option" aria-selected={m.id === model} data-music-model={m.id}
              onClick={() => { setModel(m.id); setTestState("idle"); setTestMsg(""); setAudioUrl(undefined); }}
              className={`rounded-md border px-2.5 py-1 text-[12px] ${m.id === model ? "border-hi/50 bg-raised text-fg" : "border-line text-muted hover:text-fg"}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="field flex-1 min-w-[240px] border border-line" aria-label="Sample music prompt" value={prompt} onChange={e => setPrompt(e.target.value)} />
        <button type="button" className="btn-ghost" disabled={testState === "busy" || !prompt.trim()} onClick={() => void test()}>
          {testState === "busy" ? <><Spinner className="size-3" /> Composing… (up to a minute)</> : "Generate sample"}
        </button>
        <button type="button" className="btn-primary" disabled={saving || testState !== "ok"} onClick={() => void save()}>Save music model</button>
      </div>
      {testMsg && <div className={`text-[12px] mt-1.5 ${testState === "ok" ? "text-ok" : "text-bad"}`} role={testState === "ok" ? "status" : "alert"}>{testMsg}</div>}
      {audioUrl && <audio className="mt-2 w-full" controls src={audioUrl} data-testid="music-sample" />}
      {saved && <div className="text-[12px] text-ok mt-1.5" role="status">{saved}</div>}
    </div>
  );
}
