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

const CONCURRENCY = 5;
const SEARCH_TIMEOUT_MS = 12000;
const FETCH_TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 1_200_000;
const MAX_SEARCH_ITEMS = 8;
const MAX_OFFICIAL_PAGES = 6;

const THIRD_PARTY_DOMAINS = [
  'baidu.com', 'baike.baidu.com', 'aiqicha.baidu.com', 'qcc.com', 'tianyancha.com',
  'qixin.com', 'qizhidao.baidu.com', 'liepin.com', 'kanzhun.com', 'zhipin.com',
  '36kr.com', 'pedaily.cn', 'cyzone.cn', 'iyiou.com', 'sohu.com', 'sina.com',
  '163.com', 'qq.com', 'toutiao.com', 'zhihu.com', 'wikipedia.org', 'wikitia.com',
  'crunchbase.com', 'pitchbook.com', 'dealroom.co', 'itjuzi.com', 'equalocean.com',
  'thepaper.cn', 'jiemian.com', 'nbd.com.cn', 'stcn.com', 'futunn.com', 'xueqiu.com',
  'robotics247.com', 'therobotreport.com', 'techcrunch.com', 'forbes.com', 'bloomberg.com',
  'linkedin.com', 'facebook.com', 'instagram.com', 'youtube.com', 'x.com', 'twitter.com',
  'bilibili.com', 'douyin.com', 'weibo.com',
  'gongkong.com', 'iianews.com', 'robot-china.com', 'hippo-robot.com', 'prompt.cn',
  'cambridge.org', 'collinsdictionary.com', 'meetboston.com', 'boston.com',
  'chinaagv.com', 'imrobotic.com', 'ofweek.com', 'gg-robot.com', 'cctime.com',
  'chinaz.com', 'aibase.com', 'aitop100.cn', 'toolify.ai',
  'sina.com.cn', 'tsinghua.org.cn', 'ai-bot.cn', 'daguoai.com', 'highbay.cn',
  'sparkrobot.net', 'itlady.com', 'leshanvc.com', 'dav01.com', 'hdu.edu.cn',
  'tuchong.com',
];

const BAD_URL_RE = /\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|rar|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i;
const OFFICIAL_HINT_RE = /(官网|官方网站|official|home|homepage|首页|机器人-|robotics|technology|technologies|ai|inc\.?|ltd\.?|co\.?|corp\.?|公司)/i;
const INTERNAL_RE = /(关于|公司|简介|使命|愿景|价值观|文化|品牌|新闻|资讯|加入|招聘|about|company|mission|vision|values|culture|careers|news|press|blog)/i;
const THIRD_PARTY_TITLE_RE = /(百科|词典|Dictionary|导航|名录|黄页|工商|企查|天眼查|爱企查|招聘|找工作|资料下载|合作企业网站|收录|项目库|企业库|媒体|资讯|新闻|报道|PROMPT|河马机器人|机器人网|中国工控网|中国AGV网|OFweek|大国Ai|大国AI|网址|经销商|代理商|投资信息参考服务|免责声明|本站)/i;
const PAGE_THIRD_PARTY_RE = /(百科|词典|Dictionary|导航|名录|黄页|工商|企查|天眼查|爱企查|找工作|资料下载|合作企业网站|收录|项目库|企业库|PROMPT|河马机器人|中国工控网|中国AGV网|OFweek|大国Ai|大国AI|经销商|代理商|投资信息参考服务)/i;

