export type MentionKind = 'agent' | 'workflow' | 'dir';

export interface Mention {
  kind: MentionKind;
  id: string;
  start: number;
  end: number;
}

export interface ResolvedMentions {
  agents: string[];
  workflows: string[];
  /** Directory id as sent by the client; the caller must check it against the index. */
  dir: string | null;
}

export interface MentionNames {
  agents: Set<string>;
  workflows: Set<string>;
}

const AT_RE = /(^|[\s(])@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

/**
 * Trusts the composer's structured mentions (validated against known names). Falls back to regex
 * parsing of `@name` only when no structure was sent, e.g. for plain pasted text.
 */
export function resolveMentions(text: string, mentions: unknown, names: MentionNames): ResolvedMentions {
  const out: ResolvedMentions = { agents: [], workflows: [], dir: null };
  const add = (list: string[], id: string) => {
    if (!list.includes(id)) list.push(id);
  };

  if (Array.isArray(mentions) && mentions.length) {
    for (const m of mentions as Partial<Mention>[]) {
      if (!m || typeof m.id !== 'string') continue;
      if (m.kind === 'agent' && names.agents.has(m.id)) add(out.agents, m.id);
      else if (m.kind === 'workflow' && names.workflows.has(m.id)) add(out.workflows, m.id);
      else if (m.kind === 'dir') out.dir = m.id; // one directory per message; the last one wins
    }
    return out;
  }

  for (const match of text.matchAll(AT_RE)) {
    const name = match[2].replace(/[.]+$/, ''); // "@writer." at the end of a sentence
    if (names.agents.has(name)) add(out.agents, name);
    else if (names.workflows.has(name)) add(out.workflows, name);
  }
  return out;
}

/** Removes workflow mentions from the text, for {{input}}. */
export function stripWorkflowMentions(text: string, mentions: unknown, workflow: string): string {
  let out = text;
  if (Array.isArray(mentions)) {
    const spans = (mentions as Mention[])
      .filter((m) => m?.kind === 'workflow' && m.id === workflow && Number.isInteger(m.start) && Number.isInteger(m.end))
      .sort((a, b) => b.start - a.start);
    for (const m of spans) if (out.slice(m.start, m.end).startsWith('@')) out = out.slice(0, m.start) + out.slice(m.end);
  }
  const esc = workflow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  out = out.replace(new RegExp(`(^|\\s)@${esc}(?![A-Za-z0-9_-])`, 'g'), '$1');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}
