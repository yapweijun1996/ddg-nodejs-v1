const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

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
    this.HEADERS = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    };
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

  async search(query, ctx, maxResults = 10) {
    try {
      // Apply rate limiting
      await this.rateLimiter.acquire();

      // Create form data for POST request
      const data = new URLSearchParams({
        q: query,
        b: "",
        kl: ""
      });

      await ctx.info(`Searching DuckDuckGo for: ${query}`);

      const response = await axios.post(
        this.BASE_URL, 
        data.toString(),
        { 
          headers: {
            ...this.HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 30000
        }
      );

      // Parse HTML response
      const $ = cheerio.load(response.data);
      if (!$) {
        await ctx.error("Failed to parse HTML response");
        return [];
      }

      const results = [];
      $('.result').each((i, element) => {
        if (results.length >= maxResults) return false;
        
        const titleElem = $(element).find('.result__title');
        if (!titleElem.length) return true;

        const linkElem = titleElem.find('a');
        if (!linkElem.length) return true;

        const title = linkElem.text().trim();
        let link = linkElem.attr('href');

        // Skip ad results
        if (link && link.includes('y.js')) return true;

        // Clean up DuckDuckGo redirect URLs
        if (link && link.startsWith('//duckduckgo.com/l/?uddg=')) {
          link = decodeURIComponent(link.split('uddg=')[1].split('&')[0]);
        }

        const snippetElem = $(element).find('.result__snippet');
        const snippet = snippetElem.length ? snippetElem.text().trim() : "";

        results.push(new SearchResult(
          title,
          link,
          snippet,
          results.length + 1
        ));
      });

      await ctx.info(`Successfully found ${results.length} results`);
      return results;

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        await ctx.error("Search request timed out");
      } else if (error.response) {
        await ctx.error(`HTTP error occurred: ${error.message}`);
      } else {
        await ctx.error(`Unexpected error during search: ${error.message}`);
        console.error(error);
      }
      return [];
    }
  }
}

class WebContentFetcher {
  constructor() {
    this.rateLimiter = new RateLimiter(20);
  }

  async fetchAndParse(url, ctx) {
    try {
      await this.rateLimiter.acquire();

      await ctx.info(`Fetching content from: ${url}`);

      const response = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        maxRedirects: 5,
        timeout: 30000
      });

      // Parse the HTML
      const $ = cheerio.load(response.data);

      // Remove script and style elements
      $('script, style, nav, header, footer').remove();

      // Get the text content
      let text = $('body').text();

      // Clean up the text
      text = text.replace(/\s+/g, ' ').trim();

      // Truncate if too long
      if (text.length > 8000) {
        text = text.substring(0, 8000) + "... [content truncated]";
      }

      await ctx.info(`Successfully fetched and parsed content (${text.length} characters)`);
      return text;

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        await ctx.error(`Request timed out for URL: ${url}`);
        return "Error: The request timed out while trying to fetch the webpage.";
      } else if (error.response) {
        await ctx.error(`HTTP error occurred while fetching ${url}: ${error.message}`);
        return `Error: Could not access the webpage (${error.message})`;
      } else {
        await ctx.error(`Error fetching content from ${url}: ${error.message}`);
        return `Error: An unexpected error occurred while fetching the webpage (${error.message})`;
      }
    }
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