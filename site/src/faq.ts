/**
 * The FAQ, as plain text. Rendered on the page and, at build time, as FAQPage structured data
 * and in llms.txt (vite.config.ts imports this file), so keep it free of imports and markup.
 */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'What is tiny-browse?',
    a: 'A web search and page reading tool for local AI agents and Node.js, built for agents that run on your own machine. It searches Google in the Chrome you already have, reads the best results and returns clean Markdown inside a hard token budget. It ships as one npm package that is both an MCP server (tools web_search and web_fetch) and a library (webSearch, webFetch, createClient).',
  },
  {
    q: 'Do I need an API key or an account?',
    a: 'No. There is no search API and no cloud service involved. tiny-browse drives a browser on your own computer, so nothing is billed and no key is needed.',
  },
  {
    q: 'Which local agents does it work with?',
    a: 'Any MCP client: Claude Code, Claude Desktop, GitHub Copilot in VS Code, Cursor, Windsurf, Codex, Gemini CLI, Cline and local agents you build yourself, on any model: Ollama and other local models included. tiny-browse config <client> prints the setup for claude-code, claude-desktop, cursor, vscode, codex or generic.',
  },
  {
    q: 'Does it download a browser?',
    a: 'No. It uses an installed Chrome, Chromium, Edge or Brave, in a separate profile of its own, never your everyday profile. Without any browser, the no-Chrome mode (--no-chrome, or mode: "http" in the library) reads pages over plain HTTP; Google is skipped and pages that need JavaScript come back thin.',
  },
  {
    q: 'Will Google block it?',
    a: 'It can, depending on your network. tiny-browse keeps strict request budgets (for Google: 3 a minute, 20 an hour, 100 a day, shared by every tiny-browse process on the computer) and pauses an engine after a CAPTCHA, while DuckDuckGo and Bing take over. Running tiny-browse login once usually helps. Reading pages is not affected.',
  },
  {
    q: 'How does max_tokens work?',
    a: 'It is a hard limit on the whole answer, counted with a model-agnostic estimate. Pages are split into sections by heading and packed in order of relevance to the query (or to focus). When a page is cut short, the result includes a cursor that continues it.',
  },
  {
    q: 'Can I use it from my own code, without MCP?',
    a: 'Yes. npm install @shubhamcodess/tiny-browse, then import webSearch and webFetch. Each call starts what it needs and shuts it down before it returns, so a short-lived CLI exits straight away; createClient() keeps one Chrome warm across calls. whatcmd uses it exactly this way.',
  },
  {
    q: 'What errors can it throw?',
    a: 'Every error is a TinyBrowseError with a code: chrome_not_found, timeout, blocked, network, private_address, aborted or invalid_input. An empty result list is not an error, and webFetch only throws when no page at all could be read; partial failures are listed in failed. The docs show how to handle each code.',
  },
  {
    q: 'Is it safe to point my local agent at the open web?',
    a: 'tiny-browse refuses local and private network addresses, including requests made by pages inside Chrome, reads pages without your cookies, and wraps every page in untrusted-content markers so your local agent can tell web text from instructions. The HTTP server binds to 127.0.0.1 and requires a token for anything else.',
  },
  {
    q: 'Does it read PDFs or work on Windows?',
    a: 'Not yet. PDF support is not implemented, and it is tested on macOS and Linux only; Windows is untested.',
  },
]
