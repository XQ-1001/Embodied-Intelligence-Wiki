#!/usr/bin/env python3
"""Fix broken `<div class="analysis-block"<div class="analysis-block"` tags in all HTML files."""
import os, glob

entities_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'entities')
html_files = glob.glob(os.path.join(entities_dir, '*.html'))

fixed = 0
for fp in sorted(html_files):
    with open(fp, 'r', encoding='utf-8') as f:
        content = f.read()

    old = 'analysis-block"<div class="analysis-block"'
    new = 'analysis-block"'

    if old in content:
        content = content.replace(old, new)
        with open(fp, 'w', encoding='utf-8') as f:
            f.write(content)
        fixed += 1
        print(f'  ✓ Fixed: {os.path.basename(fp)}')

print(f'\nDone: {fixed} files fixed')