function decodeEntities(input = '') {
  return String(input)
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

function stripHtml(html = '') {
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

function normalize(s = '') {
  return decodeEntities(s)
    .replace(/\s+/g, ' ')
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

function truncate(s, n = 220) {
  const x = normalize(s);
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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function isThirdParty(url) {
  const host = hostOf(url);
  return THIRD_PARTY_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
}

function companyAliases(displayName) {
  const base = displayName
    .replace(/\s*[—|-]\s*具身智能Wiki$/i, '')
    .replace(/\s*[—|-]\s*具身智能.*$/i, '')
    .replace(/\s*[—|-]\s*.*布局$/i, '')
    .replace(/\s*\([^)]*Wiki[^)]*\)\s*/i, '')
    .trim();
  const variants = new Set([base]);
  variants.add(base.replace(/[（(].*?[）)]/g, '').trim());
  variants.add(base.replace(/-/g, ' ').trim());
  variants.add(base.split(/[（(]/)[0].trim());
  variants.add(base.split(/[—|-]/)[0].trim());
  variants.add(base.replace(/\bAI\b/gi, 'AI').trim());
  return [...variants].filter(Boolean);
}

function searchQueries(company) {
  const aliases = companyAliases(company);
  const primary = aliases[0];
  const compact = aliases.find(a => /[\u4e00-\u9fff]/.test(a)) || primary;
  const english = aliases.find(a => /^[\x00-\x7F]+$/.test(a)) || primary;
  const queries = new Set();
  if (/[\u4e00-\u9fff]/.test(compact)) {
    queries.add(`"${compact}" 官网`);
    queries.add(`"${compact}" 愿景 使命 价值观`);
    queries.add(`"${compact}" 价值主张 口号`);
    queries.add(`"${compact}" 公众号 使命`);
  }
  queries.add(`"${english}" official website`);
  queries.add(`"${english}" mission vision values`);
  queries.add(`"${english}" value proposition tagline`);
  return [...queries].slice(0, 4);
}

async function curl(url, timeoutMs, maxBytes = MAX_HTML_BYTES) {
  try {
    const { stdout } = await execFileAsync('curl', [
      '-L',
      '--compressed',
      '--connect-timeout', '5',
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '--retry', '1',
      '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      '-sS',
      url,
    ], { timeout: timeoutMs + 2500, maxBuffer: maxBytes });
    return stdout || '';
  } catch (err) {
    return err.stdout || '';
  }
}

async function bingRss(query) {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const xml = await curl(url, SEARCH_TIMEOUT_MS, 500_000);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const title = stripHtml(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const link = decodeEntities(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
    const description = stripHtml(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '');
    if (link) items.push({ title, link, description, query });
  }
  return items.slice(0, MAX_SEARCH_ITEMS);
}

function nameTokens(company) {
  const aliases = companyAliases(company).join(' ');
  const parts = aliases
    .replace(/[（()）·,，.。｜|/]/g, ' ')
    .split(/\s+/)
    .map(x => x.toLowerCase())
    .filter(x => x.length >= 2 && !/具身智能wiki|robotics|robot|technology|technologies|ai|inc|ltd|co|corp|公司|科技|机器人/.test(x));
  return [...new Set(parts)].slice(0, 8);
}

function compactToken(s) {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function significantTokens(company) {
  const aliases = companyAliases(company);
  const out = [];
  for (const alias of aliases) {
    const compact = compactToken(alias);
    if (/[\u4e00-\u9fff]/.test(compact) && compact.length >= 2) {
      out.push(compact.slice(0, Math.min(4, compact.length)));
      if (compact.length >= 4) out.push(compact);
    }
    for (const token of alias.split(/[^a-z0-9]+/i).filter(Boolean)) {
      const t = token.toLowerCase();
      if (t.length >= 2 && !/^(ai|technology|technologies|inc|ltd|co|corp|the|and)$/.test(t)) out.push(t);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

function officialScore(result, company) {
  if (!/^https?:\/\//i.test(result.link) || BAD_URL_RE.test(result.link) || isThirdParty(result.link)) return -100;
  if (THIRD_PARTY_TITLE_RE.test(`${result.title} ${result.description}`)) return -100;
  const host = hostOf(result.link);
  const hostText = compactToken(host);
  const resultText = compactToken(`${result.title} ${result.description}`);
  const haystack = `${resultText} ${hostText}`;
  const tokens = significantTokens(company);
  const matched = tokens.filter(t => haystack.includes(compactToken(t)));
  const hostMatched = tokens.filter(t => hostText.includes(compactToken(t)));
  if (/mp\.weixin\.qq\.com/i.test(result.link)) return matched.length ? 35 : -100;
  if (!matched.length) return -100;
  const latinTokens = tokens.filter(t => /^[a-z0-9]+$/.test(t));
  if (latinTokens.length >= 2 && matched.filter(t => /^[a-z0-9]+$/.test(t)).length < 2) return -100;
  if (latinTokens.length >= 1 && !hostMatched.some(t => /^[a-z0-9]+$/.test(t)) && !/\b(official|官网|官方网站)\b/i.test(`${result.title} ${result.description}`)) return -100;
  let score = 0;
  for (const t of matched) {
    score += 12;
  }
  if (OFFICIAL_HINT_RE.test(`${result.title} ${result.description}`)) score += 10;
  if (/\b(official|官网|官方网站)\b/i.test(`${result.title} ${result.description}`)) score += 20;
  if (/\.edu$|\.gov$/.test(host)) score -= 10;
  if (/news|press|about|company|mission|vision|careers|culture|values/i.test(result.link)) score += 5;
  return score;
}

function extractAnchors(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const label = truncate(stripHtml(m[2]), 90);
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    try {
      const url = new URL(href, baseUrl).href.replace(/#.*$/, '');
      if (!BAD_URL_RE.test(url)) out.push({ url, label });
    } catch {
      // Ignore invalid links.
    }
  }
  return uniqueBy(out, x => x.url);
}

function scoreInternal(link, origin) {
  let score = 0;
  if (!link.url.startsWith(origin)) return -100;
  const combined = `${link.label} ${link.url}`;
  if (/mission|vision|values|culture|about|company/i.test(combined)) score += 10;
  if (/使命|愿景|价值观|企业文化|关于|公司介绍|公司简介|品牌/.test(combined)) score += 10;
  if (/news|press|资讯|新闻|blog/i.test(combined)) score += 4;
  if (/career|join|招聘|加入/i.test(combined)) score += 3;
  return score;
}

function getMetaText(html) {
  const out = [];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) out.push(`Title: ${stripHtml(title)}`);
  for (const m of html.matchAll(/<meta\b([^>]+)>/gi)) {
    const attrs = m[1];
    const key = attrs.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1] || '';
    const content = attrs.match(/\bcontent=["']([^"']+)["']/i)?.[1] || '';
    if (content && /description|title|keywords/i.test(key)) out.push(`${key}: ${decodeEntities(content)}`);
  }
  return out.join('\n');
}

function sentences(text) {
  return text
    .split(/(?<=[。！？!?；;])|\n+/)
    .map(normalize)
    .filter(s => s.length >= 6 && s.length <= 280);
}

function capture(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (!m) continue;
    const value = truncate(m[2] || m[1], 180);
    if (value) return value;
  }
  return '';
}

function extractField(text, field) {
  const explicit = {
    vision: [
      /(?:公司|企业|我们的|Our\s+)?(?:愿景|\bVision\b)\s*(?:是|为|:|：)\s*([^。\n；;]{4,160})/i,
      /\bOur vision is\s+([^.\n]{8,180})/i,
    ],
    mission: [
      /(?:公司|企业|我们的|Our\s+)?(?:使命|Mission)\s*(?:是|为|:|：)\s*([^。\n；;]{4,160})/i,
      /\bOur mission is\s+([^.\n]{8,180})/i,
      /\b(?:We are|We're) on a mission to\s+([^.\n]{8,180})/i,
    ],
    value: [
      /(?:价值主张|客户价值|核心价值|产品价值|Value Proposition)\s*(?:是|为|:|：)\s*([^。\n；;]{6,180})/i,
      /(?:公司定位|企业定位|品牌定位|战略定位|定位)\s*(?:是|为|:|：)\s*([^。\n；;]{6,180})/i,
    ],
    slogan: [
      /(?:品牌口号|宣传口号|口号|标语|Slogan|Tagline)\s*(?:是|为|:|：)\s*([^。\n；;]{3,120})/i,
    ],
  };
  const v = capture(text, explicit[field]);
  if (v) return { value: v, basis: '显式字段' };

  if (field === 'value') {
    const meta = text.match(/(?:description|og:description|twitter:description):\s*([^\n]{20,240})/i)?.[1];
    if (meta) return { value: truncate(meta, 180), basis: '官网描述' };
    const s = sentences(text).find(x => /(致力于|专注于|聚焦|提供|打造|赋能|leading|provides?|builds?|develops?|enables?)/i.test(x));
    if (s) return { value: truncate(s, 180), basis: '官网正文' };
  }
  return { value: '', basis: '' };
}

function evidenceFor(text, value) {
  if (!value) return '';
  return truncate(sentences(text).find(s => s.includes(value.slice(0, Math.min(18, value.length)))) || value, 220);
}

function choose(current, candidate) {
  if (!candidate.value) return current;
  if (!current.value) return candidate;
  const rank = x => x.basis === '显式字段' ? 3 : x.basis === '官网描述' ? 2 : 1;
  if (rank(candidate) > rank(current)) return candidate;
  return current;
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

async function companyNameFromFile(file) {
  const html = await fs.readFile(file, 'utf8');
  const h1 = stripHtml(html.match(/<h1[^>]*class=["'][^"']*article-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  return normalize(h1 || title.replace(/\s*[—|-]\s*具身智能Wiki.*$/i, '') || path.basename(file, '.html').replace(/-/g, ' '));
}

async function processCompany(file, index) {
  const company = await companyNameFromFile(file);
  const queries = searchQueries(company);
  const searchItems = (await Promise.all(queries.map(bingRss))).flat();
  const officialCandidates = uniqueBy(searchItems
    .map(item => ({ ...item, score: officialScore(item, company) }))
    .filter(item => item.score >= 15)
    .sort((a, b) => b.score - a.score), item => item.link)
    .slice(0, 4);

  const pages = [];
  for (const item of officialCandidates) {
    pages.push({ url: item.link, source: '搜索结果', searchTitle: item.title, query: item.query, score: item.score });
    const html = await curl(item.link, FETCH_TIMEOUT_MS);
    if (!html) continue;
    const origin = originOf(item.link);
    const internals = extractAnchors(html, item.link)
      .map(a => ({ ...a, score: scoreInternal(a, origin) }))
      .filter(a => a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    for (const a of internals) {
      pages.push({ url: a.url, source: '官网内页', searchTitle: a.label, query: item.query, score: item.score + a.score });
    }
  }

  const fetchPages = uniqueBy(pages, p => p.url).slice(0, MAX_OFFICIAL_PAGES);
  const fields = {
    vision: { value: '', source: '', evidence: '', basis: '' },
    mission: { value: '', source: '', evidence: '', basis: '' },
    value: { value: '', source: '', evidence: '', basis: '' },
    slogan: { value: '', source: '', evidence: '', basis: '' },
  };

  const fetched = [];
  for (const page of fetchPages) {
    const html = await curl(page.url, FETCH_TIMEOUT_MS);
    if (!html) continue;
    fetched.push(page.url);
    const text = `${getMetaText(html)}\n${stripHtml(html)}`;
    if (PAGE_THIRD_PARTY_RE.test(text.slice(0, 3000))) continue;
    for (const field of Object.keys(fields)) {
      const ex = extractField(text, field);
      if (!ex.value) continue;
      fields[field] = choose(fields[field], {
        value: ex.value,
        source: page.url,
        evidence: evidenceFor(text, ex.value),
        basis: ex.basis,
      });
    }
  }

  let status = '已搜索并抓取官方来源';
  if (!officialCandidates.length) status = '搜索未定位到可信官方来源';
  else if (!fetched.length) status = '定位到候选官方来源但抓取失败';
  else if (!fields.vision.value && !fields.mission.value && !fields.value.value && !fields.slogan.value) status = '官方来源已查，未找到字段明示';

  return {
    index: index + 1,
    company,
    wiki_file: path.relative(ROOT, file),
    search_queries: queries,
    official_candidates: officialCandidates.map(x => ({
      title: x.title,
      link: x.link,
      description: truncate(x.description, 180),
      query: x.query,
      score: x.score,
    })),
    fetched,
    vision: fields.vision,
    mission: fields.mission,
    value_proposition: fields.value,
    slogan: fields.slogan,
    status,
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const files = (await fs.readdir(ENTITIES_DIR))
    .filter(f => f.endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map(f => path.join(ENTITIES_DIR, f));

  const rows = await mapPool(files, CONCURRENCY, async (file, index) => {
    const row = await processCompany(file, index);
    if ((index + 1) % 10 === 0 || index + 1 === files.length) {
      console.error(`processed ${index + 1}/${files.length}: ${row.company}`);
    }
    return row;
  });
  await fs.writeFile(OUT_JSON, JSON.stringify(rows, null, 2));

  const summary = {
    total: rows.length,
    officialLocated: rows.filter(r => r.official_candidates.length).length,
    fetched: rows.filter(r => r.fetched.length).length,
    vision: rows.filter(r => r.vision.value).length,
    mission: rows.filter(r => r.mission.value).length,
    value: rows.filter(r => r.value_proposition.value).length,
    slogan: rows.filter(r => r.slogan.value).length,
    noOfficial: rows.filter(r => !r.official_candidates.length).length,
  };

  const md = [
    `# 公司 Vision / Mission / Value Proposition / Slogan 官方来源重做（${STAMP.slice(0, 4)}-${STAMP.slice(4, 6)}-${STAMP.slice(6, 8)}）`,
    '',
    '方法：仅使用 wiki 的公司名单，不使用 wiki 页内官网链接。对每家公司通过外部搜索重新定位官网、官方新闻、官方公众号/微信等一手来源，再抓取官方页面中的愿景、使命、价值主张、口号/标语表述。找不到官方明示时留空；Value Proposition 允许使用官网 meta description 或官网正文中的自我定位/产品价值表述，并在“依据”中标注。',
    '',
    `统计：公司 ${summary.total}；定位到候选官方来源 ${summary.officialLocated}；成功抓取官方页面 ${summary.fetched}；Vision ${summary.vision}；Mission ${summary.mission}；Value Proposition ${summary.value}；Slogan ${summary.slogan}；未定位到可信官方来源 ${summary.noOfficial}。`,
    '',
    '| # | 公司 | Vision | Mission | Value Proposition | Slogan | 来源与证据 | 状态 | Wiki页 |',
    '|---:|---|---|---|---|---|---|---|---|',
    ...rows.map(r => {
      const evidence = [
        r.vision.value && `Vision(${r.vision.basis}): ${r.vision.evidence} (${r.vision.source})`,
        r.mission.value && `Mission(${r.mission.basis}): ${r.mission.evidence} (${r.mission.source})`,
        r.value_proposition.value && `VP(${r.value_proposition.basis}): ${r.value_proposition.evidence} (${r.value_proposition.source})`,
        r.slogan.value && `Slogan(${r.slogan.basis}): ${r.slogan.evidence} (${r.slogan.source})`,
      ].filter(Boolean).join('<br>');
      return `| ${r.index} | ${mdEscape(r.company)} | ${mdEscape(r.vision.value)} | ${mdEscape(r.mission.value)} | ${mdEscape(r.value_proposition.value)} | ${mdEscape(r.slogan.value)} | ${mdEscape(evidence)} | ${mdEscape(r.status)} | ${mdEscape(r.wiki_file)} |`;
    }),
    '',
  ].join('\n');
  await fs.writeFile(OUT_MD, md);

  const header = [
    '公司',
    'Vision', 'Vision依据', 'Vision来源URL', 'Vision证据',
    'Mission', 'Mission依据', 'Mission来源URL', 'Mission证据',
    'Value Proposition', 'VP依据', 'VP来源URL', 'VP证据',
    'Slogan', 'Slogan依据', 'Slogan来源URL', 'Slogan证据',
    '状态', '候选官方来源', '搜索Query', 'Wiki页'
  ];
  const csvRows = rows.map(r => [
    r.company,
    r.vision.value, r.vision.basis, r.vision.source, r.vision.evidence,
    r.mission.value, r.mission.basis, r.mission.source, r.mission.evidence,
    r.value_proposition.value, r.value_proposition.basis, r.value_proposition.source, r.value_proposition.evidence,
    r.slogan.value, r.slogan.basis, r.slogan.source, r.slogan.evidence,
    r.status,
    r.official_candidates.map(c => `${c.title} <${c.link}>`).join(' ; '),
    r.search_queries.join(' ; '),
    r.wiki_file,
  ]);
  await fs.writeFile(OUT_CSV, [header, ...csvRows].map(row => row.map(csvEscape).join(',')).join('\n') + '\n');

  console.log(JSON.stringify({ summary, outputs: { json: OUT_JSON, md: OUT_MD, csv: OUT_CSV } }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
