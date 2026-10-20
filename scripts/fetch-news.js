// scripts/fetch-news.js
import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { setTimeout as sleep } from 'timers/promises';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChinaNewsDigest/1.0)' },
});

// ── 1. RSS 源配置 ──────────────────────────────────────────────
// RSSHub 公共实例在中国大陆可能被屏蔽，见文末「注意事项」。
// 如果某个源失效，换成备用源或自托管 RSSHub 地址即可。
const FEEDS = [
  // ── Original feeds ────────────────────────────────────────
  { url: 'http://www.people.com.cn/rss/politics.xml', category: 'Politics' },
  { url: 'https://rsshub.app/thepaper/channel/25950', category: 'Politics' },
  { url: 'https://rsshub.app/thepaper/channel/26161', category: 'Foreign Policy' },
  { url: 'http://www.people.com.cn/rss/world.xml', category: 'Foreign Policy' },
  { url: 'https://rsshub.app/caixin/latest', category: 'Politics' },
  { url: 'https://rsshub.app/thepaper/channel/25951', category: 'Economy' },

  // ── New feeds ─────────────────────────────────────────────
  // Global economy
  { url: 'https://rsshub.app/wallstreetcn/news/global', category: 'Global Economy' },
  { url: 'https://rsshub.app/yicai/brief', category: 'Global Economy' },

  // American politics / foreign policy
  // (Chinese outlets cover US news inside their world sections;
  //  the keyword pass promotes US-specific items to the right bucket)
  { url: 'https://rsshub.app/guancha/headline', category: 'American Politics' },
  { url: 'https://rsshub.app/huanqiu/news', category: 'American Foreign Policy' },
];

// ── 2. 关键词归类（覆盖 infra / 气候 / 供应链）────────────────
const KEYWORDS = {
  基建: ['基建', '高铁', '铁路', '公路', '大桥', '水利', '工程', '投资', '港口', '机场', '电站'],
  气候: ['气候', '碳达峰', '碳中和', '气象', '环保', '绿色', '排放', '生态', '新能源'],
  供应链: ['供应链', '产业链', '物流', '芯片', '半导体', '外贸', '出口', '进口', '制造业'],
};

function refineCategory(item) {
  const text = `${item.title || ''} ${item.contentSnippet || ''}`;
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    if (words.some((w) => text.includes(w))) return cat;
  }
  return item.category;
}

// ── 3. 文章页提取：副标题 + 首段 ──────────────────────────────
async function extractArticle(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    });
    const $ = cheerio.load(html);

    // 副标题：尝试常见的 class / 标签组合
    const subheading =
      $('[class*="subtitle"], [class*="sub-title"], [class*="subhead"]')
        .first()
        .text()
        .trim() ||
      $('h2').first().text().trim() ||
      '';

    // 首段：优先在常见正文容器里找，找不到再回退到全页第一个够长的 <p>
    const containers = [
      '.article-content p',
      '.content p',
      '#content p',
      '.post-content p',
      'article p',
      '.main-content p',
    ];
    let firstParagraph = '';
    for (const sel of containers) {
      const p = $(sel).first();
      if (p.length && p.text().trim().length > 20) {
        firstParagraph = p.text().trim();
        break;
      }
    }
    if (!firstParagraph) {
      $('p').each((_, el) => {
        const t = $(el).text().trim();
        if (t.length > 30) {
          firstParagraph = t;
          return false; // break
        }
      });
    }

    return { subheading, firstParagraph };
  } catch (e) {
    console.warn(`提取失败 ${url}: ${e.message}`);
    return { subheading: '', firstParagraph: '' };
  }
}

// ── 4. 主流程 ─────────────────────────────────────────────────
async function main() {
  const collected = [];
  const seenLinks = new Set();

  for (const feed of FEEDS) {
    let parsed;
    try {
      parsed = await parser.parseURL(feed.url);
    } catch (e) {
      console.warn(`RSS 拉取失败 ${feed.url}: ${e.message}`);
      continue;
    }

    // 每个源最多取前 8 条，防止单一源垄断
    for (const item of parsed.items.slice(0, 8)) {
      if (!item.link || seenLinks.has(item.link)) continue;
      seenLinks.add(item.link);

      collected.push({
        title: item.title?.trim() || '',
        link: item.link,
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        category: feed.category,
        contentSnippet: item.contentSnippet || item.content || '',
      });
    }
  }

  // 关键词二次归类
  for (const item of collected) {
    item.category = refineCategory(item);
  }

  // 按发布时间倒序，取前 20 条
  collected.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const top20 = collected.slice(0, 20);

  // 逐篇提取正文首段（加延迟，避免请求过密）
  for (const story of top20) {
    const { subheading, firstParagraph } = await extractArticle(story.link);
    story.subheading = subheading;
    story.firstParagraph = firstParagraph;
    delete story.contentSnippet;
    await sleep(400);
  }

  fs.writeFileSync('data.json', JSON.stringify(top20, null, 2), 'utf-8');
  console.log(`✅ 已写入 data.json，共 ${top20.length} 条`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
