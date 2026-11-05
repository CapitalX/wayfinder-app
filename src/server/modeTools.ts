import type { Mode } from './prompts.ts';
import { INSTANCE_WRITES } from './instanceReads.ts';

// Which tools each mode gets. Explore, Mockup and Decide only read; Debug reads and keeps the investigation board;
// Build gets everything. Two layers: tools a mode can't use are taken out of the model's context (fewer tokens, and
// Pip doesn't reach for them), and canUseTool refuses any instance change outside Build anyway (policy.ts).
// The instance server also omits its write tools outside Build.

export const WRITES_IN: Record<Mode, boolean> = { explore: false, mockup: false, decide: false, debug: false, build: true };
const BOARD_WRITES = ['mcp__project__board_pin', 'mcp__project__board_update'];
// The same names as pdiTools.ts PDI_WRITE_TOOLS (a test keeps them equal); listed here so prompts.ts can import this file.
export const PDI_CHANGES = ['mcp__pdi__activate_plugin', 'mcp__pdi__install_store_app', 'mcp__pdi__use_update_set', 'mcp__pdi__note_update_set'];

// The placement card only comes before a change, so read-only modes don't need it either.
// check_screen is the screen kit's checker: only Mockup draws screens.
export function hiddenTools(mode: Mode): string[] {
  const screen = mode === 'mockup' ? [] : ['mcp__project__check_screen'];
  if (WRITES_IN[mode]) return screen;
  return [...[...INSTANCE_WRITES].map((n) => `mcp__instance__${n}`), ...PDI_CHANGES, 'mcp__pdi__placement', ...(mode === 'debug' ? [] : BOARD_WRITES), ...screen];
}

export const READ_ONLY = (mode: Mode) =>
  `This mode is read-only: ${mode === 'debug' ? 'you can read the instance and keep the investigation board, but' : 'you can read the instance, but'} you can't change it here (no record or script changes, plugin activations, installs, update set switches or notes). When a change is the answer, describe it exactly (table, record, fields, script) and tell the user to switch the chat to Build to make it; they can turn plugins on from the Features panel.`;

export const refusal = (mode: Mode) => `This chat is in ${mode[0].toUpperCase()}${mode.slice(1)} mode, which only reads the instance. Describe the change and tell the user to switch the chat to Build to make it.`;
