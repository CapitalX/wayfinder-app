import { secrets } from './secrets.ts';

// Prints the app login token, or with "status" the status-only token (creating it on first run).
console.log(process.argv[2] === 'status' ? secrets.statusToken() : secrets.appToken());
