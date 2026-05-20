// SCHEMA GENERATOR - Enhanced Schema.org Structured Data Automation
// Supports: Article, FAQ, HowTo, Speakable, Organization, BreadcrumbList, Product, Review

import type { SchemaMarkup, SchemaEntity, EEATProfile, GeneratedContent } from './types';

export interface ArticleSchemaParams {
  title: string;
  description: string;
  content: string;
  author: EEATProfile['author'];
  datePublished: Date;
  dateModified?: Date;
  url: string;
  imageUrl?: string;
  organizationName: string;
  logoUrl?: string;
}

export interface FAQItem {
  question: string;
  answer: string;
}

export interface HowToStep {
  name: string;
  text: string;
  imageUrl?: string;
  url?: string;
}

export interface SpeakableSection {
  cssSelector?: string;
  xpath?: string;
}

export class SchemaGenerator {
  private organizationName: string;
  private organizationUrl: string;
  private logoUrl: string;
  private organizationSameAs: string[] = [];

  constructor(organizationName: string, organizationUrl: string, logoUrl: string = '') {
    this.organizationName = organizationName;
    this.organizationUrl = organizationUrl;
    this.logoUrl = logoUrl;
  }

  /** Phase 9 — populate Organization.sameAs with social/profile URLs. */
  setOrganizationSameAs(urls: string[]): void {
    this.organizationSameAs = (urls || []).filter((u) => /^https?:\/\//i.test(u));
  }

  generateComprehensiveSchema(content: GeneratedContent, url: string): SchemaMarkup {
    const graph: SchemaEntity[] = [];

    // Add Organization
    graph.push(this.generateOrganizationSchema());

    // Add WebSite with SearchAction
    graph.push(this.generateWebSiteSchema());

    // Add WebPage
    graph.push(this.generateWebPageSchema(url, content.title, content.metaDescription));

    // Add Article
    graph.push(this.generateArticleSchema({
      title: content.title,
      description: content.metaDescription,
      content: content.content,
      author: content.eeat.author,
      datePublished: content.generatedAt,
      url,
      organizationName: this.organizationName,
      logoUrl: this.logoUrl
    }));

    // Add BreadcrumbList
    graph.push(this.generateBreadcrumbSchema(url, content.title));

    // Extract and add FAQ if present (with enhanced extraction)
    const faqs = this.extractFAQsFromContent(content.content);
    if (faqs.length > 0) {
      graph.push(this.generateFAQSchema(faqs));
    }

    // Extract and add HowTo if present
    const steps = this.extractHowToSteps(content.content);
    if (steps.length > 0) {
      graph.push(this.generateHowToSchema(content.title, steps, url));
    }

    // Add Speakable schema for voice search optimization
    const speakableSections = this.extractSpeakableSections(content.content);
    if (speakableSections.length > 0) {
      graph.push(this.generateSpeakableSchema(url, speakableSections));
    }

    // Add Author with enhanced details
    graph.push(this.generateAuthorSchema(content.eeat.author, url));

    // Add ItemList for any list content
    const listItems = this.extractListItems(content.content);
    if (listItems.length >= 3) {
      graph.push(this.generateItemListSchema(content.title, listItems, url));
    }

    return {
      '@context': 'https://schema.org',
      '@graph': graph
    };
  }

  generateOrganizationSchema(): SchemaEntity {
    return {
      '@type': 'Organization',
      '@id': `${this.organizationUrl}/#organization`,
      'name': this.organizationName,
      'url': this.organizationUrl,
      ...(this.logoUrl && {
        'logo': {
          '@type': 'ImageObject',
          '@id': `${this.organizationUrl}/#logo`,
          'url': this.logoUrl,
          'contentUrl': this.logoUrl,
          'caption': this.organizationName
        }
      }),
      'sameAs': this.organizationSameAs,
    };
  }

  generateWebSiteSchema(): SchemaEntity {
    return {
      '@type': 'WebSite',
      '@id': `${this.organizationUrl}/#website`,
      'url': this.organizationUrl,
      'name': this.organizationName,
      'publisher': {
        '@id': `${this.organizationUrl}/#organization`
      },
      'potentialAction': {
        '@type': 'SearchAction',
        'target': {
          '@type': 'EntryPoint',
          'urlTemplate': `${this.organizationUrl}/?s={search_term_string}`
        },
        'query-input': 'required name=search_term_string'
      }
    };
  }

  generateWebPageSchema(url: string, title: string, description: string): SchemaEntity {
    return {
      '@type': 'WebPage',
      '@id': `${url}/#webpage`,
      'url': url,
      'name': title,
      'description': description,
      'isPartOf': {
        '@id': `${this.organizationUrl}/#website`
      },
      'about': {
        '@id': `${url}/#article`
      },
      'primaryImageOfPage': {
        '@id': `${url}/#primaryimage`
      }
    };
  }

  generateArticleSchema(params: ArticleSchemaParams): SchemaEntity {
    const wordCount = this.countWords(params.content);
    
    return {
      '@type': 'Article',
      '@id': `${params.url}/#article`,
      'headline': params.title,
      'description': params.description,
      'datePublished': params.datePublished.toISOString(),
      'dateModified': (params.dateModified || params.datePublished).toISOString(),
      'author': {
        '@id': `${this.organizationUrl}/#/schema/person/${this.slugify(params.author.name)}`
      },
      'publisher': {
        '@id': `${this.organizationUrl}/#organization`
      },
      'isPartOf': {
        '@id': `${params.url}/#webpage`
      },
      'mainEntityOfPage': {
        '@id': `${params.url}/#webpage`
      },
      ...(params.imageUrl && {
        'image': {
          '@type': 'ImageObject',
          '@id': `${params.url}/#primaryimage`,
          'url': params.imageUrl
        }
      }),
      'wordCount': wordCount,
      'articleSection': 'Blog',
      'inLanguage': 'en-US',
      'copyrightYear': new Date().getFullYear(),
      'copyrightHolder': {
        '@id': `${this.organizationUrl}/#organization`
      }
    };
  }

  generateFAQSchema(faqs: FAQItem[]): SchemaEntity {
    return {
      '@type': 'FAQPage',
      'mainEntity': faqs.map(faq => ({
        '@type': 'Question',
        'name': faq.question,
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': faq.answer
        }
      }))
    };
  }

