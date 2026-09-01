# -*- coding: utf-8 -*-
import io, os, hashlib
ROOT = r'C:\ai-trading-dashboard'
NL = chr(92) + 'n'
BT = chr(96)

def rd(rel):
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p): return None, p
    return io.open(p, encoding='utf-8', newline='').read(), p

checks = []

s, p = rd('server\index.js')
if s is None: checks.append(('index.js', 'MISSING', p))
else:
    checks.append(('index.js already patched', s.count('/api/broker-specs'), ''))
    checks.append(('index.js anchor app.post strategy-settings', s.count('app.post("/api/strategy-settings", (req, res) => {'), ''))
    checks.append(('index.js mt5SymbolSpecs', s.count('let mt5SymbolSpecs = {}'), ''))

h, p = rd('dashboard\index.html')
if h is None: checks.append(('index.html', 'MISSING', p))
else:
    conf = ("  if (!confirm(" + BT + "Apply these limits?" + NL+NL
            + "Confidence gate: ${body.confidenceThreshold}%" + NL
            + "Position slots: ${body.maxConcurrentPositions}" + NL
            + "Max trades/day: ${body.maxTradesPerDay}" + NL+NL
            + "The bridge picks these up on its next poll." + BT + ")) return;")
    checks.append(('html already patched', h.count('ss-lotreality'), ''))
    checks.append(('html confirm anchor', h.count(conf), ''))
    checks.append(('html ss-fleet anchor', h.count('<div style="grid-column:1/-1" id="ss-fleet"></div>'), ''))
    checks.append(('html loadStrategySettings', h.count('async function loadStrategySettings() {'), ''))
    checks.append(('html catch{} anchor', h.count('    else{rb.style.display="none";}' + chr(10) + '  } catch {}'), ''))
    checks.append(('html placeholder anchor', h.count('Full-auto mode'), ''))
    checks.append(('html init call', h.count('loadStrategySettings();' + chr(10) + chr(10) + '// \u2500\u2500 Trading control (kill switch)'), ''))

m, p = rd('memory.py')
if m is None: checks.append(('memory.py', 'MISSING', p))
else:
    checks.append(('memory.py already patched', m.count('def _owned('), ''))
    checks.append(('memory.py add anchor', m.count('    for entry in data["entries"]:' + chr(10) + '        if entry["key"].lower() == key.lower():'), ''))
    checks.append(('memory.py sha', hashlib.sha256(m.encode('utf-8')).hexdigest()[:12], ''))

for name, val, extra in checks:
    print('%-46s %s %s' % (name, val, extra))
