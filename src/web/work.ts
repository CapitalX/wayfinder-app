import { createContext, useContext } from 'react';

import type { BuildProgress } from './buildProgress.ts';

// The work area on the right: one place for previews, the board, the features engine and the build timeline, so
// panels never stack. The open chat hands its build progress up, since the work area lives outside the chat.
export type WorkTab = 'preview' | 'board' | 'features' | 'build';
export interface Work {
  tab: WorkTab | null;
  open: (tab: WorkTab) => void;
  show: (tab: WorkTab) => void;
  preview: (html: string) => void;
  featuresQuery: (q: string) => void;
  build: (p: BuildProgress | null) => void;
  close: () => void;
}
export const WorkCtx = createContext<Work>({ tab: null, open: () => {}, show: () => {}, preview: () => {}, featuresQuery: () => {}, build: () => {}, close: () => {} });
export const useWork = () => useContext(WorkCtx);
