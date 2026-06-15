export type ParsedReleaseNotes = {
  items: string[];
  changelogUrl: string;
};

const stripMarkdown = (value: string) =>
  String(value || '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();

export const parseReleaseNotesBody = (body: string): ParsedReleaseNotes => {
  const items: string[] = [];
  let changelogUrl = '';

  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const changelogMatch = line.match(/^(?:\*\*)?Full Changelog(?:\*\*)?:?\s*(https?:\/\/\S+)/i);
    if (changelogMatch) {
      changelogUrl = changelogMatch[1];
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      const text = stripMarkdown(bulletMatch[1]);
      if (text) items.push(text);
      continue;
    }

    if (!/^#{1,6}\s/.test(line) && !/^full changelog/i.test(line)) {
      const text = stripMarkdown(line);
      if (text) items.push(text);
    }
  }

  return { items, changelogUrl };
};

export const formatReleaseDate = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};
