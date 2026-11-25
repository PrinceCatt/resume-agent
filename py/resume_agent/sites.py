"""What the agent should know about the big Singapore job sites. The agent stays generic: these are
hints added to its prompt when a page of that site is open, plus how the posting reader treats it.
Probed 2026-11-13 signed out: LinkedIn and MyCareersFuture job pages read fine headless;
JobStreet, Glassdoor and Indeed answer a headless browser with a "Just a moment..." bot check."""

from __future__ import annotations

import re
from typing import Any


def _fixture(name: str) -> re.Pattern[str]:
    """Local mock pages (fixtures/site-*.html) stand in for a site in tests."""
    return re.compile(r"^https?://(127\.0\.0\.1|localhost):\d+/fixtures/site-" + name)


SITES: list[dict[str, Any]] = [
    {
        "key": "linkedin",
        "name": "LinkedIn",
        "match": re.compile(r"^https?://([a-z]+\.)?linkedin\.com/", re.I),
        "login": "https://www.linkedin.com/login",
        "note": "Easy Apply 在 LinkedIn 里填完；只有「Apply」的会跳到公司官网，按那边的表单填。",
        "visibleOnly": False,
        "playbook": """LinkedIn
- Signed out (the header shows "Sign in" / "Join now", or a sign-in form/modal appears): call need_manual asking the candidate to sign in to LinkedIn in this window.
- "Easy Apply" opens a dialog with several steps (contact info, resume, additional questions, review). Work inside the dialog; buttons are "Next", "Review", and finally "Submit application" (use request_submit for that one).
- A plain "Apply" button (no "Easy") opens the employer's own site in a new tab: continue there as a normal application form.
- Contact info is pre-filled from the LinkedIn account: keep it if it matches CANDIDATE PROFILE, correct it if it does not.
- Resume step: upload the resume file (the tailored one) instead of picking an older resume LinkedIn remembers.
- "How many years of experience do you have with X?" style questions: answer from the dated experience in the profile; if it is not clear, ask_user (the answer is remembered).
- The review step has a "Follow <company>" checkbox that is ticked by default: untick it (optional, like a newsletter).
- Do not close the dialog: closing it asks to discard or save the application.
- "Applied" / "Application submitted" shown on the job page means already_applied.""",
    },
    {
        "key": "jobstreet",
        "name": "JobStreet",
        "match": re.compile(r"^https?://([a-z]+\.)?jobstreet\.com(\.[a-z]+)?/", re.I),
        "login": "https://sg.jobstreet.com/",
        "note": "「Quick apply」在 JobStreet 里填完。没登录或打开时出现人机验证，助手会停下来让你在它的窗口里处理。",
        "visibleOnly": True,
        "playbook": """JobStreet
- Signed out (a "Sign in" button in the header, or the apply page asks you to sign in or create an account): call need_manual asking the candidate to sign in to JobStreet in this window.
- "Quick apply" starts JobStreet's own form, usually: choose documents (resumé + cover letter) → answer employer questions → update your JobStreet profile → review and submit. A plain "Apply" that leads to the employer's website: continue there as a normal form.
- Documents step: choose the option to upload a resumé and upload the resume file; for the cover letter, upload the cover_letter file or choose writing one and paste COVER LETTER TEXT. Do not pick "don't include" when a file is available.
- Employer questions are usually selects and radios: answer only from facts; ask_user for required ones you have no fact for.
- The "update your profile" step shows the candidate's JobStreet profile: do not edit it, just continue.
- The last step's button is "Submit application": use request_submit.
- "You applied on …" means already_applied.""",
    },
    {
        "key": "glassdoor",
        "name": "Glassdoor",
        "match": re.compile(r"^https?://([a-z]+\.)?glassdoor\.[a-z.]+/", re.I),
        "login": "https://www.glassdoor.sg/profile/login_input.htm",
        "note": "「Easy Apply」会转到 Indeed 的申请表（Glassdoor 和 Indeed 是一家）；其余跳公司官网。常有人机验证，要你自己过。",
        "visibleOnly": True,
        "playbook": """Glassdoor
- Signed out (a sign-in wall or "Sign in" prompt): call need_manual asking the candidate to sign in to Glassdoor in this window.
- "Easy Apply" continues in Indeed's application form (smartapply.indeed.com), often in a new tab. "Apply on employer site" opens the employer's website: continue there as a normal form.
- Pop-ups asking to sign up for job alerts can be closed.""",
    },
    {
        "key": "indeed",
        "name": "Indeed",
        "match": re.compile(r"^https?://([a-z]+\.)?indeed\.com/|^https?://smartapply\.indeed\.com/", re.I),
        "login": "https://secure.indeed.com/auth",
        "note": "「Apply now」在 Indeed 里填完，Glassdoor 的 Easy Apply 也是这张表。登录常要邮箱验证码，要你自己输。",
        "visibleOnly": True,
        "playbook": """Indeed (also the form behind Glassdoor "Easy Apply")
- Signed out, or asked for an email/one-time code: call need_manual (the candidate enters codes themselves).
- The form usually goes: contact information → resume (choose to upload a file and upload the resume file rather than the Indeed resume) → employer questions → review. Buttons are "Continue", and finally "Submit your application" (use request_submit).
- "Apply on company site" opens the employer's website: continue there as a normal form.
- "Applied" on the job means already_applied.""",
    },
    {
        "key": "mcf",
        "name": "MyCareersFuture",
        "match": re.compile(r"^https?://([a-z]+\.)?mycareersfuture\.gov\.sg/", re.I),
        "login": "https://www.mycareersfuture.gov.sg/",
        "note": "投递要用 Singpass 登录，扫码这一步要你自己来；登录后助手接着填。",
        "visibleOnly": False,
        "playbook": """MyCareersFuture (Singapore government job portal)
- Applying needs a Singpass login: when the page asks to log in, call need_manual asking the candidate to log in with Singpass in this window. Never try to fill Singpass yourself.
- After login, the apply form asks for a resume (upload the resume file) and sometimes screening questions; the final button submits the application (use request_submit).
- Some jobs say to apply on the company's website: follow that link and continue there as a normal form.
- "Applied" on the job means already_applied.""",
    },
    # Not in Settings (no account of its own to sign in to), but common behind "Apply on company site".
    {
        "key": "workday",
        "name": "Workday",
        "match": re.compile(r"^https?://[a-z0-9-]+\.(wd\d+\.)?myworkdayjobs\.com/", re.I),
        "login": "",
        "note": "",
        "visibleOnly": False,
        "playbook": """Workday (employer careers site)
- Each employer's Workday needs its own account: "Sign In" / "Create Account" → need_manual (the candidate creates the account and password themselves).
- "Autofill with Resume" uploads the resume and pre-fills fields: use it, then check every pre-filled value against the profile (dates, schools, titles are often parsed wrong).
- Steps: My Information → My Experience → Application Questions → Voluntary Disclosures → Self Identify → Review. "Save and Continue" moves on; the final "Submit" needs request_submit.""",
    },
]


def site_for(url: str) -> dict[str, Any] | None:
    for s in SITES:
        if s["match"].search(url) or _fixture(s["key"]).search(url):
            return s
    return None


def login_sites() -> list[dict[str, str]]:
    """Sites shown in Settings, with a sign-in page."""
    return [{"key": s["key"], "name": s["name"], "login": s["login"], "note": s["note"]} for s in SITES if s["login"]]


CHECK_TITLE = re.compile(r"^(just a moment|attention required|verify you are human|access denied|blocked)\b|security check|人机验证|安全验证", re.I)
CHECK_TEXT = re.compile(
    r"verify you are human|checking (if the site connection is secure|your browser)|are you a robot|unusual traffic from your|press (and|&) hold|enable javascript and cookies to continue",
    re.I,
)


def is_check_page(title: str, text: str) -> bool:
    """A bot-check / "Just a moment..." interstitial rather than the page itself."""
    return bool(CHECK_TITLE.search(title.strip()) or CHECK_TEXT.search(text[:2000]))
