/* Equivalence control: the indexed lab_registry vs the untouched pre-change copy.
   Both are loaded from tasks/ so __dirname -> the same REGISTRY file. Read-only. */
const NEW = require('./lab_registry.cjs');
const OLD = require('./_ref_lab_registry_ORIGINAL.cjs');

const rows = OLD.readAll();
console.log('registry rows                 = ' + rows.length);

const byFam = new Map();
const specs = [];
for (const r of rows) {
  if (!r || !r.spec || !r.family) continue;
  if (!byFam.has(r.family)) { byFam.set(r.family, r.spec); }
  specs.push(r.spec);
}
console.log('distinct families             = ' + byFam.size);

// every family, plus a deterministic spread of 500 individual specs
const sample = [...byFam.values()];
const step = Math.max(1, Math.floor(specs.length / 500));
for (let i = 0; i < specs.length; i += step) sample.push(specs[i]);
console.log('specs compared                = ' + sample.length);

let tBad = 0, sBad = 0, pBad = 0;
for (const spec of sample) {
  if (OLD.trialsFor(spec) !== NEW.trialsFor(spec)) tBad++;
  const so = OLD.siblings(spec), sn = NEW.siblings(spec);
  if (JSON.stringify(so) !== JSON.stringify(sn)) sBad++;
  if (JSON.stringify(OLD.plateau(spec)) !== JSON.stringify(NEW.plateau(spec))) pBad++;
}
console.log('');
console.log('trialsFor mismatches          = ' + tBad);
console.log('siblings  mismatches          = ' + sBad);
console.log('plateau   mismatches          = ' + pBad);
console.log('');
console.log((tBad + sBad + pBad) === 0 ? 'EQUIVALENT — identical on every spec compared'
                                       : 'NOT EQUIVALENT — DO NOT SHIP');
process.exit((tBad + sBad + pBad) === 0 ? 0 : 1);
