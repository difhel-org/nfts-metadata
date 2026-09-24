import { readFileSync } from 'node:fs';
import { runTolkCompiler } from '@ton/tolk-js';
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
for (const name of ['NftItem', 'NftCollection']) {
  const result = await runTolkCompiler({
    entrypointFileName: `contracts/nft-v1.1/${name}.tolk`,
    fsReadCallback: path => readFileSync(resolve(root, path), 'utf8'),
    optimizationLevel: 2,
  });
  if (result.status === 'error') throw new Error(result.message);
  await Bun.write(resolve(root, `artifacts/${name}.json`), JSON.stringify({
    source: 'https://github.com/difhel/acton-contracts/tree/d360e771c489899cdb007b4b2fcb92d993aa742d/nft-v1.1',
    compiler: `@ton/tolk-js ${result.tolkVersion}`,
    codeHashHex: result.codeHashHex,
    codeBoc64: result.codeBoc64,
  }, null, 2) + '\n');
  console.log(`${name}: ${result.codeHashHex}`);
}
