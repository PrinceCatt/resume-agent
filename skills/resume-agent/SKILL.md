---
name: resume-agent
description: Job applications through 投递助手 (resume-agent), the job-application app running on this computer. Use when the user wants to add job links, read a posting and score how well they fit (匹配度), tailor their resume to a job (改简历), write a cover letter, have an application form filled in their own browser, see applications waiting for them (待处理), or record progress after applying (投递进展). Works without a DeepSeek key — you can do the reading and tailoring yourself ("skill mode") and the app still checks your work.
---

# 投递助手 (resume-agent)

The app keeps the user's profile (资料库), their job list and their applications. You drive it with one script:

```bash
node <this skill's folder>/scripts/ra.mjs <command> …
```

Run `node scripts/ra.mjs help` (from this folder) for every command. Start with `status`. If it cannot connect, the app is not running: ask the user to start it (`pnpm serve` in the project folder, or `start.cmd` on Windows) — or start it yourself if they ask you to.

## Rules you keep (the app makes the same promises)

1. **Never submit an application without the user's explicit yes for that application.** Show them the review first (fields + screenshot). `confirm` refuses to run without `--user-confirmed`; add it only after the user said yes in this conversation. A yes for one application is not a yes for the next.
2. **Resume content comes only from the user's profile** (`profile`). Never invent employers, titles, dates, numbers, tools or achievements. When the source check flags something, tell the user; do not reword it until the flag goes away.
3. **Passwords, CAPTCHAs, Singpass, sign-ups and sign-ins are the user's.** When a run stops for one, tell the user what to do in their browser and wait.
4. **The profile is personal data.** Keep it on this machine: do not paste it into web searches, other sites or other tools.
5. **Keep the volume low.** Job sites' terms often forbid automation; work on a few chosen jobs, not a mass run, unless the user insists.

## Who does the thinking

`status` shows the app's model:
- **DeepSeek with a key** — the app reads and tailors by itself: `read <id>`, `tailor <id>`, then `wait <id>`.
- **No key, no balance, or the user prefers you** — use **skill mode**: you answer the app's own prompts and it applies the same checks it applies to DeepSeek (conflict caps on the fit score, the resume's source check, the PDF).
- **Demo mode** — rule-based stand-ins; fine for trying the flow, not for real applications.

Form filling (`apply`) is always done by the app's own agent in the user's own Edge, which needs DeepSeek (or demo mode) and the browser connected in the app's Settings. Without a key, either fill the form yourself if you have a browser tool that controls the user's browser (same rules: stop before the final submit and ask), or give the user the PDF (`files <id>`) and the answers from their profile to paste.

## Add and read a job

1. `add <url>` (or `add --text posting.txt` for a pasted description) → prints the job id.
2. Read it:
   - app model: `read <id>`, then `wait <id>`;
   - skill mode: `read-prompt <id> --out read-prompt.txt`, read the file, write **one JSON object** with exactly the keys the SYSTEM part asks for, save it (e.g. `read.json`), then `save-reading <id> read.json`. Facts only from the posting; leave a field empty when the posting does not say. Score the fit honestly against CANDIDATE, including WHAT THE CANDIDATE IS LOOKING FOR. The `summary` and fit notes go in the language the prompt asks for.
3. `job <id>` and tell the user the score, the verdict, any conflict (e.g. a full-time internship for someone who wants part-time) and the gaps. A conflict caps the score at 45 — the app does that, not you.

## Tailor the resume

- app model: `tailor <id>`, then `wait <id>`.
- skill mode: `tailor-prompt <id> --out tailor-prompt.txt`, answer with one JSON object in the shape it gives, save it, then `save-tailoring <id> tailor.json`. Every bullet needs `"src"`: the `[id]` of the profile bullet it comes from, or `"fact"` with the exact sentence from EXTRA FACTS. Unsourced bullets are dropped; new numbers and tools are flagged.

Then report the notes and every flagged item, and ask the user about each flagged one. `files <id> --dir <folder>` saves the PDFs if the user wants to look.

## Apply

1. `apply <id>` → a run starts in the user's Edge (in a tab the app opens; the user can watch).
2. Check `pending` every 15–30 seconds (not faster). Each waiting run shows one of:
   - **QUESTION** — answer from the profile when it clearly answers it, otherwise ask the user: `answer <runId> "<text>"` (`--remember` only if the user wants it saved to their profile).
   - **NEEDS THE USER IN THE BROWSER** — tell them what to do (sign in, pass a check); after they say it is done, `resume <runId>`.
   - **READY TO SUBMIT** — show the user every field and value, and the page: `shot <runId>` saves the screenshot; look at it and point out anything wrong. Ask whether to submit. On an explicit yes: `confirm <runId> --user-confirmed`. To change something: `revise <runId> "<what to change>"`. To give up: `cancel <runId>`.
3. After submitting, `job <id>` shows the result.

## After applying

`mark <id> applied` (applied by hand), `mark <id> screening|interview|offer|rejected|withdrawn` as replies come in; `jobs` lists everything. The app's own pages (stats, calendar, interview prep) are at the app's address in a browser.

## When something goes wrong

- **余额不足 / 402** — the DeepSeek balance is empty: switch to skill mode, or the user tops up and clicks 「充好了，继续」 in the app.
- **Browser not connected** — the user connects it in the app: Settings → 浏览器 → 连接 (needs Microsoft's Playwright Extension in their Edge).
- **A job stays busy** — `wait <id> --timeout 300`; errors show in `jobs` / `job <id>` after `!`.
- **The page needs sign-in to read** — the user signs in to that site in their browser, then read again; or paste the description with `add --text`.
