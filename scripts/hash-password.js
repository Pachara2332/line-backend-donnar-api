const { randomBytes, scryptSync } = require('node:crypto');
const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin, output: process.stderr });
input.question('Staff password: ', (password) => {
  input.close();
  if (password.length < 12) {
    process.stderr.write('Use at least 12 characters.\n');
    process.exitCode = 1;
    return;
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  process.stdout.write(`scrypt$${salt}$${hash}\n`);
});