  generateHowToSchema(title: string, steps: HowToStep[], url?: string): SchemaEntity {
    const totalTime = steps.length * 5; // Estimate 5 minutes per step
    
    return {
      '@type': 'HowTo',
      'name': title,
      'description': `Learn how to ${title.toLowerCase()} with this step-by-step guide.`,
      'totalTime': `PT${totalTime}M`,
      'estimatedCost': {
        '@type': 'MonetaryAmount',
        'currency': 'USD',
        'value': '0'
      },
      'step': steps.map((step, index) => ({
        '@type': 'HowToStep',
        'position': index + 1,
        'name': step.name,
        'text': step.text,
        ...(step.url && { 'url': step.url }),
        ...(step.imageUrl && {
          'image': {
            '@type': 'ImageObject',
            'url': step.imageUrl
          }
        })
      })),
      ...(url && { 'mainEntityOfPage': url })
    };
  }

  generateSpeakableSchema(url: string, sections: SpeakableSection[]): SchemaEntity {
    return {
      '@type': 'WebPage',
      '@id': `${url}/#speakable`,
      'speakable': {
        '@type': 'SpeakableSpecification',
        'cssSelector': sections.map(s => s.cssSelector).filter(Boolean),
        'xpath': sections.map(s => s.xpath).filter(Boolean)
      }
    };
  }

