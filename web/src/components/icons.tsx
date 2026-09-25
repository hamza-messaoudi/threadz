import {
  ArrowBendDownRight,
  ArrowCounterClockwise,
  ArrowUpRight,
  Brain,
  CaretRight,
  ChatText,
  FileText,
  Globe,
  Hash,
  Lock,
  MagnifyingGlass,
  PencilSimple,
  Sparkle,
  TerminalWindow,
  Trash,
  Wrench,
  X,
  type Icon,
} from '@phosphor-icons/react';

const icon = (I: Icon) => <I size={15} aria-hidden />;

/** Phosphor icons at the step rows' size (15px, regular weight). */
export const ICONS = {
  chevron: icon(CaretRight),
  terminal: icon(TerminalWindow),
  wrench: icon(Wrench),
  file: icon(FileText),
  pencil: icon(PencilSimple),
  search: icon(MagnifyingGlass),
  globe: icon(Globe),
  agent: icon(Sparkle),
  lock: icon(Lock),
  brain: icon(Brain),
  // Reply in a side thread.
  thread: icon(ChatText),
  reply: icon(ArrowBendDownRight),
  hash: icon(Hash),
  reset: icon(ArrowCounterClockwise),
  trash: icon(Trash),
  close: icon(X),
  arrow: icon(ArrowUpRight),
};
