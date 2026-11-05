import { describe, expect, it, vi } from 'vitest';
import { can, describeAccess, learnRefusal, parse, type AccessProfile } from '../src/server/access.ts';
import { instances } from '../src/server/db.ts';

const admin: AccessProfile = {
  user: 'wayfinder.integration', userId: 'u1', roles: ['admin', 'sn_cicd.sys_ci_automation'], admin: true, cicd: true,
  reads: { incident: true, sys_script: true, syslog: true, sys_properties: true }, denied: [], checkedAt: 0,
};
// An itil user on a real instance: it can't read its own roles, and system tables answer 403.
const itil: AccessProfile = {
  user: 'beth.anglin', userId: 'u2', roles: null, admin: null, cicd: false,
  reads: { incident: true, sys_user: true, sys_script: false, syslog: false, sys_properties: false }, denied: ['write sys_script'], checkedAt: 0,
};

describe('can', () => {
  it('assumes everything until the profile is checked', () => {
    expect(can(null)).toEqual({ known: false, install: true, build: true, write: true });
  });

  it('lets an admin with CI/CD install, build and write', () => {
    expect(can(admin)).toEqual({ known: true, install: true, build: true, write: true });
  });

  it('blocks installs and app builds for an itil user with hidden roles, but not writes', () => {
    expect(can(itil)).toEqual({ known: true, install: false, build: false, write: true });
  });

  it('blocks app installs for a non-admin even with CI/CD', () => {
    expect(can({ ...admin, admin: false, roles: ['sn_cicd.sys_ci_automation'] }).build).toBe(false);
  });

  it('treats an unknown admin flag with CI/CD as able to build', () => {
    expect(can({ ...itil, cicd: true }).build).toBe(true);
  });

  it('treats an account with only snc_internal as read-only', () => {
    expect(can({ ...itil, admin: false, roles: ['snc_internal'] }).write).toBe(false);
  });
});

describe('describeAccess', () => {
  it('says the profile is unchecked when there is none', () => {
    expect(describeAccess(null)).toMatch(/not been checked yet/);
  });

  it('names the admin and its roles', () => {
    const text = describeAccess(admin);
    expect(text).toContain('Signed in as wayfinder.integration (admin).');
    expect(text).toContain('Roles: admin, sn_cicd.sys_ci_automation.');
    expect(text).toContain('Can read: incidents, business rules, system logs, system properties.');
    expect(text).not.toMatch(/cannot install/i);
  });

  it('tells Pip what an itil user cannot reach and what was refused', () => {
    const text = describeAccess(itil);
    expect(text).toContain('cannot read its own roles');
    expect(text).toContain('Cannot read: business rules, system logs, system properties');
    expect(text).toContain('cannot install plugins or Store apps');
    expect(text).toContain('cannot install apps');
    expect(text).toContain('already refused: write sys_script');
    expect(text).toContain('rows hidden by access rules');
  });

  it('shortens a long role list', () => {
    const roles = Array.from({ length: 30 }, (_, i) => `role_${i}`);
    expect(describeAccess({ ...admin, roles })).toContain('role_24…');
  });
});

describe('parse and learnRefusal', () => {
  const inst = () => instances.create({ name: 'dev1', url: 'https://dev1.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });

  it('returns null for a missing or broken profile', () => {
    expect(parse(undefined)).toBeNull();
    const i = inst();
    expect(parse(i)).toBeNull();
    instances.update(i.id, { profile: '{not json' });
    expect(parse(instances.get(i.id))).toBeNull();
  });

  it('remembers each refusal once and keeps the last 30', () => {
    const i = inst();
    instances.update(i.id, { profile: JSON.stringify(admin) });
    learnRefusal(instances.get(i.id)!, 'write incident');
    learnRefusal(instances.get(i.id)!, 'write incident');
    expect(parse(instances.get(i.id))!.denied).toEqual(['write incident']);
    for (let n = 0; n < 40; n++) learnRefusal(instances.get(i.id)!, `read t${n}`);
    const denied = parse(instances.get(i.id))!.denied;
    expect(denied).toHaveLength(30);
    expect(denied.at(-1)).toBe('read t39');
  });

  it('does nothing without a profile', () => {
    const i = inst();
    learnRefusal(i, 'write incident');
    expect(instances.get(i.id)!.profile).toBeNull();
  });
});

describe('checkAccess asks the instance whether the account is admin', () => {
  const answers = (admin: boolean) => async (_inst: unknown, path: string) => {
    if (path.includes('gs.hasRole')) return { result: admin ? [{ sys_id: 'me1' }] : [] };
    if (path.includes('sys_user?')) return { result: [{ sys_id: 'me1', user_name: 'test.user' }] };
    if (path.includes('sys_user_has_role')) return { result: [{ 'role.name': 'itil' }] };   // inherited admin rows hidden by an ACL
    return { result: [] };
  };
  it('believes gs.hasRole over a role list that hides the admin role', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const sn = await import('../src/server/sn.ts');
    const spy = vi.spyOn(sn, 'sn').mockImplementation(answers(true) as never);
    const { checkAccess } = await import('../src/server/access.ts');
    const inst = instances.create({ name: 'dev', url: 'https://dev12345.service-now.com', client_id: 'c', login_user: 'admin', kind: 'pdi', auth: 'client_credentials', auth_user: null });
    try {
      expect((await checkAccess(inst)).admin).toBe(true);
      spy.mockImplementation(answers(false) as never);
      expect((await checkAccess(inst)).admin).toBe(false);
    } finally { spy.mockRestore(); vi.unstubAllGlobals(); }
  });
});
