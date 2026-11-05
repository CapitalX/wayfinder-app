import { describe, expect, it } from 'vitest';
import { holdFor, instanceBusy, lockInstance, releaseCall, releaseChat } from '../src/server/instanceLock.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('one chat writes to an instance at a time', () => {
  it('a second chat waits until the first releases', async () => {
    const a = await lockInstance('i1', 'chatA');
    let bGot = false;
    const b = lockInstance('i1', 'chatB').then((r) => { bGot = true; return r; });
    await tick();
    expect(bGot).toBe(false);
    expect(instanceBusy('i1')).toBe('chatA');
    a();
    (await b)();
    expect(bGot).toBe(true);
    expect(instanceBusy('i1')).toBeNull();
  });

  it('the same chat can hold it twice (calls sent together) and frees it after both', async () => {
    const one = await lockInstance('i2', 'chatA');
    const two = await lockInstance('i2', 'chatA');
    one();
    expect(instanceBusy('i2')).toBe('chatA');
    two();
    two(); // releasing twice does nothing more
    expect(instanceBusy('i2')).toBeNull();
  });

  it('other instances are not held', async () => {
    const a = await lockInstance('i3', 'chatA');
    (await lockInstance('i4', 'chatB'))();
    a();
  });

  it('stopping a waiting chat leaves the queue working', async () => {
    const a = await lockInstance('i5', 'chatA');
    const stop = new AbortController();
    const b = lockInstance('i5', 'chatB', stop.signal);
    stop.abort();
    await expect(b).rejects.toThrow('stopped');
    a();
    (await lockInstance('i5', 'chatC'))();
  });

  it('a hold ends with its tool result, or when the answer ends', async () => {
    holdFor('call1', 'chatA', await lockInstance('i6', 'chatA'));
    releaseCall('call1');
    expect(instanceBusy('i6')).toBeNull();
    holdFor('call2', 'chatA', await lockInstance('i6', 'chatA'));
    holdFor('call3', 'chatA', await lockInstance('i6', 'chatA'));
    releaseChat('chatA');
    expect(instanceBusy('i6')).toBeNull();
  });
});