  generateBreadcrumbSchema(url: string, title: string): SchemaEntity {
    const urlParts = url.replace(this.organizationUrl, '').split('/').filter(p => p);
    
    const items = [
      {
        '@type': 'ListItem',
        'position': 1,
        'name': 'Home',
        'item': this.organizationUrl
      }
    ];

    let currentPath = this.organizationUrl;
    urlParts.forEach((part, index) => {
      currentPath += `/${part}`;
      items.push({
        '@type': 'ListItem',
        'position': index + 2,
        'name': index === urlParts.length - 1 ? title : this.unslugify(part),
        'item': currentPath
      });
    });

    return {
      '@type': 'BreadcrumbList',
      '@id': `${url}/#breadcrumb`,
      'itemListElement': items
    };
  }

  generateAuthorSchema(author: EEATProfile['author'], pageUrl?: string): SchemaEntity {
    return {
      '@type': 'Person',
      '@id': `${this.organizationUrl}/#/schema/person/${this.slugify(author.name)}`,
      'name': author.name,
      ...(author.credentials.length > 0 && {
        'jobTitle': author.credentials[0],
        'hasCredential': author.credentials.map(c => ({
          '@type': 'EducationalOccupationalCredential',
          'credentialCategory': c
        }))
      }),
      ...(author.expertiseAreas.length > 0 && {
        'knowsAbout': author.expertiseAreas
      }),
      ...(author.socialProfiles.length > 0 && {
        'sameAs': author.socialProfiles.map(p => p.url)
      }),
      'worksFor': {
        '@id': `${this.organizationUrl}/#organization`
      },
      ...(pageUrl && {
        'mainEntityOfPage': {
          '@id': `${pageUrl}/#webpage`
        }
      })
    };
  }

  generateItemListSchema(title: string, items: string[], url: string): SchemaEntity {
    return {
      '@type': 'ItemList',
      'name': title,
      'numberOfItems': items.length,
      'itemListElement': items.map((item, index) => ({
        '@type': 'ListItem',
        'position': index + 1,
        'name': item
      })),
      'mainEntityOfPage': url
    };
  }

  generateReviewSchema(reviewerName: string, rating: number, reviewBody: string, itemReviewed?: string): SchemaEntity {
    return {
      '@type': 'Review',
      'author': {
        '@type': 'Person',
        'name': reviewerName
      },
      'reviewRating': {
        '@type': 'Rating',
        'ratingValue': rating,
        'bestRating': 5,
        'worstRating': 1
      },
      'reviewBody': reviewBody,
      ...(itemReviewed && {
        'itemReviewed': {
          '@type': 'Thing',
          'name': itemReviewed
        }
      })
    };
  }

  generateProductSchema(
    name: string,
    description: string,
    imageUrl: string,
    price?: number,
    currency?: string,
    rating?: number,
    reviewCount?: number
  ): SchemaEntity {
    return {
      '@type': 'Product',
      'name': name,
      'description': description,
      'image': imageUrl,
      ...(price !== undefined && currency && {
        'offers': {
          '@type': 'Offer',
          'price': price,
          'priceCurrency': currency,
          'availability': 'https://schema.org/InStock'
        }
      }),
      ...(rating !== undefined && {
        'aggregateRating': {
          '@type': 'AggregateRating',
          'ratingValue': rating,
          'bestRating': 5,
          'reviewCount': reviewCount || 1
        }
      })
    };
  }

  generateVideoSchema(
    name: string,
    description: string,
    thumbnailUrl: string,
    uploadDate: Date,
    duration: string,
    contentUrl?: string,
    embedUrl?: string
  ): SchemaEntity {
    return {
      '@type': 'VideoObject',
      'name': name,
      'description': description,
      'thumbnailUrl': thumbnailUrl,
      'uploadDate': uploadDate.toISOString(),
      'duration': duration,
      ...(contentUrl && { 'contentUrl': contentUrl }),
      ...(embedUrl && { 'embedUrl': embedUrl }),
      'publisher': {
        '@id': `${this.organizationUrl}/#organization`
      }
    };
  }

