import { describe, expect, it } from 'vitest';
import { instancePage } from '../src/server/instanceUrl.ts';

const inst = 'https://dev12345.service-now.com';

describe('instancePage', () => {
  it.each([
    ['incident.do?sys_id=abc', 'https://dev12345.service-now.com/incident.do?sys_id=abc'],
    ['/now/nav/ui/home', 'https://dev12345.service-now.com/now/nav/ui/home'],
    ['https://dev12345.service-now.com/incident_list.do?sysparm_query=active=true', 'https://dev12345.service-now.com/incident_list.do?sysparm_query=active=true'],
  ])('opens %s on this instance', (page, url) => expect(instancePage(inst, page)).toBe(url));
  it.each([
    ['https://evil.example/incident.do'],
    ['//evil.example/x'],
    ['http://dev12345.service-now.com/incident.do'],
    ['https://dev12345.service-now.com.evil.example/'],
    ['javascript:alert(1)'],
    [''],
  ])('refuses %s', (page) => expect(() => instancePage(inst, page)).toThrow());
  it('drops credentials smuggled into the address', () => {
    expect(instancePage(inst, 'https://user:pw@dev12345.service-now.com/x.do')).toBe('https://dev12345.service-now.com/x.do');
  });
});
