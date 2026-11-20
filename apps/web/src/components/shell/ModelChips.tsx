import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { DEFAULT_MUSIC_MODEL, isApiProvider, type ApiProviderStatus, type PromptKind } from "@scarlet/shared";
import { api } from "../../lib/client";
import { AGENT_LABEL } from "../../stores/hosts";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../ui/primitives";
import { PromptTools } from "./PromptTools";

const short = (model: string) => model.replace(/^[\w-]+\//, "");

/**
 * AirWaves: two chips at the top right of every page that show the model editing uses and the model music uses. Each opens a card
 * where a prompt can be improved by the editor's AI provider, saved, and sent to the request box.
 */
export function ModelChips() {
  const pick = useUiStore(s => s.agent);
  const [providers, setProviders] = useState<ApiProviderStatus[]>([]);
  const [open, setOpen] = useState<PromptKind | null>(null);
  const location = useLocation();
  const load = () => api.apiProviders().then(r => setProviders(r.providers)).catch(() => undefined);
  // Settings can change the saved models, so read again when a page changes or the window comes back.
  useEffect(() => { void load(); }, [location.pathname, location.hash]);
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const saved = isApiProvider(pick.agent) ? providers.find(p => p.id === pick.agent) : undefined;
  const editModel = pick.model ?? saved?.modelLabel ?? saved?.model;
  const editLabel = `${(AGENT_LABEL as Record<string, string>)[pick.agent] ?? pick.agent}${editModel ? ` · ${short(editModel)}` : ""}`;
  const openrouter = providers.find(p => p.id === "openrouter");
  const musicModel = openrouter?.configured ? openrouter.musicModel ?? DEFAULT_MUSIC_MODEL : undefined;
  const musicLabel = musicModel ? short(musicModel) : "Not set";

  return (
    <div className="fixed top-2 right-3 z-40 flex flex-col items-end gap-2 pointer-events-none" data-model-chips>
      <div className="flex gap-1.5 pointer-events-auto">
        <Chip active={open === "edit"} icon="film" label="Editing" value={editLabel} data="edit" onClick={() => setOpen(open === "edit" ? null : "edit")} />
        <Chip active={open === "music"} icon="audio" label="Music" value={musicLabel} data="music" muted={!musicModel} onClick={() => setOpen(open === "music" ? null : "music")} />
      </div>
      {open && (
        <ChipCard kind={open} title={open === "edit" ? editLabel : musicLabel} agent={pick.agent} model={pick.model}
          onClose={() => setOpen(null)} hasMusic={!!musicModel} />
      )}
    </div>
  );
}

function Chip({ icon, label, value, onClick, active, muted, data }: {
  icon: "film" | "audio"; label: string; value: string; onClick(): void; active: boolean; muted?: boolean; data: string;
}) {
  return (
    <button type="button" onClick={onClick} data-chip={data} aria-expanded={active}
      title={`${label}: ${value}. Click to write, improve and save a prompt.`}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] shadow-sm backdrop-blur max-w-[260px] ${active ? "border-accent bg-raised text-fg" : "border-line bg-raised/90 text-muted hover:text-fg"}`}>
      <Icon name={icon} size={12} />
      <span className="font-medium text-fg">{label}</span>
      <span className={`truncate ${muted ? "italic" : ""}`}>{value}</span>
      <span aria-hidden className="opacity-70">✨</span>
    </button>
  );
}

function ChipCard({ kind, title, agent, model, onClose, hasMusic }: {
  kind: PromptKind; title: string; agent: string; model?: string; onClose(): void; hasMusic: boolean;
}) {
  const location = useLocation();
  const inProject = location.pathname.startsWith("/p/");
  const draft = useUiStore(s => s.agentDraft);
  const setDraft = useUiStore(s => s.setAgentDraft);
  const [text, setText] = useState(kind === "edit" ? draft : "");
  const [sent, setSent] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const use = () => {
    setDraft(kind === "edit" ? text : `Make background music for this video with music_generate and place it under the edit. Music description: ${text}`);
    setSent(true);
  };

  return (
    <div ref={ref} role="dialog" aria-label={kind === "edit" ? "Editing prompt" : "Music prompt"} data-chip-card={kind}
      className="pointer-events-auto w-[min(440px,calc(100vw-24px))] rounded-xl border border-line bg-panel p-4 shadow-xl">
      <div className="flex items-start gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-fg">{kind === "edit" ? "Editing model" : "Music model"}</div>
          <div className="text-[12px] text-muted truncate">{title}</div>
        </div>
        <Link to={kind === "edit" ? "/settings#instructions" : "/settings#providers"} className="btn-quiet text-[12px]" onClick={onClose}>
          <Icon name="settings" size={12} /> {kind === "edit" ? "Instructions" : "Settings"}
        </Link>
        <button type="button" className="btn-quiet" aria-label="Close" title="Close" onClick={onClose}><Icon name="x" size={12} /></button>
      </div>
      {kind === "music" && !hasMusic && (
        <p className="text-[12px] text-muted mb-2">Music needs an OpenRouter key. <Link className="underline" to="/settings#providers" onClick={onClose}>Add one in AI providers</Link>.</p>
      )}
      <PromptTools kind={kind} text={text} onText={t => { setText(t); setSent(false); }} agent={agent} model={model}
        placeholder={kind === "edit" ? "Describe the edit you want…" : "Describe the music: mood, genre, tempo…"}
        actions={inProject && (
          <button type="button" className="btn-ghost" data-action="use" disabled={!text.trim()} onClick={use}>
            <Icon name="arrow" /> {sent ? "Added to request" : "Use in request"}
          </button>
        )} />
    </div>
  );
}
