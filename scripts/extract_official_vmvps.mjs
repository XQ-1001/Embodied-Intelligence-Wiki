import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const ENTITIES_DIR = path.join(ROOT, 'entities');
const OUT_DIR = path.join(ROOT, '过程文件');
const STAMP = '20260528';
const OUT_JSON = path.join(OUT_DIR, `公司VMVPS官方来源重做-${STAMP}.json`);
const OUT_MD = path.join(OUT_DIR, `公司Vision-Mission-ValueProposition-Slogan-官方来源重做-${STAMP}.md`);
const OUT_CSV = path.join(OUT_DIR, `公司Vision-Mission-ValueProposition-Slogan-官方来源重做-${STAMP}.csv`);

const MAX_INTERNAL_LINKS = 5;
const MAX_FETCH_PER_COMPANY = 8;
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 900_000;

const OFFICIAL_ANCHOR_RE = /(官网|官方网站|官方|公司官网|新闻中心|官方新闻|pressroom|press release|official|website|about|about us|company|公司介绍|关于|公众号|微信)/i;
const INTERNAL_LINK_RE = /(关于|公司介绍|公司简介|企业文化|品牌|愿景|使命|价值观|新闻|资讯|加入|招聘|about|company|culture|mission|vision|values|careers|news|press)/i;
const AVOID_URL_RE = /\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|rar|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i;
const SOCIAL_RE = /(linkedin|twitter|x\.com|facebook|instagram|youtube|bilibili|douyin|kuaishou|weibo)\.com/i;

function decodeEntities(input) {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripHtml(html) {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|tr|td|th|h[1-6]|section|article|meta)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function getMeta(html) {
  const out = [];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) out.push(`Title: ${stripHtml(title)}`);
  for (const m of html.matchAll(/<meta\b([^>]+)>/gi)) {
    const attrs = m[1];
    const name = attrs.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1] || '';
    const content = attrs.match(/\bcontent=["']([^"']+)["']/i)?.[1] || '';
    if (!content) continue;
    if (/description|title|keywords/i.test(name)) out.push(`${name}: ${decodeEntities(content)}`);
  }
  return out.join('\n');
}