  private extractFAQsFromContent(content: string): FAQItem[] {
    const faqs: FAQItem[] = [];
    
    // Enhanced FAQ extraction patterns
    const faqPatterns = [
      // Pattern 1: H3 questions followed by paragraphs
      /<h3[^>]*>\s*(?:Q\d*[:.])?\s*(.+?)<\/h3>\s*(?:<p[^>]*>(.+?)<\/p>)+/gi,
      // Pattern 2: H2/H3 with question marks
      /<h[23][^>]*>([^<]+\?)<\/h[23]>\s*<p>(.+?)<\/p>/gi,
      // Pattern 3: Strong/bold questions
      /<(?:strong|b)[^>]*>\s*(?:Q[:.])?\s*([^<]+\?)\s*<\/(?:strong|b)>\s*(?:<br\s*\/?>)?\s*(?:A[:.])?\s*(.+?)(?=<(?:strong|b)|<\/)/gi,
      // Pattern 4: Definition list style
      /<dt[^>]*>(.+?)<\/dt>\s*<dd[^>]*>(.+?)<\/dd>/gi,
      // Pattern 5: FAQ section specific
      /(?:class="[^"]*faq[^"]*")[^>]*>.*?<h[34][^>]*>(.+?)<\/h[34]>\s*<(?:p|div)[^>]*>(.+?)<\/(?:p|div)>/gi,
    ];

    faqPatterns.forEach(pattern => {
      let match;
      const regex = new RegExp(pattern.source, pattern.flags);
      while ((match = regex.exec(content)) !== null) {
        if (match[1] && match[2]) {
          const question = this.stripHtml(match[1]).trim();
          const answer = this.stripHtml(match[2]).trim();
          
          // Only add if it looks like a real Q&A
          if (question.length > 10 && answer.length > 20 && 
              (question.includes('?') || question.toLowerCase().startsWith('how') || 
               question.toLowerCase().startsWith('what') || question.toLowerCase().startsWith('why') ||
               question.toLowerCase().startsWith('when') || question.toLowerCase().startsWith('where'))) {
            // Avoid duplicates
            if (!faqs.some(f => f.question.toLowerCase() === question.toLowerCase())) {
              faqs.push({ question, answer });
            }
          }
        }
      }
    });

    return faqs.slice(0, 10);
  }

  private extractHowToSteps(content: string): HowToStep[] {
    const steps: HowToStep[] = [];
    
    // Enhanced step extraction
    const stepPatterns = [
      // Ordered list items
      /<ol[^>]*>.*?<li[^>]*>(.+?)<\/li>/gis,
      // Numbered steps
      /<(?:h[234]|p|div)[^>]*>\s*(?:Step\s*)?(\d+)[.:)\s]+(.+?)<\/(?:h[234]|p|div)>/gi,
      // List items with step keywords
      /<li[^>]*>\s*(?:<strong[^>]*>)?(?:Step\s*\d*[:.])?\s*(.+?)(?:<\/strong[^>]*>)?<\/li>/gi,
    ];
    
