import { createContext } from 'react';

/** Per block: `open` is true for the last block of a streaming message, whose fence may not be closed yet. */
export const BlockContext = createContext<{ open: boolean }>({ open: false });
