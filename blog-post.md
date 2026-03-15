# I Built a Tool That Lets Me Ask Claude About My University Courses

Every Queen's student knows the ONQ grind. You need to check an assignment rubric, so you open ONQ, wait for it to load, click through three menus, find the course, find the assignment, scroll past the instructions, scroll past the attachments, find the rubric accordion, click it open — and by the time you're done you've forgotten what you were originally trying to figure out.

I got fed up with this enough to do something about it. The result is a tool that connects Claude directly to ONQ, so I can just type *"what's the rubric for my ELEC 392 lab report?"* and get an answer in a few seconds, without touching the ONQ interface at all.

Here's how I built it, what I learned along the way, and why it ended up being more interesting than I expected.

---

## The idea: AI + your university portal

If you've used Claude, ChatGPT, or any of the recent AI assistants, you've probably noticed that they're great at summarizing, explaining, and answering questions — but they only know what you tell them. If you want Claude to help you with your assignments, you have to copy-paste all the context yourself: the instructions, the rubric, your notes. That's tedious, and it's the kind of work an AI should be doing for you.

The question I wanted to answer was: what if Claude could just go get that context itself?

It turns out there's a standard protocol for exactly this, released in late 2024 by Anthropic, called **MCP** — the Model Context Protocol. It's a way to write a small server that gives Claude new "tools" it can call. You define what the tools do, and Claude figures out when and how to use them.

So my plan was: write an MCP server that knows how to talk to ONQ, give it to Claude, and let Claude pull in whatever course information it needs when I ask a question.

---

## Step 1: Figuring out how to talk to ONQ

ONQ is built on D2L Brightspace, a learning management system used by universities around the world. D2L publishes a REST API — essentially a set of URLs you can call to get data about courses, assignments, grades, and so on.

The first problem was authentication. To call the D2L API on behalf of a student, you need to be logged in as that student. D2L supports OAuth for third-party integrations, but setting that up requires registering with the university's IT department and going through an approval process — not practical for a personal tool.

The workaround I landed on: use a real browser. The idea is to open an actual Chromium window, let the student log in normally through Queen's Microsoft SSO (the same way they'd log in through a browser), and then capture the session cookies once they're authenticated. Those cookies can then be attached to all future API requests, exactly like a browser would do it.

For this, I used a library called **Playwright**, which is normally used for automated testing but works perfectly here. It opens the browser, waits until you've finished the login flow, and then grabs the cookies.

After the first login, those cookies get saved to disk with restricted permissions (only your own Mac user account can read the file). Every subsequent session reuses them — typically you only have to log in once every day or two.

---

## Step 2: Building the API client

With authentication solved, I built a typed TypeScript client around the D2L API. This is the part of the codebase that actually makes HTTP requests — it knows the right URL patterns for fetching enrollments, assignments, course content, grades, announcements, and so on.

One thing that caught me off guard: D2L's API is heavily versioned. Different features are available at different version numbers, and the version that's actually live on Queen's ONQ doesn't always match the latest version in the documentation. I ended up building a fallback pattern where several endpoints try multiple API versions automatically, so things degrade gracefully rather than breaking outright.

Another curveball: many course content items are PDFs. The D2L API can give you a binary file download, but to be useful to Claude, that file needs to become text. I wired in a PDF extraction library (`pdf-parse`) that converts the raw PDF bytes into a string. There were some fun edge cases here — PDFs with no text layer (scanned images) silently return empty strings, and some PDF types cause the library to hang indefinitely if you don't explicitly release the underlying worker thread when you're done.

---

## Step 3: Writing the MCP server

The MCP layer is what makes this accessible to Claude. You define a list of "tools" — each with a name, a description, and a set of parameters — and Claude can call them like functions when it thinks they're useful.

My first version launched with eleven tools:

- List courses, assignments, and grades
- Get full assignment details (instructions + rubric)
- Read course content (the modules and files tree)
- Read the text of any individual content file
- List course announcements
- Get upcoming deadlines across all courses
- Login / logout

The interesting part of MCP is the descriptions. Claude doesn't just pick tools randomly — it reads the description of each tool and decides which ones are relevant to a given question. If I ask *"what assignments do I have this week?"*, Claude calls `get_upcoming_deadlines`. If I ask about a specific course's content, it figures out it probably needs `list_courses` first (to get the course ID), then `get_course_content`. Getting those descriptions right matters a lot for whether Claude calls the right tool at the right time.

