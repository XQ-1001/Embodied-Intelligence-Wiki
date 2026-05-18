#!/usr/bin/env python3
"""批量添加分析层来源可靠性标签到尚未标注的 wiki 页面"""
import os, re, glob

ENTITIES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'entities')
html_files = glob.glob(os.path.join(ENTITIES_DIR, '*.html'))

# 标准分析层标签模板
ANALYSIS_LABEL = '''      <h2 id="analysis">2 分析层</h2>
      <p style="font-size:0.82rem;color:#54595d;margin-bottom:10px;">分析层数据综合来自 <span class="tag tag-info">媒体报道</span>（第三方独立报道）、<span class="tag tag-info">官网/公司自述</span>（公司官方披露）、<span class="tag tag-info">行业机构</span>（第三方行业报告）。公司自述数据与独立验证数据已在事实层标注区分，分析层观点仅供参考。</p>

      <div class="analysis-block"'''

added = 0
skipped = 0
for fp in sorted(html_files):
    with open(fp, 'r', encoding='utf-8') as f:
        content = f.read()

    # 跳过已标注的页面
    if '分析层数据综合' in content:
        skipped += 1
        continue

    # 查找分析层标题位置
    pattern = r'<h2 id="analysis">2 分析层</h2>\s*\n\s*(?=<div class="analysis-block")'
    replacement = ANALYSIS_LABEL
    new_content = re.sub(pattern, replacement, content, count=1)

    if new_content != content:
        with open(fp, 'w', encoding='utf-8') as f:
            f.write(new_content)
        added += 1
        print(f'  ✓ Added: {os.path.basename(fp)}')
    else:
        print(f'  ✗ No match: {os.path.basename(fp)}')

print(f'\nDone: {added} added, {skipped} already had label')
