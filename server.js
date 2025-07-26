const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:107.0) Gecko/20100101 Firefox/107.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.62",
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:102.0) Gecko/20100101 Firefox/102.0",
  "Mozilla/5.0 (Linux; Android 13; SM-A536U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPad; CPU OS 16_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/108.0.5359.112 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 Vivaldi/5.5.2805.50",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:107.0) Gecko/20100101 Firefox/107.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.3 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; SM-G991U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36"
];

class RateLimiter {
  constructor(requestsPerMinute = 30) {
    this.requestsPerMinute = requestsPerMinute;
    this.requests = [];
  }

  async acquire() {
    const now = new Date();
    // Remove requests older than 1 minute
    this.requests = this.requests.filter(
      req => now - req < 60 * 1000
    );

    if (this.requests.length >= this.requestsPerMinute) {
      // Wait until we can make another request
      const waitTime = 60 - (now - this.requests[0]) / 1000;
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      }
    }

    this.requests.push(now);
  }
}

class SearchResult {
  constructor(title, link, snippet, position) {
    this.title = title;
    this.link = link;
    this.snippet = snippet;
    this.position = position;
  }
}

class DuckDuckGoSearcher {
  constructor() {
    this.BASE_URL = "https://html.duckduckgo.com/html";
    this.rateLimiter = new RateLimiter();
  }

  formatResultsForLLM(results) {
    if (!results || results.length === 0) {
      return "No results were found for your search query. This could be due to DuckDuckGo's bot detection or the query returned no matches. Please try rephrasing your search or try again in a few minutes.";
    }

    const output = [];
    output.push(`Found ${results.length} search results:\n`);

    for (const result of results) {
      output.push(`${result.position}. ${result.title}`);
      output.push(`   URL: ${result.link}`);
      output.push(`   Summary: ${result.snippet}`);
      output.push("");  // Empty line between results
    }

    return output.join('\n');
  }

  async search(query, ctx, maxResults = 10, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.rateLimiter.acquire();

        const data = new URLSearchParams({ q: query, b: "", kl: "" });
        await ctx.info(`Searching DuckDuckGo for: ${query} (Attempt ${i + 1})`);

        const response = await axios.post(this.BASE_URL, data.toString(), {
          headers: {
            "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 30000
        });

        const $ = cheerio.load(response.data);
        if (!$) {
          await ctx.error("Failed to parse HTML response");
          continue; // Retry
        }

        const results = [];
        $('.result').each((idx, element) => {
          if (results.length >= maxResults) return false;

          const titleElem = $(element).find('.result__title a');
          const snippetElem = $(element).find('.result__snippet');
          if (!titleElem.length) return true;

          const title = titleElem.text().trim();
          let link = titleElem.attr('href');
          
          if (link && link.includes('y.js')) return true;

          if (link && link.startsWith('//duckduckgo.com/l/?uddg=')) {
            link = decodeURIComponent(link.split('uddg=')[1].split('&')[0]);
          }

          const snippet = snippetElem.length ? snippetElem.text().trim() : "";

          results.push(new SearchResult(title, link, snippet, results.length + 1));
        });

        if (results.length > 0) {
          await ctx.info(`Successfully found ${results.length} results on attempt ${i + 1}`);
          return results;
        }

        await ctx.info(`Attempt ${i + 1} returned no results, retrying...`);

      } catch (error) {
        if (error.code === 'ECONNABORTED') {
          await ctx.error(`Search request timed out on attempt ${i + 1}`);
        } else if (error.response) {
          await ctx.error(`HTTP error on attempt ${i + 1}: ${error.message}`);
        } else {
          await ctx.error(`Unexpected error on attempt ${i + 1}: ${error.message}`);
        }
        if (i === maxRetries - 1) {
          await ctx.error("Max retries reached. Search failed.");
          return [];
        }
      }
    }
    return [];
  }
}

class WebContentFetcher {
  constructor() {
    this.rateLimiter = new RateLimiter(20);
  }

  async fetchAndParse(url, ctx, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.rateLimiter.acquire();
        await ctx.info(`Fetching content from: ${url} (Attempt ${i + 1})`);

        const response = await axios.get(url, {
          headers: {
            "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
          },
          maxRedirects: 5,
          timeout: 30000
        });

        const $ = cheerio.load(response.data);
        $('script, style, nav, header, footer').remove();
        let text = $('body').text().replace(/\s+/g, ' ').trim();

        if (text) {
          if (text.length > 8000) {
            text = text.substring(0, 8000) + "... [content truncated]";
          }
          await ctx.info(`Successfully fetched content on attempt ${i + 1} (${text.length} chars)`);
          return text;
        }
        
        await ctx.info(`Attempt ${i + 1} returned no content, retrying...`);

      } catch (error) {
        if (error.code === 'ECONNABORTED') {
          await ctx.error(`Request timed out for ${url} on attempt ${i + 1}`);
        } else if (error.response) {
          await ctx.error(`HTTP error for ${url} on attempt ${i + 1}: ${error.message}`);
        } else {
          await ctx.error(`Error fetching ${url} on attempt ${i + 1}: ${error.message}`);
        }
        if (i === maxRetries - 1) {
          const finalError = `Error: Failed to fetch content after ${maxRetries} attempts.`;
          await ctx.error(finalError);
          return finalError;
        }
      }
    }
    return `Error: Failed to fetch content from ${url} after multiple retries.`;
  }
}

// Create the MCP server class
class MCPServer {
  constructor(name) {
    this.name = name;
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.tools = {};
    
    this.app.use(express.static('public'));
    this.app.use(express.json());

    this.app.post('/search', async (req, res) => {
      try {
        const { query } = req.body;
        const ctx = {
          info: async (message) => console.log(`[INFO] ${message}`),
          error: async (message) => console.error(`[ERROR] ${message}`)
        };
        const results = await this.tools.search({ query, ctx });
        res.json(results);
      } catch (error) {
        console.error('Search Error:', error);
        res.status(500).json({ error: 'An error occurred during search.' });
      }
    });
    
    // Add route to list available tools
    this.app.get('/tools', (req, res) => {
      const toolList = Object.keys(this.tools).map(name => {
        return {
          name,
          description: this.tools[name].description
        };
      });
      
      res.json({ tools: toolList });
    });
  }
  
  // Method to register a tool
  tool(description) {
    return (fn) => {
      this.tools[fn.name] = fn;
      this.tools[fn.name].description = description;
    };
  }
  
  // Start the server
  run() {
    this.app.listen(this.port, () => {
      console.log(`MCP Server "${this.name}" running on port ${this.port}`);
    });
  }
}

// Initialize MCP server and tools
const mcp = new MCPServer("ddg-search");
const searcher = new DuckDuckGoSearcher();
const fetcher = new WebContentFetcher();

// Define tools
mcp.tool("Search DuckDuckGo and return formatted results")(
  async function search({ query, maxResults = 10, ctx }) {
    try {
      const results = await searcher.search(query, ctx, maxResults);
      return results;
    } catch (error) {
      console.error(error);
      return `An error occurred while searching: ${error.message}`;
    }
  }
);

mcp.tool("Fetch and parse content from a webpage URL")(
  async function fetchContent({ url, ctx }) {
    return await fetcher.fetchAndParse(url, ctx);
  }
);

// Start the server
if (require.main === module) {
  mcp.run();
}

module.exports = { MCPServer, DuckDuckGoSearcher, WebContentFetcher, RateLimiter };