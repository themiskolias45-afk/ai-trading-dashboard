# -*- coding: utf-8 -*-
import io, os
ROOT = r'C:\ai-trading-dashboard'
m = io.open(os.path.join(ROOT,'memory.py'), encoding='utf-8', newline='').read()
print('=== memory.py: lines around add_memory ===')
lines = m.split(chr(10))
for i,l in enumerate(lines):
    if 'def add_memory' in l or 'entry["key"]' in l or 'e["key"]' in l or '_load()' in l and i<130:
        print('%4d| %s' % (i+1, l))
print()
print('total lines:', len(lines))
print()
h = io.open(os.path.join(ROOT,'dashboard\index.html'), encoding='utf-8', newline='').read()
print('=== index.html: both "Full-auto mode" hits ===')
hl = h.split(chr(10))
for i,l in enumerate(hl):
    if 'Full-auto mode' in l:
        print('%5d| %s' % (i+1, l.strip()[:180]))
