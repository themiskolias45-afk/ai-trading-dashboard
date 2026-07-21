Browse, interact with, and extract data from any website. Usage: /web [task]

$ARGUMENTS is the task — e.g. "go to CNBC and get today's top market headlines" or "log into broker and check account balance" or "fill out this form at [url]"

Use Puppeteer MCP tools directly:
- puppeteer_navigate — go to any URL
- puppeteer_screenshot — see what's on screen
- puppeteer_click — click any element
- puppeteer_fill — fill any input field
- puppeteer_evaluate — run JavaScript in the page (most powerful — can read DOM, extract data, trigger events)
- puppeteer_hover — hover over elements
- puppeteer_select — select dropdown options

Workflow:
1. Navigate to the target URL
2. Take a screenshot to see what loaded
3. Interact as needed (click, fill, scroll)
4. Extract whatever data is needed
5. Report results

This works on ANY website — no debug ports needed, no setup required.
JARVIS controls the browser directly and sees exactly what's on screen.

Examples of what this can do:
- Check competitor pricing
- Read live news and economic calendars
- Fill in trade journals or broker forms
- Extract data from sites with no API
- Monitor any page for changes
- Screenshot any URL for visual inspection
