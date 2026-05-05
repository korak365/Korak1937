// Apify SDK - toolkit for building Apify Actors (https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Initialize Actor runtime
await Actor.init();

// Input defined in .actor/input_schema.json
const {
    startUrls = ['https://www.upwork.com/search/jobs/?q=logo%20design', 'https://www.fiverr.com/search/gigs?query=logo%20design'],
    platforms = ['Upwork', 'Fiverr'],
    timeframeDays = 30,
    maxRequestsPerCrawl = 250,
    normalizeRates = true
} = (await Actor.getInput()) ?? {};

// Proxy configuration (recommended in production)
const proxyConfiguration = await Actor.createProxyConfiguration();

// Utility: parse price-like strings into numbers (simple heuristics)
function parsePrice(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^\d.,kK]/g, '').replace(',', '.').trim();
    // handle 'k' shorthand (e.g., 5k)
    const kMatch = cleaned.match(/(\d+(\.\d+)?)k/i);
    if (kMatch) return parseFloat(kMatch[1]) * 1000;
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? null : num;
}

// Normalize Fiverr/Upwork price to hourly estimate (very approximate)
function estimateHourly(price, priceType) {
    // priceType can be 'fixed' (per gig) or 'hourly'
    if (priceType === 'hourly') return price;
    if (priceType === 'fixed') {
        // assume a default project length (e.g., 5 hours) to estimate hourly
        const defaultHours = 5;
        return price / defaultHours;
    }
    return null;
}

// Heuristic extraction tailored for listing search pages for Upwork/Fiverr.
// NOTE: Upwork and Fiverr often render content with JS and protect content; this CheerioCrawler is fast but may not work for those pages.
// If you need robust scraping for these platforms, switch to PlaywrightCrawler and respect platform ToS.
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ enqueueLinks, request, $, log }) {
        log.info('Processing', { url: request.loadedUrl });

        // Try to enqueue internal listing and detail pages (globs are examples)
        try {
            await enqueueLinks({
                globs: [
                    '**/search/**',
                    '**/search/jobs/**',
                    '**/search/gigs**',
                    '**/jobs/**',
                    '**/gig/**',
                    '**/projects/**'
                ]
            });
        } catch (err) {
            log.warning('enqueueLinks failed', { error: err.message });
        }

        const listings = [];

        // Upwork-like listing parsing (heuristic)
        $('.job-tile, .up-card-section, .up-card, [data-test="job-tile"], .job-row').each((i, el) => {
            try {
                const $el = $(el);
                const title = $el.find('.job-title, .job-tile-title, h4, a').first().text().trim() || null;
                const url = (() => {
                    const a = $el.find('a[href]').first();
                    const href = a.attr('href') || '';
                    return href.startsWith('http') ? href : (href ? new URL(href, request.loadedUrl).toString() : request.loadedUrl);
                })();
                const priceText = $el.find('.job-budget, .job-rate, .budget, .fee').first().text().trim() || null;
                const price = parsePrice(priceText);
                const priceType = priceText && priceText.toLowerCase().includes('hr') ? 'hourly' : price ? 'fixed' : null;
                const platform = request.loadedUrl.includes('upwork') ? 'Upwork' : request.loadedUrl.includes('fiverr') ? 'Fiverr' : 'unknown';
                const postedText = $el.find('.job-posted, .posted, .metadata').first().text().trim() || null;

                listings.push({
                    title,
                    url,
                    priceText,
                    price,
                    priceType,
                    platform,
                    postedText,
                    fetchedAt: new Date().toISOString()
                });
            } catch (e) {
                // continue on parse errors
            }
        });

        // Fiverr-like listing parsing (heuristic)
        $('.gig-card, .gig, .gig-item, [data-testid="gig-card"]').each((i, el) => {
            try {
                const $el = $(el);
                const title = $el.find('.gig-title, h3, .title, a').first().text().trim() || null;
                const url = (() => {
                    const a = $el.find('a[href]').first();
                    const href = a.attr('href') || '';
                    return href.startsWith('http') ? href : (href ? new URL(href, request.loadedUrl).toString() : request.loadedUrl);
                })();
                const priceText = $el.find('.price, .gig-price, .price-amount').first().text().trim() || null;
                const price = parsePrice(priceText);
                const priceType = 'fixed';
                const platform = 'Fiverr';
                const postedText = null;

                listings.push({
                    title,
                    url,
                    priceText,
                    price,
                    priceType,
                    platform,
                    postedText,
                    fetchedAt: new Date().toISOString()
                });
            } catch (e) {
                // ignore node parse errors
            }
        });

        // If no listing nodes found, try to parse detail page fields (fallback)
        if (listings.length === 0) {
            const title = $('h1, .gig-title, .job-title').first().text().trim() || null;
            if (title) {
                const priceText = $('.price, .job-budget, .gig-price, .amount').first().text().trim() || null;
                const price = parsePrice(priceText);
                const priceType = priceText && priceText.toLowerCase().includes('hr') ? 'hourly' : price ? 'fixed' : null;
                const platform = request.loadedUrl.includes('upwork') ? 'Upwork' : request.loadedUrl.includes('fiverr') ? 'Fiverr' : 'unknown';
                listings.push({
                    title,
                    url: request.loadedUrl,
                    priceText,
                    price,
                    priceType,
                    platform,
                    postedText: $('.posted, .date').first().text().trim() || null,
                    fetchedAt: new Date().toISOString()
                });
            }
        }

        // Aggregate skill-level metrics: for this simple scaffold we attempt to infer a 'skill' from the query or title.
        // In production, use more advanced NLP/keyword extraction to group by skill.
        const aggregation = {};
        for (const l of listings) {
            const skill = (() => {
                // Infer skill from title by picking first 2-3 words as a naive tag
                if (!l.title) return 'unknown';
                const words = l.title.split(/\s+/).slice(0, 3).map(w => w.replace(/[^A-Za-z0-9-]/g, '')).filter(Boolean);
                return words.join(' ').toLowerCase();
            })();

            if (!aggregation[skill]) aggregation[skill] = { skill, supplyCount: 0, demandCount: 0, avgHourly: null, priceSum: 0, priceCount: 0 };
            // supplyCount ~ number of gigs (Fiverr) or proposals (Upwork) listed (here we treat listing as supply)
            aggregation[skill].supplyCount += 1;
            // demandCount: simplistic proxy — treat Upwork jobs as demand, Fiverr gigs as supply. You can refine with input sources.
            if (l.platform && l.platform.toLowerCase().includes('upwork')) aggregation[skill].demandCount += 1;
            if (normalizeRates && l.price) {
                const hourly = estimateHourly(l.price, l.priceType);
                if (hourly) {
                    aggregation[skill].priceSum += hourly;
                    aggregation[skill].priceCount += 1;
                }
            }
        }

        // Finalize aggregated records and push to Dataset
        const now = new Date().toISOString();
        for (const key of Object.keys(aggregation)) {
            const a = aggregation[key];
            const avgHourly = a.priceCount > 0 ? a.priceSum / a.priceCount : null;
            const record = {
                skill: a.skill,
                supplyCount: a.supplyCount,
                demandCount: a.demandCount,
                avgHourly,
                timeframeDays,
                sourceUrl: request.loadedUrl,
                platforms,
                fetchedAt: now
            };
            log.info('Saving aggregation', { skill: record.skill, supplyCount: record.supplyCount, demandCount: record.demandCount });
            await Dataset.pushData(record);
        }
    }
});

await crawler.run(startUrls);

await Actor.exit();