I built a tool that lets me ask Claude questions about my university courses — and gets answers in seconds without me ever opening ONQ.

Here's the problem: checking an assignment rubric on ONQ means opening the site, waiting for it to load, clicking through three menus, finding the course, finding the assignment, scrolling past the instructions, finding the rubric accordion, clicking it open. By the time you're done you've forgotten what you were trying to figure out.

The fix: I wrote an MCP server (Model Context Protocol — a standard Anthropic released in 2024 for giving AI assistants real tools) that connects Claude Desktop directly to ONQ's D2L Brightspace API.

Now I just type:
→ "What's the rubric for my ELEC 392 lab report?"
→ "Have I submitted Assignment 2 yet?"
→ "What are my upcoming deadlines across all my courses?"
→ "What did I score on my last quiz attempt?"

And Claude pulls it all in on its own.

A few things I learned building it:

The authentication problem is interesting. D2L supports OAuth but registering with your university's IT takes time. My workaround: open a real browser with Playwright, let the user log in through the normal SSO flow, capture the session cookies, and reuse them for all API calls. You log in once, everything works for ~24 hours.

Tool descriptions matter more than I expected. Claude picks which tools to call based on their descriptions, not some hardcoded logic. Getting that wording right was the difference between Claude calling the right API or going in circles.

The gaps you find by actually using something are always different from the ones you predict. I thought content extraction would be the hard part — it wasn't. The annoying ones were things like: link-type topics being silently swallowed, exam dates living in the calendar API rather than the assignments API, and D2L rate-limiting requests with 429s when you pull data for multiple courses at once.

After a round of fixes, the tool now handles: assignment details with rubrics and submission status, quiz attempt history, discussion forum posts, calendar events (so exam dates show up), DOCX file extraction alongside PDF, and automatic retry on rate limit errors.

The whole thing runs locally. Nothing leaves your machine except requests to onq.queensu.ca. Your password never touches the code.

Code is on GitHub — link in the comments. If you're at another Brightspace university it'd take maybe an hour to adapt.

#MCP #AI #Queens #SideProject #TypeScript
