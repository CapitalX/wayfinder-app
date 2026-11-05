import { chats } from './db.ts';

// After an install finishes in the background, wake Pip in that chat to close the loop: validate the app, run its
// tests and hand over review links. Loaded lazily to avoid an import cycle with agent.ts.
export function afterInstall(chatId: string, appName: string) {
  setTimeout(async () => {
    if (!chats.get(chatId)) return;
    const { isRunning, runChat } = await import('./agent.ts');
    if (isRunning(chatId)) return;
    runChat(chatId, `${appName} just finished installing. Validate it (read-only checks), run its tests if ATF can run, then give me the review: stats, links to check, and a questions block asking what to change. Don't make any other changes in this step.`, () => {}, { system: 'Install finished: Pip is checking the app' })
      .catch((e) => console.error('follow-up failed', e));
  }, 1500);
}

// After the user settles where the work lives, wake Pip to carry on. The answer that showed the card may still be
// finishing its last line, so wait for it (up to a minute).
export function afterPlacement(chatId: string, note: string) {
  const start = Date.now();
  const tick = async () => {
    if (!chats.get(chatId)) return;
    const { isRunning, runChat } = await import('./agent.ts');
    if (isRunning(chatId)) { if (Date.now() - start < 60_000) setTimeout(tick, 1000); return; }
    runChat(chatId, note, () => {}, { system: 'Placement chosen: Pip carries on' }).catch((e) => console.error('follow-up failed', e));
  };
  setTimeout(tick, 300);
}
