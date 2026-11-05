import { describe, expect, it } from 'vitest';
import { audit } from '../src/server/db.ts';

// The header's update set pill shows when and why Pip last switched the set: the newest entry of that kind, for the
// active instance only.
describe('when Pip last switched the update set', () => {
  it('is the newest entry of that kind for that instance', () => {
    audit.add('chat-1', 'inst-a', 'update set', { name: 'Older', why: 'first' }, 'switched by Pip');
    audit.add(null, 'inst-a', 'instance', { url: 'x' }, 'something else');
    audit.add('chat-2', 'inst-b', 'update set', { name: 'Other instance', why: 'not this one' }, 'switched by Pip');
    audit.add('chat-3', 'inst-a', 'update set', { name: 'Newest', why: 'the loaner work' }, 'switched by Pip');
    const last = audit.latest('inst-a', 'update set')!;
    expect(last.chat_id).toBe('chat-3');
    expect(JSON.parse(last.input)).toMatchObject({ name: 'Newest', why: 'the loaner work' });
    expect(audit.latest('inst-c', 'update set')).toBeUndefined();
  });
});
