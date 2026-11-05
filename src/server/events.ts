import { EventEmitter } from 'node:events';

// Live updates for the browser: jobs, the board, memories and apps announce changes here, and /api/events streams
// them, so the UI updates the moment something happens instead of checking on a timer.
export type Topic = 'jobs' | 'board' | 'memories' | 'apps' | 'chats' | 'instance' | 'lessons' | 'conventions' | 'docs' | 'routines';
export const bus = new EventEmitter();
bus.setMaxListeners(100);
export const announce = (topic: Topic, detail: Record<string, unknown> = {}) => bus.emit('change', { topic, ...detail });
