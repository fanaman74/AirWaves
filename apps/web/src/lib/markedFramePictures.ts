import { api } from "./client";

/** The pictures of marked frames sent from this window, by attachment id, so the chat shows one at once, before the engine has it. */
const sent = new Map<string, string>();

export function rememberMarkedFrame(attachmentId: string, picture: Blob) {
  if (typeof URL.createObjectURL === "function") sent.set(attachmentId, URL.createObjectURL(picture));
}

/** Where a request's marked frame is: this window's copy, or the project's attachment the engine keeps. */
export function markedFrameUrl(projectId: string, attachmentId: string) {
  return sent.get(attachmentId) ?? api.fileUrl(`/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`);
}
