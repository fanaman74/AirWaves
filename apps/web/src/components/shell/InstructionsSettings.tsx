import { useEffect, useState } from "react";
import type { Instructions } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";
import { InlineError, SectionTitle, Spinner } from "../ui/primitives";
import { PromptTools } from "./PromptTools";

/**
 * AirWaves: Settings → Instructions. The system instructions every editing run starts from, and the line added to
 * every music description, both editable and saved in the library. Also the editor's saved prompts.
 */
export function InstructionsSettings() {
  const [data, setData] = useState<Instructions | null>(null);
  const [editing, setEditing] = useState("");
  const [music, setMusic] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "editing" | "music">("");
  const [note, setNote] = useState<{ editing?: string; music?: string }>({});
  const show = (d: Instructions) => { setData(d); setEditing(d.editing ?? d.defaults.editing); setMusic(d.music ?? d.defaults.music); };
  useEffect(() => { api.instructions().then(show).catch(e => setError(errorMessage(e))); }, []);

  const save = async (key: "editing" | "music", value: string | null) => {
    setBusy(key); setError(""); setNote({});
    try {
      const d = await api.saveInstructions({ [key]: value });
      show(d);
      setNote({ [key]: value === null ? "Back to the built-in instructions." : "Saved. The next request uses it." });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(""); }
  };

  if (!data) return <section className="card p-5">{error ? <InlineError>{error}</InlineError> : <Spinner />}</section>;
  const editingChanged = editing !== (data.editing ?? data.defaults.editing);
  const musicChanged = music !== (data.music ?? data.defaults.music);

  return (
    <div className="space-y-4">
      <section className="card p-5" data-section="editing-instructions">
        <SectionTitle>Editing instructions</SectionTitle>
        <p className="text-[13px] text-muted mb-3 max-w-[680px]">
          The system instructions every editing request starts with. The tool list and the project's details are added after them.
          {data.editing === undefined ? " You're using the built-in version." : " You're using your own version."}
        </p>
        <textarea className="field w-full border border-line font-mono text-[12px] leading-snug" rows={18} value={editing}
          aria-label="Editing instructions" onChange={e => setEditing(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <button type="button" className="btn-primary" disabled={!editingChanged || !!busy} onClick={() => void save("editing", editing)}>
            {busy === "editing" && <Spinner className="size-3" />} Save instructions
          </button>
          <button type="button" className="btn-ghost" disabled={data.editing === undefined || !!busy} onClick={() => void save("editing", null)}>Reset to built-in</button>
          {editingChanged && <span className="text-[12px] text-muted">Unsaved changes</span>}
          {note.editing && <span className="text-[12px] text-ok">{note.editing}</span>}
        </div>
      </section>

      <section className="card p-5" data-section="music-instructions">
        <SectionTitle>Music instructions</SectionTitle>
        <p className="text-[13px] text-muted mb-3 max-w-[680px]">
          Added to every music description sent to the music model, for example “Always instrumental, no vocals, clean ending.”
        </p>
        <textarea className="field w-full border border-line text-[13px]" rows={3} value={music} placeholder="Nothing added"
          aria-label="Music instructions" onChange={e => setMusic(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <button type="button" className="btn-primary" disabled={!musicChanged || !!busy} onClick={() => void save("music", music)}>
            {busy === "music" && <Spinner className="size-3" />} Save music instructions
          </button>
          {note.music && <span className="text-[12px] text-ok">{note.music}</span>}
        </div>
      </section>

      <SavedPromptsSection />
      <InlineError>{error}</InlineError>
    </div>
  );
}

function SavedPromptsSection() {
  const [edit, setEdit] = useState("");
  const [music, setMusic] = useState("");
  return (
    <section className="card p-5" data-section="saved-prompts">
      <SectionTitle>Prompts</SectionTitle>
      <p className="text-[13px] text-muted mb-3 max-w-[680px]">
        Write or load a prompt, let your AI provider improve it, and save it for later. The model chips at the top right of every page open the same tools.
      </p>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <div className="text-[13px] font-medium mb-1.5">Editing prompts</div>
          <PromptTools kind="edit" text={edit} onText={setEdit} placeholder="Make a 45-second highlight of the interview…" />
        </div>
        <div>
          <div className="text-[13px] font-medium mb-1.5">Music prompts</div>
          <PromptTools kind="music" text={music} onText={setMusic} placeholder="Upbeat electronic, drone footage over the sea…" />
        </div>
      </div>
    </section>
  );
}
