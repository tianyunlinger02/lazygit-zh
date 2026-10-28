// Legacy workflow coverage only: this code-created unlock stub is not production password coverage.
// The public CLI exposes no flag/environment/stdin password or unlock bypass.
import assert from 'node:assert/strict';
import { main } from '../dist/cli.js';
import { appDataDir } from '../dist/app-context.js';
import { Console, closeInput } from '../dist/ui.js';
const ui = new Console(undefined, undefined, { secretInput: async () => { throw new Error('legacy workflow driver must not request a secret'); } });
try {
  process.exitCode = await main(process.argv.slice(2), ui, {
    async unlock(console, directory, options) {
      assert.equal(console, ui);
      assert.equal(directory, appDataDir(), 'location must be configured before unlock');
      assert.deepEqual(options, { allowCreate: true });
      return { async close() {} };
    },
  });
} finally { closeInput(); }