---

## Step 4: Finding (and fixing) the gaps

Once the basic version was working, I started actually using it — and that's when the list of rough edges became obvious.

The main gaps I hit:

**Link-type content.** Course content in ONQ isn't always files — a lot of it is just links to external resources, embedded quizzes, or LTI tools (third-party integrations). My first version would get stuck trying to download these as if they were files. The fix was to detect those topic types and return the URL directly, with a hint telling Claude it can try to fetch the external page if it's a normal website.

**No submission status.** You could get the assignment rubric and instructions, but there was no way to know whether you'd already submitted. D2L has an API endpoint for this (`mysubmissions/`), it just wasn't wired up. Now asking *"have I submitted this yet?"* works.

**DOCX files.** Some professors post assignment instructions as Word documents. The PDF extraction was already working, but I hadn't added DOCX support. Added a library called `mammoth` that extracts text from `.docx` files the same way `pdf-parse` does for PDFs.

**Rate limiting.** D2L throttles API requests — if you hammer it with calls too quickly, it returns a 429 response. I added retry logic with exponential backoff so the server automatically waits and tries again instead of just failing.

**No quiz or discussion access.** Claude had no way to see quiz attempt history or read discussion forum posts. Both of these have D2L API endpoints, I just hadn't built tools for them yet. Now there are `get_quiz_attempts` and `get_discussion_posts` tools.

**Calendar events.** Exam dates are often posted to the course calendar rather than as assignment dropboxes, which meant `get_upcoming_deadlines` would miss them. A new `get_calendar_events` tool pulls these directly.

**Configurable PDF limits.** The PDF extractor was hardcoded to cap at 50 pages before truncating. Made that configurable via an environment variable so you can raise it if you have long readings or lower it if things feel slow.

---

## What it actually feels like to use

Honestly, the most satisfying part is how natural it is once it's set up. I can just have a conversation:

> *"Summarize all the announcements from my courses this week."*

> *"What's left to complete in Module 3 of ELEC 392?"*

> *"Explain the grading criteria for the lab report — specifically the section on data analysis."*

> *"What's my current standing in each of my courses?"*

Claude handles the multi-step stuff on its own. If I ask about a specific assignment, it calls `list_courses` to find the right course ID, then `list_assignments` to find the assignment ID, then `get_assignment_details` to pull the rubric. I never think about the mechanics.

---

## What I'd build next

A few things are still on the wishlist:

**Video transcripts.** Video content in ONQ often goes through Kaltura (a video platform), and D2L's API has no way to access it. You'd need a separate integration with Kaltura's API to get transcripts. This one requires coordination with the university's IT department to get API credentials, so it's not a quick fix.

**Grade prediction.** With grade weights and current scores, it would be pretty easy to calculate what you'd need on the final exam to hit a target grade. This doesn't require any new API access — it's just math on top of what `get_grades` already returns.

**Better scanned PDF handling.** If a PDF is a scan with no text layer, the tool currently just tells you the file is available locally. Adding OCR (optical character recognition) would let it handle those too.

---

## The code

If you're a Queen's student and want to try it: the project is on GitHub (link below). Setup takes about ten minutes — install Node.js, clone the repo, run `npm install && npm run build`, add a few lines to your Claude Desktop config file, and restart Claude.

If you're interested in the technical details: the source is about 1,600 lines of TypeScript across four files. The D2L API documentation is surprisingly complete (published at [docs.valence.desire2learn.com](https://docs.valence.desire2learn.com)), and the MCP SDK from Anthropic is well-documented too. Building something like this for a different Brightspace institution would mostly just involve changing a few URL constants.

The whole thing runs locally on your machine. Nothing goes to any external server except your own requests to `onq.queensu.ca`. Your password never touches the code at all.

---

Building this scratched an itch I'd had for a while — that most AI tools are powerful but disconnected from the actual places where your information lives. Hooking Claude directly into a real system made it feel noticeably more useful for day-to-day stuff. If you have a similar frustration with some other tool you use regularly, MCP makes the integration side surprisingly approachable.
