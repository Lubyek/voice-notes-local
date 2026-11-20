const filler = /^(?:(?:ну|э+|эм+|м-м+|uh|um|erm)[,.!\s—-]*)+$/iu;
export function formatTime(seconds = 0) {
  const units = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds % 60)];
  return units.slice(units[0] ? 0 : 1).map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatTranscript(segments) {
  const paragraphs = [];
  let paragraph = [];
  let end = 0;
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text || filler.test(text)) continue;
    if (paragraph.length && (segment.start - end > 2 || paragraph.join(" ").length >= 350)) {
      paragraphs.push(paragraph.join(" "));
      paragraph = [];
    }
    paragraph.push(text);
    end = segment.end;
  }
  if (paragraph.length) paragraphs.push(paragraph.join(" "));
  return paragraphs.join("\n\n");
}
