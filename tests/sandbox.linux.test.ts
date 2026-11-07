import { spawnSync } from 'node:child_process';
import { bubblewrap } from '../src/server/sandbox/index.ts';
import { sandboxEscapeSuite } from './sandboxEscape.shared.ts';

// Availability preserves the install probe; escape tests also need permission to create namespaces.
const usable = process.platform === 'linux' && bubblewrap.available().ok &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true']).status === 0;

sandboxEscapeSuite(bubblewrap, usable);
