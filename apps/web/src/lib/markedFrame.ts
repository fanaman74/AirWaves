import type { PictureMark } from "@scarlet/shared";

const INK = "#f4f1e9";

/**
 * The picture of the marked frame with the editor's marks drawn on it, as a PNG, for the model to look at: the frame as
 * the engine draws it, the marks in the app's own white with a dark edge so they read on any footage, and a number by
 * each when there are several.
 */
export async function markedFramePicture(url: string, marks: readonly PictureMark[]): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The frame didn't load (${response.status}).`);
  const picture = await createImageBitmap(await response.blob());
  const canvas = document.createElement("canvas");
  canvas.width = picture.width;
  canvas.height = picture.height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("The frame couldn't be drawn.");
  g.drawImage(picture, 0, 0);
  picture.close();
  const { width: w, height: h } = canvas;
  const line = Math.max(1.5, Math.max(w, h) / 320);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.shadowColor = "rgb(0 0 0 / 70%)";
  g.shadowBlur = line * 1.5;
  const numbered = marks.length > 1;
  marks.forEach((mark, i) => {
    g.strokeStyle = INK;
    g.fillStyle = INK;
    g.lineWidth = line;
    const { x, y, w: bw, h: bh } = mark.box;
    if (mark.kind === "box") g.strokeRect(x * w, y * h, bw * w, bh * h);
    else if (mark.kind === "draw" && mark.points?.length) {
      g.beginPath();
      mark.points.forEach(([px, py], k) => k ? g.lineTo(px * w, py * h) : g.moveTo(px * w, py * h));
      g.stroke();
    }
    const r = line * (numbered ? 3.4 : 2.2);
    if (mark.kind === "point" || numbered) {
      g.beginPath();
      g.arc(x * w, y * h, r, 0, Math.PI * 2);
      g.fill();
    }
    if (numbered) {
      g.shadowBlur = 0;
      g.fillStyle = "#141312";
      g.font = `700 ${Math.round(r * 1.25)}px -apple-system, system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(i + 1), x * w, y * h + r * 0.06);
      g.shadowBlur = line * 1.5;
    }
  });
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("The frame couldn't be saved.")), "image/png"));
}
