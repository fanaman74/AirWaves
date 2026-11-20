import { useEffect, useState } from "react";
import type { PromptKind, SavedPrompt } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { Icon, InlineError, Spinner } from "../ui/primitives";

/** A prompt box with ✨ Improve (rewritten by the editor's own AI provider), Save, and the saved prompts of this kind. */
export function PromptTools({ kind, text, onText, agent, model, actions, rows = 5, placeholder }: {
  kind: PromptKind;
  text: string;
  onText(text: string): void;
  /** The model picked for editing, used for Improve when it is an AI provider. */
  agent?: string;
  model?: string;
  /** Extra buttons after Improve and Save. */
  actions?: React.ReactNode;
  rows?: number;
  placeholder?: string;
}) {
  const [busy, setBusy] = useState<"" | "improve" | "save">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [previous, setPrevious] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedPrompt[] | null>(null);
  const load = () => api.savedPrompts().then(r => setSaved(r.prompts.filter(p => p.kind === kind))).catch(() => setSaved([]));
  useEffect(() => { void load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const improve = async () => {
    setBusy("improve"); setError(""); setNote("");
    try {
      const r = await api.improvePrompt({ kind, text, agent, model });
      setPrevious(text);
      onText(r.text);
      setNote(`Improved with ${r.model}.`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(""); }
  };
  const save = async () => {
    setBusy("save"); setError(""); setNote("");
    try {
      await api.savePrompt({ kind, text });
      setNote("Saved.");
      await load();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(""); }
  };
  const remove = async (id: string) => {
    try { await api.deletePrompt(id); await load(); } catch (e) { setError(errorMessage(e)); }
  };

  return (
    <div className="space-y-2" data-prompt-tools={kind}>
      <textarea
        className="field w-full border border-line text-[13px] leading-snug"
        rows={rows}
        value={text}
        placeholder={placeholder}
        aria-label={kind === "music" ? "Music description" : "Editing request"}
        onChange={e => { onText(e.target.value); setNote(""); }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" data-action="improve" disabled={!text.trim() || !!busy} onClick={() => void improve()}>
          {busy === "improve" ? <Spinner className="size-3" /> : <span aria-hidden>✨</span>} Improve
        </button>
        {previous !== null && (
          <button type="button" className="btn-quiet" onClick={() => { onText(previous); setPrevious(null); setNote(""); }}>
            <Icon name="undo" /> Undo
          </button>
        )}
        <button type="button" className="btn-ghost" data-action="save-prompt" disabled={!text.trim() || !!busy} onClick={() => void save()}>
          {busy === "save" ? <Spinner className="size-3" /> : <Icon name="star" />} Save prompt
        </button>
        {actions}
        {note && <span className="text-[12px] text-ok">{note}</span>}
      </div>
      <InlineError>{error}</InlineError>
      {!!saved?.length && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted mb-1">Saved prompts</div>
          <ul className="max-h-40 overflow-auto rounded-md border border-line divide-y divide-line">
            {saved.map(p => (
              <li key={p.id} className="flex items-center gap-2 px-2 py-1.5 text-[12px]">
                <button type="button" className="flex-1 min-w-0 truncate text-left text-fg hover:underline" title={p.text}
                  onClick={() => { setPrevious(text); onText(p.text); setNote("Loaded."); }}>
                  {p.title}
                </button>
                <button type="button" className="btn-quiet" aria-label={`Delete ${p.title}`} onClick={() => void remove(p.id)}><Icon name="trash" size={12} /></button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