    // Try ordered list first
    const olMatch = content.match(/<ol[^>]*>([\s\S]*?)<\/ol>/i);
    if (olMatch) {
      const listContent = olMatch[1];
      const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liPattern.exec(listContent)) !== null) {
        const text = this.stripHtml(liMatch[1]).trim();
        if (text.length > 10) {
          steps.push({
            name: text.slice(0, 60) + (text.length > 60 ? '...' : ''),
            text: text
          });
        }
      }
    }

    // If no ordered list, try other patterns
    if (steps.length === 0) {
      stepPatterns.slice(1).forEach(pattern => {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const text = this.stripHtml(match[2] || match[1]).trim();
          if (text.length > 10) {
            steps.push({
              name: text.slice(0, 60) + (text.length > 60 ? '...' : ''),
              text: text
            });
          }
        }
      });
    }

    return steps.slice(0, 10);
  }

  private extractSpeakableSections(content: string): SpeakableSection[] {
    const sections: SpeakableSection[] = [];

    // LLM cited-quote blocks (highest signal for AI Overviews + voice)
    if (content.includes('data-llm-quote')) {
      sections.push({ cssSelector: '[data-llm-quote]' });
    }

    // Short answer / TL;DR blocks
    if (/short\s+answer|tl;?dr|quick\s+answer/i.test(content)) {
      sections.push({ cssSelector: '[class*="short-answer"], [class*="tldr"], [class*="quick-answer"]' });
    }

    // Key takeaways
    if (content.includes('key-takeaways') || /key\s+takeaways?/i.test(content)) {
      sections.push({ cssSelector: '.key-takeaways, [class*="takeaway"]' });
    }

    // Article introduction (first paragraph after h1)
    sections.push({ cssSelector: 'article > p:first-of-type' });

    // FAQ answers
    if (/faq|frequently\s+asked/i.test(content)) {
      sections.push({ cssSelector: 'details > div, .faq-answer, [class*="faq"] p' });
    }

    return sections;
  }

  private extractListItems(content: string): string[] {
    const items: string[] = [];
    
    // Extract from unordered lists
    const ulPattern = /<ul[^>]*>([\s\S]*?)<\/ul>/gi;
    let ulMatch;
    while ((ulMatch = ulPattern.exec(content)) !== null) {
      const listContent = ulMatch[1];
      const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liPattern.exec(listContent)) !== null) {
        const text = this.stripHtml(liMatch[1]).trim();
        if (text.length > 5 && text.length < 200) {
          items.push(text);
        }
      }
    }

    return items.slice(0, 10);
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/\s+/g, ' ')
      .trim();
  }

  private countWords(content: string): number {
    return this.stripHtml(content).split(/\s+/).filter(w => w.length > 0).length;
  }

  private slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  private unslugify(slug: string): string {
    return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  toScriptTag(schema: SchemaMarkup): string {
    return `<script type="application/ld+json">${JSON.stringify(schema, null, 2)}</script>`;
  }

  /**
   * Phase 9 — deeper @graph: append DefinedTerm/Thing nodes for each entity
   * and add `mentions` references on the Article node so AI engines can
   * resolve named entities directly.
   */
  enrichGraphWithEntityMentions(schema: SchemaMarkup, entities: string[], pageUrl: string): SchemaMarkup {
    if (!schema || !Array.isArray(schema['@graph']) || !entities?.length) return schema;
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const unique = Array.from(new Set(entities.map((e) => (e || '').trim()).filter((e) => e.length >= 3))).slice(0, 25);
    if (!unique.length) return schema;

    const thingNodes = unique.map((name) => ({
      '@type': 'DefinedTerm',
      '@id': `${pageUrl}/#/term/${slug(name)}`,
      'name': name,
      'inDefinedTermSet': {
        '@id': `${pageUrl}/#topic-vocabulary`,
      },
    }));

    const article = (schema['@graph'] as any[]).find((n) => n['@type'] === 'Article' || n['@type'] === 'TechArticle');
    if (article) {
      article.mentions = unique.map((name) => ({ '@id': `${pageUrl}/#/term/${slug(name)}` }));
    }

    (schema['@graph'] as any[]).push({
      '@type': 'DefinedTermSet',
      '@id': `${pageUrl}/#topic-vocabulary`,
      'name': 'Topic vocabulary',
      'hasDefinedTerm': unique.map((name) => ({ '@id': `${pageUrl}/#/term/${slug(name)}` })),
    });
    (schema['@graph'] as any[]).push(...thingNodes);

    return schema;
  }

  // Validate schema against Google's requirements
  validateSchema(schema: SchemaMarkup): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!schema['@context']) {
      errors.push('Missing @context');
    }

    if (!schema['@graph'] || !Array.isArray(schema['@graph'])) {
      errors.push('Missing @graph array');
    } else {
      schema['@graph'].forEach((entity, index) => {
        if (!entity['@type']) {
          errors.push(`Entity ${index} missing @type`);
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }
}

export function createSchemaGenerator(
  organizationName: string,
  organizationUrl: string,
  logoUrl?: string
): SchemaGenerator {
  return new SchemaGenerator(organizationName, organizationUrl, logoUrl || '');
}