function normalizeWhitespace(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/["“”]+$/g, '')
    .replace(/^[：:，,。；;\s]+/, '')
    .replace(/[。；;，,、\s]+$/g, '')
    .trim();
}

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function csvEscape(s) {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

function truncate(s, n = 180) {
  const x = normalizeWhitespace(s);
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function safeUrl(base, href) {
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return null;
  try {
    return new URL(href, base).href.replace(/#.*$/, '');
  } catch {
    return null;
  }
}

function originOf(url) {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).origin;
  } catch {
    return '';
  }
}

function normalizeHomepage(raw) {
  let s = decodeEntities(String(raw || '')).trim();
  if (!s) return null;
  s = s.replace(/^网站\s*/i, '').replace(/^官网\s*/i, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.href.replace(/#.*$/, '');
  } catch {
    return null;
  }
}

function extractAnchors(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const text = truncate(stripHtml(m[2]), 80);
    const url = safeUrl(baseUrl, href);
    if (!url || AVOID_URL_RE.test(url)) continue;
    out.push({ url, text });
  }
  return uniqueBy(out, x => x.url);
}

function extractCompany(file, html) {
  const h1 = stripHtml(html.match(/<h1[^>]*class=["'][^"']*article-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const fallback = path.basename(file, '.html').replace(/-/g, ' ');
  const name = h1 || title.replace(/\s*[-|｜].*$/, '') || fallback;
  return normalizeWhitespace(name);
}

function extractOfficialCandidates(html) {
  const candidates = [];
  for (const m of html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const text = truncate(stripHtml(m[2]), 100);
    if (!href || !/^https?:\/\//i.test(href)) continue;
    if (AVOID_URL_RE.test(href) || SOCIAL_RE.test(href)) continue;
    if (OFFICIAL_ANCHOR_RE.test(text) || OFFICIAL_ANCHOR_RE.test(href)) {
      candidates.push({ url: href.replace(/#.*$/, ''), label: text || href, type: /mp\.weixin\.qq\.com/.test(href) ? '官方公众号/微信' : '官网/官方页面' });
    }
  }

  for (const m of html.matchAll(/<div class="ib-row">\s*<div class="ib-label">([^<]+)<\/div>\s*<div class="ib-value">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
    const label = stripHtml(m[1]);
    const valueHtml = m[2];
    if (!/(官网|网站|Website|网址)/i.test(label)) continue;
    const href = valueHtml.match(/href=["']([^"']+)["']/i)?.[1];
    const text = stripHtml(valueHtml);
    const url = normalizeHomepage(href || text);
    if (url && !SOCIAL_RE.test(url)) candidates.unshift({ url, label: `${label}: ${text}`, type: '官网' });
  }

  return uniqueBy(candidates, x => x.url).slice(0, 12);
}

async function fetchUrl(url) {
  try {
    const { stdout, stderr } = await execFileAsync('curl', [
      '-L',
      '--compressed',
      '--connect-timeout', '5',
      '--max-time', String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
      '--retry', '1',
      '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      '-sS',
      url,
    ], { timeout: FETCH_TIMEOUT_MS + 2000, maxBuffer: MAX_HTML_BYTES });
    return { ok: Boolean(stdout), html: stdout, error: stderr || '' };
  } catch (err) {
    return { ok: Boolean(err.stdout), html: err.stdout || '', error: err.message || String(err) };
  }
}

function scoreLink(link, homeOrigin) {
  let score = 0;
  const combined = `${link.text} ${link.url}`;
  if (!link.url.startsWith(homeOrigin)) score -= 20;
  if (/mission|vision|values|culture|about|company/i.test(combined)) score += 8;
  if (/愿景|使命|价值观|企业文化|关于|公司介绍|公司简介/.test(combined)) score += 8;
  if (/news|press|资讯|新闻|公众号|微信/i.test(combined)) score += 4;
  if (/career|join|招聘|加入/i.test(combined)) score += 2;
  if (/product|solution|产品|解决方案/i.test(combined)) score -= 2;
  return score;
}

function candidatePagesFromHomepage(homeUrl, html) {
  const origin = originOf(homeUrl);
  const anchors = extractAnchors(html, homeUrl)
    .filter(a => a.url.startsWith(origin) && INTERNAL_LINK_RE.test(`${a.text} ${a.url}`))
    .sort((a, b) => scoreLink(b, origin) - scoreLink(a, origin))
    .slice(0, MAX_INTERNAL_LINKS)
    .map(a => ({ ...a, type: '官网内页' }));

  const guessed = [
    '/about', '/about-us', '/company', '/company/about', '/about.html', '/aboutus.html',
    '/cn/about', '/cn/about-us', '/zh/about', '/public/about.html', '/news', '/press', '/careers'
  ].map(p => ({ url: `${origin}${p}`, text: p, type: '官网猜测页' }));

  return uniqueBy([...anchors, ...guessed], x => x.url).slice(0, MAX_INTERNAL_LINKS + 3);
}

function splitSentences(text) {
  return text
    .split(/(?<=[。！？!?；;])|\n+/)
    .map(s => normalizeWhitespace(s))
    .filter(s => s.length >= 6 && s.length <= 260);
}

function findExplicit(text, field) {
  const sentences = splitSentences(text);
  const configs = {
    vision: [
      /(愿景|企业愿景|公司愿景|Vision)\s*[：:]\s*([^。；;\n]{4,140})/i,
      /(我们的愿景|公司愿景|企业愿景)\s*(?:是|为|：|:)\s*([^。；;\n]{4,140})/i,
      /\b(?:our\s+)?vision\s+(?:is|:)\s*([^.\n]{8,180})/i,
    ],
    mission: [
      /(使命|企业使命|公司使命|Mission)\s*[：:]\s*([^。；;\n]{4,140})/i,
      /(我们的使命|公司使命|企业使命)\s*(?:是|为|：|:)\s*([^。；;\n]{4,140})/i,
      /\b(?:our\s+)?mission\s+(?:is|:)\s*([^.\n]{8,180})/i,
      /\bwe(?:'| a)?re on a mission to\s+([^.\n]{8,180})/i,
    ],
    slogan: [
      /(口号|标语|品牌口号|Slogan|Tagline)\s*[：:]\s*([^。；;\n]{4,120})/i,
    ],
    value: [
      /(价值主张|产品价值主张|客户价值|核心价值|定位|战略定位|公司定位|企业定位|品牌定位|Value Proposition)\s*[：:]\s*([^。；;\n]{6,180})/i,
      /(致力于|专注于|聚焦于|旨在)\s*([^。；;\n]{8,180})/,
      /\b(?:we|our platform|our robots|the company)\s+(?:enable|helps?|provides?|builds?|develops?|delivers?)\s+([^.\n]{12,200})/i,
    ],
  };
  for (const re of configs[field]) {
    const m = text.match(re);
    if (m) return truncate(m[2] || m[1], 180);
  }
  if (field === 'slogan') {
    const title = text.match(/^Title:\s*([^\n]{8,160})/i)?.[1] || '';
    const parts = title.split(/\s*[-|｜_]\s*/).map(normalizeWhitespace).filter(Boolean);
    if (parts.length > 1) {
      const tail = parts.slice(1).join(' - ');
      if (tail.length >= 4 && tail.length <= 90 && !/官网|官方网站|首页|Home/i.test(tail)) return tail;
    }
  }
  if (field === 'value') {
    const metaDesc = text.match(/(?:description|og:description|twitter:description):\s*([^\n]{20,240})/i)?.[1];
    if (metaDesc) return truncate(metaDesc, 180);
    const first = splitSentences(text).find(s => /(致力于|专注|提供|打造|赋能|平台|leading|enable|build|provide|develop)/i.test(s));
    if (first) return truncate(first, 180);
  }
  return '';
}

function chooseBetter(a, b) {
  if (!a?.value) return b;
  if (!b?.value) return a;
  const aExplicit = /(愿景|使命|口号|标语|价值主张|定位|mission|vision|slogan|tagline|value proposition)/i.test(a.evidence);
  const bExplicit = /(愿景|使命|口号|标语|价值主张|定位|mission|vision|slogan|tagline|value proposition)/i.test(b.evidence);
  if (bExplicit && !aExplicit) return b;
  if (b.value.length < a.value.length && b.value.length > 6) return b;
  return a;
}

function fieldEvidence(text, value) {
  if (!value) return '';
  const sentences = splitSentences(text);
  return sentences.find(s => s.includes(value.slice(0, Math.min(value.length, 18)))) || value;
}

async function mapPool(items, limit, worker) {
  const ret = [];
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      ret[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, run));
  return ret;
}

async function processCompany(entry, index) {
  const html = await fs.readFile(entry.filePath, 'utf8');
  const company = extractCompany(path.basename(entry.filePath), html);
  const officialCandidates = extractOfficialCandidates(html);
  const pagesToFetch = [];

  for (const c of officialCandidates) {
    const home = normalizeHomepage(c.url);
    if (!home || AVOID_URL_RE.test(home) || SOCIAL_RE.test(home)) continue;
    pagesToFetch.push({ url: home, type: c.type, label: c.label });
  }

  const homeCandidates = pagesToFetch.filter(p => !/mp\.weixin\.qq\.com/.test(p.url)).slice(0, 2);
  for (const home of homeCandidates) {
    const fetched = await fetchUrl(home.url);
    if (!fetched.html) continue;
    home.html = fetched.html;
    for (const p of candidatePagesFromHomepage(home.url, fetched.html)) pagesToFetch.push(p);
  }

  const fetchList = uniqueBy(pagesToFetch, x => x.url)
    .filter(p => !AVOID_URL_RE.test(p.url))
    .slice(0, MAX_FETCH_PER_COMPANY);

  const result = {
    index: index + 1,
    company,
    file: path.relative(ROOT, entry.filePath),
    official_urls: officialCandidates.map(x => x.url).join(' ; '),
    vision: '',
    vision_source: '',
    vision_evidence: '',
    mission: '',
    mission_source: '',
    mission_evidence: '',
    value_proposition: '',
    value_source: '',
    value_evidence: '',
    slogan: '',
    slogan_source: '',
    slogan_evidence: '',
    status: '',
    fetched_urls: [],
  };

  for (const page of fetchList) {
    const fetched = page.html ? { ok: true, html: page.html, error: '' } : await fetchUrl(page.url);
    if (!fetched.html) continue;
    result.fetched_urls.push(page.url);
    const sourceText = `${getMeta(fetched.html)}\n${stripHtml(fetched.html)}`;
    for (const [field, key] of [
      ['vision', 'vision'],
      ['mission', 'mission'],
      ['value', 'value_proposition'],
      ['slogan', 'slogan'],
    ]) {
      const value = findExplicit(sourceText, field);
      if (!value) continue;
      const candidate = {
        value,
        source: page.url,
        evidence: truncate(fieldEvidence(sourceText, value), 220),
      };
      const current = result[key] ? {
        value: result[key],
        source: result[`${key === 'value_proposition' ? 'value' : key}_source`],
        evidence: result[`${key === 'value_proposition' ? 'value' : key}_evidence`],
      } : null;
      const chosen = chooseBetter(current, candidate);
      result[key] = chosen.value;
      if (key === 'value_proposition') {
        result.value_source = chosen.source;
        result.value_evidence = chosen.evidence;
      } else {
        result[`${key}_source`] = chosen.source;
        result[`${key}_evidence`] = chosen.evidence;
      }
    }
  }

  if (!result.vision && !result.mission && !result.value_proposition && !result.slogan) {
    result.status = result.fetched_urls.length ? '已查官方来源，未找到字段明示' : '未能访问官方来源/缺少官网链接';
  } else {
    result.status = '已从官方来源抽取';
  }
  return result;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const files = (await fs.readdir(ENTITIES_DIR))
    .filter(f => f.endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map(f => ({ filePath: path.join(ENTITIES_DIR, f) }));

  const rows = await mapPool(files, CONCURRENCY, processCompany);
  await fs.writeFile(OUT_JSON, JSON.stringify(rows, null, 2));

  const summary = {
    total: rows.length,
    fetched: rows.filter(r => r.fetched_urls.length).length,
    vision: rows.filter(r => r.vision).length,
    mission: rows.filter(r => r.mission).length,
    value: rows.filter(r => r.value_proposition).length,
    slogan: rows.filter(r => r.slogan).length,
    noOfficial: rows.filter(r => !r.fetched_urls.length).length,
  };

  const md = [
    `# 公司 Vision / Mission / Value Proposition / Slogan 官方来源重做（${STAMP.slice(0, 4)}-${STAMP.slice(4, 6)}-${STAMP.slice(6, 8)}）`,
    '',
    '抽取范围：`entities/*.html` 中的公司页。抽取方式：先从 wiki 页提取官网、官方新闻、官方公众号/微信等一手链接，再抓取官网首页及“关于/公司介绍/企业文化/新闻/招聘”等内页。仅记录官方来源中能找到证据的表述；未找到明示字段时留空并在状态列标注，不再用 wiki 导语或第三方基本介绍兜底。',
    '',
    `统计：总实体页 ${summary.total}；成功访问官方来源 ${summary.fetched}；Vision ${summary.vision}；Mission ${summary.mission}；Value Proposition ${summary.value}；Slogan ${summary.slogan}；缺少或无法访问官方来源 ${summary.noOfficial}。`,
    '',
    '| # | 公司 | Vision | Mission | Value Proposition | Slogan | 官方来源/证据 | 状态 | Wiki页 |',
    '|---:|---|---|---|---|---|---|---|---|',
    ...rows.map(r => {
      const evidence = [
        r.vision_source && `Vision: ${r.vision_evidence} (${r.vision_source})`,
        r.mission_source && `Mission: ${r.mission_evidence} (${r.mission_source})`,
        r.value_source && `VP: ${r.value_evidence} (${r.value_source})`,
        r.slogan_source && `Slogan: ${r.slogan_evidence} (${r.slogan_source})`,
      ].filter(Boolean).join('<br>');
      return `| ${r.index} | ${mdEscape(r.company)} | ${mdEscape(r.vision)} | ${mdEscape(r.mission)} | ${mdEscape(r.value_proposition)} | ${mdEscape(r.slogan)} | ${mdEscape(evidence)} | ${mdEscape(r.status)} | ${mdEscape(r.file)} |`;
    }),
    '',
  ].join('\n');
  await fs.writeFile(OUT_MD, md);

  const csvHeader = [
    '公司', 'Vision', 'Vision来源URL', 'Vision证据',
    'Mission', 'Mission来源URL', 'Mission证据',
    'Value Proposition', 'VP来源URL', 'VP证据',
    'Slogan', 'Slogan来源URL', 'Slogan证据',
    '状态', '已抓取官方URL', 'Wiki页'
  ];
  const csv = [
    csvHeader.map(csvEscape).join(','),
    ...rows.map(r => [
      r.company,
      r.vision, r.vision_source, r.vision_evidence,
      r.mission, r.mission_source, r.mission_evidence,
      r.value_proposition, r.value_source, r.value_evidence,
      r.slogan, r.slogan_source, r.slogan_evidence,
      r.status, r.fetched_urls.join(' ; '), r.file,
    ].map(csvEscape).join(',')),
    '',
  ].join('\n');
  await fs.writeFile(OUT_CSV, csv);

  console.log(JSON.stringify({ summary, outputs: { json: OUT_JSON, md: OUT_MD, csv: OUT_CSV } }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
