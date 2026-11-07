import { sdkRoot } from './sdkRoot.ts';

const sdk = sdkRoot();
console.log(sdk.warning ? `warn  ${sdk.warning} Download it again in Settings → Pip.` : `ok    ServiceNow SDK ${sdk.version} (${sdk.source})`);
