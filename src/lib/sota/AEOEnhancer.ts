// src/lib/sota/AEOEnhancer.ts
// Answer-Engine + Generative-Engine Optimization injector.
// Adds the things LLM crawlers (ChatGPT/Perplexity/Google AI Overviews) reward:
//   - TL;DR + Key Takeaways block right under the H1
//   - FAQPage JSON-LD derived from existing <h3> question headings
//   - Speakable schema for the TL;DR (voice / Assistant surfacing)
//
// Idempotent: each injection is guarded by a data-attribute marker.

const stripTags = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

interface AEOOptions {
  keyword: string;
  title?: string;
  siteUrl?: string;
}

/** Pull 4-6 short, declarative bullet points from the article body. */
function extractKeyTakeaways(html: string, max = 5): string[] {
  // Prefer the first concrete sentence of each H2 section.
  const sections = html.split(/<h2[^>]*>/i).slice(1);
  const out: string[] = [];
  for (const sec of sections) {
    const para = sec.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!para) continue;
    const text = stripTags(para[1]);
    if (text.length < 50 || text.length > 220) continue;
    // Prefer paragraphs with a number/percent — those are citation-bait.
    const score = /\d/.test(text) ? 2 : 1;
    out.push(`${score}::${text}`);
    if (out.length >= max * 2) break;
  }
  return out
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, max)
    .map(s => s.slice(3));
}

/** Build a TL;DR from the article's first substantive paragraph. */
function buildTldr(html: string, keyword: string): string {
  const firstP = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const raw = firstP ? stripTags(firstP[1]) : '';
  const trimmed = raw.length > 280 ? raw.slice(0, 277).replace(/\s+\S*$/, '') + '…' : raw;
  return trimmed || `Everything you need to know about ${keyword}, distilled into a fast, practical answer.`;
}

/** Inject TL;DR + Key Takeaways panel right after the H1. Idempotent. */
export function injectAnswerBlock(html: string, opts: AEOOptions): string {
  if (html.includes('data-aeo-answer-block')) return html;
  const tldr = buildTldr(html, opts.keyword);
  const takeaways = extractKeyTakeaways(html);

  const bullets = takeaways.length > 0
    ? `<ul style="margin:12px 0 0 0;padding:0 0 0 20px;color:#1e293b;font-size:15px;line-height:1.6;">
        ${takeaways.map(t => `<li style="margin:6px 0;">${t}</li>`).join('')}
      </ul>`
    : '';

  const block = `
<aside data-aeo-answer-block="true" style="margin:24px 0 32px 0;padding:20px 22px;background:linear-gradient(135deg,#f0fdf4,#ecfeff);border-left:4px solid #10b981;border-radius:12px;font-family:'Inter',system-ui,sans-serif;">
  <div style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;letter-spacing:0.08em;color:#047857;text-transform:uppercase;">⚡ TL;DR — Quick Answer</div>
  <p style="margin:8px 0 0 0;color:#0f172a;font-size:16px;line-height:1.55;font-weight:500;">${tldr}</p>
  ${bullets ? `<div style="margin-top:14px;padding-top:14px;border-top:1px dashed #a7f3d0;"><div style="font-size:12px;font-weight:800;letter-spacing:0.08em;color:#047857;text-transform:uppercase;">Key Takeaways</div>${bullets}</div>` : ''}
</aside>`.trim();

  // Insert after first </h1>; else at top of article body.
  const h1Close = html.search(/<\/h1>/i);
  if (h1Close !== -1) {
    const insertAt = h1Close + '</h1>'.length;
    return html.slice(0, insertAt) + '\n' + block + '\n' + html.slice(insertAt);
  }
  const articleOpen = html.search(/<article[^>]*>/i);
  if (articleOpen !== -1) {
    const tagEnd = html.indexOf('>', articleOpen) + 1;
    return html.slice(0, tagEnd) + '\n' + block + '\n' + html.slice(tagEnd);
  }
  return block + '\n' + html;
}

/** Build FAQPage JSON-LD from existing question-style H3s + the paragraph that follows. */
export function buildFaqJsonLd(html: string, max = 8): string | null {
  if (html.includes('data-aeo-faq-schema')) return null;
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h[1-3][^>]*>|$)/gi;
  const items: Array<{ q: string; a: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const q = stripTags(m[1]);
    if (!/\?$|^how |^what |^why |^when |^where |^which |^who |^is |^are |^can |^should |^do |^does /i.test(q)) continue;
    const a = stripTags(m[2]).slice(0, 600);
    if (a.length < 60) continue;
    items.push({ q, a });
    if (items.length >= max) break;
  }
  if (items.length < 2) return null;

  const json = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(it => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a },
    })),
  };
  return `<script type="application/ld+json" data-aeo-faq-schema="true">${JSON.stringify(json)}</script>`;
}

/** Speakable schema marks the TL;DR for voice assistants. */
export function buildSpeakableJsonLd(opts: AEOOptions): string {
  const json = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: opts.title || opts.keyword,
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['[data-aeo-answer-block] p'],
    },
  };
  return `<script type="application/ld+json" data-aeo-speakable="true">${JSON.stringify(json)}</script>`;
}

/** Master entry: apply all AEO enhancements. Safe to call multiple times. */
export function applyAEO(html: string, opts: AEOOptions): {
  html: string;
  injected: { tldr: boolean; faqSchema: boolean; speakable: boolean };
} {
  const before = html;
  let next = injectAnswerBlock(html, opts);
  const tldrAdded = next !== before;

  const faq = buildFaqJsonLd(next);
  if (faq) next = next + '\n' + faq;

  if (!next.includes('data-aeo-speakable')) {
    next = next + '\n' + buildSpeakableJsonLd(opts);
  }

  return {
    html: next,
    injected: {
      tldr: tldrAdded,
      faqSchema: !!faq,
      speakable: !before.includes('data-aeo-speakable'),
    },
  };
}
