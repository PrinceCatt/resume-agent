"""Port of server/core.test.ts. The two promises this app makes: it never clicks a final submit on its own,
and a tailored resume contains nothing that isn't in the master profile. Run: uv run pytest"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime

import pytest

from resume_agent import jobs, net
from resume_agent.agent import is_final_submit, similarity
from resume_agent.jsutil import to_fixed
from resume_agent.profile import normalize_profile
from resume_agent.tailor import assemble


def button(text: str, **extra):
    el = {
        "id": "f0_1",
        "kind": "button",
        "label": "",
        "group": "",
        "value": "",
        "checked": None,
        "required": False,
        "disabled": False,
        "invalid": False,
        "hidden": False,
        "options": None,
        "optionCount": 0,
        "text": text,
        "href": "",
        "submitType": False,
        "inForm": True,
        "inDialog": False,
    }
    el.update(extra)
    return el


@pytest.fixture(autouse=True)
def no_background(monkeypatch):
    """Keep the background reader from trying to open these pages (bgQueue.push = () => {})."""
    monkeypatch.setattr(jobs.bg_queue, "push", lambda t: None)


def test_final_submit_guard():
    assert is_final_submit(button("Submit Application"), 0) is True
    assert is_final_submit(button("Submit"), 5) is True
    assert is_final_submit(button("Send application"), 3) is True
    assert is_final_submit(button("立即沟通"), 0) is True
    assert is_final_submit(button("提交申请"), 0) is True
    # Starting an application is fine; "Apply" once fields are filled is not.
    assert is_final_submit(button("Apply for this job"), 0) is False
    assert is_final_submit(button("Easy Apply"), 0) is False
    assert is_final_submit(button("Apply"), 4) is True
    # Step buttons in multi-page forms pass, even as type=submit.
    assert is_final_submit(button("Next", submitType=True), 4) is False
    assert is_final_submit(button("Review your application", submitType=True), 4) is False
    assert is_final_submit(button("Continue"), 4) is False
    # An unnamed form submit after filling counts as final.
    assert is_final_submit(button("Done", submitType=True), 4) is True


master = normalize_profile(
    {
        "basics": {"name": "Test Person"},
        "sections": [
            {
                "id": "sec_edu",
                "heading": "Education",
                "entries": [{"id": "e_edu", "title": "Example University", "dates": "2023 - 2027", "bullets": [{"id": "b_gpa", "text": "GPA 3.8"}]}],
            },
            {
                "id": "sec_exp",
                "heading": "Experience",
                "entries": [
                    {
                        "id": "e_orb",
                        "title": "Course Project",
                        "dates": "2024",
                        "bullets": [
                            {"id": "b1", "text": "Built a full-stack blog website with Spring Boot and Vue"},
                            {"id": "b2", "text": "Deployed on an Ubuntu server with Nginx"},
                        ],
                    }
                ],
            },
        ],
        "skills": [{"id": "sk", "label": "Programming", "items": ["Java", "Python"]}],
        "extraFacts": "Interned at Example Labs as a backend intern from May 2026 to Nov 2026.\nWrote data pipelines in Python processing 2 million records.",
    }
)
jd = {
    "title": "Backend Intern",
    "company": "Acme",
    "location": "",
    "summary": "",
    "requirements": [],
    "niceToHave": [],
    "keywords": ["Kubernetes", "Java"],
    "language": "en",
    "closed": False,
    "fit": None,
    "facts": None,
}


def test_tailoring_keeps_only_traceable_content():
    out = assemble(
        master,
        {
            "sections": [
                {
                    "id": "sec_exp",
                    "entries": [
                        {
                            "id": "e_orb",
                            "bullets": [
                                {"src": "b1", "text": "Built a full-stack web app with Spring Boot, serving 10,000 users"},  # invented number
                                {"src": "b2", "text": "Deployed and operated the service on Ubuntu behind Nginx"},  # fine rewrite
                                {"src": "made_up", "text": "Led a team of 8 engineers"},  # no source
                            ],
                        }
                    ],
                },
                {
                    "id": "new",
                    "heading": "Work Experience",
                    "entries": [
                        {
                            "id": "new",
                            "title": "Example Labs",
                            "subtitle": "Backend Intern",
                            "dates": "May 2026 - Nov 2026",
                            "bullets": [
                                {
                                    "src": "fact",
                                    "fact": "Wrote data pipelines in Python processing 2 million records.",
                                    "text": "Built Python data pipelines processing 2 million records",
                                }
                            ],
                        }
                    ],
                },
            ],
            "skills": [{"id": "sk", "items": ["Java", "Kubernetes", "Python"]}],
        },
        jd,
    )
    exp = next(s for s in out["doc"]["sections"] if s["id"] == "sec_exp")
    texts = [b["text"] for b in exp["entries"][0]["bullets"]]
    assert "Built a full-stack blog website with Spring Boot and Vue" in texts, "invented number reverted to the original"
    assert "Deployed and operated the service on Ubuntu behind Nginx" in texts
    assert not any("team of 8" in t for t in texts), "unsourced bullet dropped"
    assert out["doc"]["skills"][0]["items"] == ["Java", "Python"], "skill not in profile dropped"
    assert out["doc"]["sections"][0]["heading"] == "Education", "education put back first"
    work = next(s for s in out["doc"]["sections"] if s["heading"] == "Work Experience")
    assert work["entries"][0]["bullets"][0]["text"] == "Built Python data pipelines processing 2 million records"
    assert any("10" in w for w in out["warnings"]), "number warning"
    assert any("Kubernetes" in w for w in out["warnings"]), "skill warning"
    assert any("Example Labs" in w for w in out["warnings"]), "new entry flagged for review"


def test_the_same_posting_pasted_twice_is_added_once():
    from resume_agent.jobs import add_jobs, normalize_url

    assert normalize_url("https://www.linkedin.com/jobs/view/123/?trackingId=abc&refId=x") == normalize_url("linkedin.com/jobs/view/123")
    assert normalize_url("https://jobs.lever.co/acme/42?lever-source=LinkedIn#apply") == normalize_url("https://jobs.lever.co/acme/42/")
    assert normalize_url("https://example.com/jobs?id=1") != normalize_url("https://example.com/jobs?id=2")
    first = add_jobs(["https://jobs.lever.co/acme/42", "https://jobs.lever.co/acme/42/?utm_source=x"], auto_apply=False)
    assert len(first["ids"]) == 1
    assert len(first["duplicates"]) == 1
    again = add_jobs(["jobs.lever.co/acme/42#top", "https://jobs.lever.co/acme/43"], auto_apply=False)
    assert len(again["ids"]) == 1
    assert [d["id"] for d in again["duplicates"]] == first["ids"]


def test_marking_a_job_applied_starts_its_follow_up_record_once():
    from resume_agent.jobs import add_jobs, get_job, set_job

    [id_] = add_jobs(["https://example.com/careers/9"], auto_apply=False)["ids"]
    set_job(id_, {"stage": "applied"})
    a = get_job(id_)
    assert a["progress"] == "applied"
    assert a["applied_at"]
    set_job(id_, {"progress": "interview"})
    set_job(id_, {"stage": "applied"})
    b = get_job(id_)
    assert b["progress"] == "interview", "applying again does not reset progress"
    assert b["applied_at"] == a["applied_at"], "first applied date is kept"


def test_an_interview_moves_progress_forward_and_stats_count_how_far_each_job_got():
    from resume_agent.jobs import add_jobs, get_job, progress_log, set_job
    from resume_agent.schedule import add_event, get_event, ics_for
    from resume_agent.stats import stats

    a, b = add_jobs(["https://boards.greenhouse.io/acme/jobs/1", "https://boards.greenhouse.io/acme/jobs/2"], auto_apply=False)["ids"]
    set_job(a, {"stage": "applied"})
    set_job(b, {"stage": "applied"})
    ev = add_event(a, {"kind": "interview", "at": "2030-01-02T06:00:00.000Z", "note": "https://meet.example.com/abc"})
    assert get_job(a)["progress"] == "interview"
    add_event(a, {"kind": "test", "at": "2030-01-03T06:00:00Z"})
    assert get_job(a)["progress"] == "interview", "a test after the interview does not move it back"
    set_job(a, {"progress": "rejected"})
    assert [l["progress"] for l in progress_log(a)] == ["applied", "interview", "rejected"]

    gh = next(s for s in stats()["bySite"] if s["label"] == "Greenhouse")
    assert [gh["applied"], gh["replied"], gh["positive"]] == [2, 1, 1], "a rejection after an interview still counts as having got that far"

    ics = ics_for(get_event(ev))
    assert "DTSTART:20300102T060000Z" in ics
    assert "TRIGGER:-PT1H" in ics
    assert all(len(l.encode("utf-8")) <= 75 for l in ics.split("\r\n")), "long lines are folded"


def test_marking_a_job_straight_as_a_test_round_still_starts_its_history_with_applied():
    from resume_agent.db import sql_now
    from resume_agent.jobs import add_jobs, progress_log, set_job

    [id_] = add_jobs(["https://example.com/careers/77"], auto_apply=False)["ids"]
    # What PATCH /api/jobs/:id { progress: "screening" } does for a job you applied to by hand.
    set_job(id_, {"progress": "screening", "progress_at": sql_now(), "stage": "applied"})
    assert [l["progress"] for l in progress_log(id_)] == ["applied", "screening"]


def test_questions_the_agent_asked_show_up_until_they_are_answered_in_the_profile():
    from resume_agent.db import run
    from resume_agent.jobs import add_jobs
    from resume_agent.stats import asked_questions

    [job_id] = add_jobs(["https://example.com/careers/88"], auto_apply=False)["ids"]
    run_id = run("INSERT INTO runs (job_id, status) VALUES (?, 'finished')", job_id)["id"]
    run("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'ask', ?)", run_id, "问你：What is your notice period?")
    run("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'note', ?)", run_id, "你的回答：Immediately（已记入资料库）")
    run("INSERT INTO run_steps (run_id, kind, text) VALUES (?, 'ask', ?)", run_id, "问你：Do you have a driving licence?")
    open_ = asked_questions(similarity, [{"q": "What is your notice period?", "a": ""}])
    assert sorted(f"{a['q']} = {a['a']}" for a in open_) == [
        "Do you have a driving licence? = ",
        "What is your notice period? = Immediately",
    ], "an empty saved answer still counts as open"
    left = asked_questions(similarity, [{"q": "What is your notice period?", "a": "Immediately"}])
    assert [a["q"] for a in left] == ["Do you have a driving licence?"], "an answered question drops off"


def test_tools_the_profile_never_mentions_are_caught_short_acronyms_only_in_capitals():
    from resume_agent.terms import profile_text, unsupported_terms

    p = profile_text(master)
    assert unsupported_terms("Built ROS nodes in Java and wrote JUnit tests", p) == ["ROS", "JUnit"]
    assert unsupported_terms("Used JavaScript on a robotic arm", p) == ["JavaScript"], "Java is not found inside JavaScript, and an arm is not ARM"
    assert unsupported_terms("熟悉 Spring Boot 和 Nginx，有 Kubernetes 经验", p, ["Kubernetes"]) == ["Kubernetes"], "works inside Chinese text, and posting keywords count"


def test_interview_talking_points_must_name_a_profile_line_that_backs_them():
    from resume_agent.prep import check_point

    def kind(raw):
        return check_point(raw, master, jd)["kind"]

    assert kind({"text": "Built a blog with Spring Boot and Vue", "src": "b1"}) == "fact"
    assert check_point({"text": "Built a blog", "src": "[b1]"}, master, jd)["from"] == "Course Project"
    assert kind({"text": "Processed 2 million records in Python", "src": "fact", "fact": "Wrote data pipelines in Python processing 2 million records."}) == "fact"
    assert kind({"text": "Interned at Example Labs", "src": "fact", "fact": "Interned at Google."}) == "unsure", "a quoted fact that is not in EXTRA FACTS"
    assert kind({"text": "Explain how you would design the API", "src": "tip"}) == "tip"
    assert kind({"text": "Used Kubernetes to deploy the blog", "src": "tip"}) == "unsure", "a claim labelled as a tip"
    assert kind({"text": "Deployed the blog on Kubernetes", "src": "b2"}) == "unsure", "a real source, but a tool the profile lacks"
    assert kind({"text": "Served 5000 users", "src": "b1"}) == "unsure", "a number the profile lacks"
    assert kind({"text": "Led a team of four", "src": "b9"}) == "unsure", "an id that does not exist"
    assert kind("Built a blog") == "unsure", "an old plain-string point"


def test_a_fit_strength_crediting_a_missing_tool_is_marked():
    from resume_agent.jobs import check_fit
    from resume_agent.terms import profile_text

    fit = check_fit({"score": 88, "verdict": "", "strengths": ["有 ROS 机器人项目经验", "熟悉 Java"], "gaps": []}, profile_text(master), jd["keywords"])
    assert fit["unsupported"] == ["ROS"]
    assert fit["strengths"][0] == "有 ROS 机器人项目经验（资料库里没找到：ROS）"
    assert fit["strengths"][1] == "熟悉 Java"


def test_a_tool_counts_when_the_profile_writes_it_another_way_or_with_a_version():
    from resume_agent.terms import unsupported_terms

    p = "Skills: Robot Operating System (familiar), Vue3, HTML5, k8s basics"
    assert unsupported_terms("Built ROS nodes with a Vue front end on Kubernetes", p) == []
    assert unsupported_terms("Wrote Golang services", "Let's go") == ["Golang"], "a two-letter alias only counts in its own case"


def test_prep_flags_are_worked_out_when_read_so_adding_the_fact_to_the_profile_clears_them():
    from resume_agent.prep import prep_view

    saved = {
        "pitch": "I build ROS robots.",
        "questions": [{"q": "Q", "kind": "technical", "why": "", "points": [{"text": "Wrote ROS nodes for the robot", "src": "b1"}]}],
        "toAsk": [],
        "gaps": [],
        "generatedAt": "",
    }
    before = prep_view(saved, master, jd)
    assert before["questions"][0]["points"][0]["kind"] == "unsure"
    assert before["pitchWarnings"] == ["提到了 ROS，资料库里没有"]
    with_ros = normalize_profile({**master, "skills": [*master["skills"], {"id": "sk2", "label": "Robotics", "items": ["Robot Operating System"]}]})
    after = prep_view(saved, with_ros, jd)
    assert after["questions"][0]["points"][0]["kind"] == "fact"
    assert after["pitchWarnings"] == []


def test_job_sites_are_recognised_by_their_links_and_bot_check_screens_are_told_apart():
    from resume_agent.sites import is_check_page, site_for

    def key(u):
        s = site_for(u)
        return s["key"] if s else None

    assert key("https://sg.linkedin.com/jobs/view/software-engineer-intern-at-acme-4475507408") == "linkedin"
    assert key("https://www.linkedin.com/jobs/view/4475507408/") == "linkedin"
    assert key("https://sg.jobstreet.com/job/81234567") == "jobstreet"
    assert key("https://www.glassdoor.sg/job-listing/software-engineer-intern-acme-JV_KO0,24.htm") == "glassdoor"
    assert key("https://smartapply.indeed.com/beta/indeedapply/form/contact-info") == "indeed"
    assert key("https://www.mycareersfuture.gov.sg/job/information-technology/intern-d5cfb9f5586c337bc00c90c5def60d9e") == "mcf"
    assert key("https://acme.wd3.myworkdayjobs.com/en-US/careers/job/Singapore/Intern_R123") == "workday"
    assert key("http://127.0.0.1:8791/fixtures/site-indeed-apply.html") == "indeed", "local mock pages stand in for a site"
    assert site_for("https://boards.greenhouse.io/acme/jobs/1") is None
    assert site_for("https://notlinkedin.com/jobs/1") is None
    assert site_for("https://sg.jobstreet.com/job/1")["visibleOnly"] is True
    assert is_check_page("Just a moment...", "Checking if the site connection is secure") is True
    assert is_check_page("Blocked - Indeed.com", "") is True
    assert is_check_page("Software Engineer Intern - Acme", "Verify you are human by completing the action below.") is True
    assert is_check_page("Software Engineer Intern - Acme", "We are looking for a security engineer who can wait a moment.") is False


def test_controls_inside_an_open_dialog_are_listed_first_and_marked():
    from resume_agent.observe import format_obs

    text = format_obs(
        {
            "url": "https://www.linkedin.com/jobs/view/1",
            "title": "Job",
            "errors": [],
            "excerpt": "",
            "elements": [{**button("Next"), "id": "f0_9", "inDialog": True}, {**button("Save job 1"), "id": "f0_1"}],
        },
        3,
    )
    lines = text.split("\n")

    def at(s):
        return next((i for i, l in enumerate(lines) if s in l), -1)

    assert at("inside the dialog") < at('"Next"') < at("behind the dialog") < at('"Save job 1"')


def test_the_api_key_and_the_browser_extension_token_stay_on_the_server():
    from resume_agent.settings import get_settings, public_settings, save_settings

    save_settings({"apiKey": "sk-test-1234567890", "extensionToken": "ext-token-abcdef"})
    assert get_settings()["extensionToken"] == "ext-token-abcdef"
    pub = public_settings()
    text = json.dumps(pub, ensure_ascii=False)
    assert "apiKey" not in pub and "extensionToken" not in pub
    assert "ext-token-abcdef" not in text and "sk-test-1234567890" not in text
    assert pub["hasExtensionToken"] is True
    save_settings({"apiKey": "", "extensionToken": ""})
    assert public_settings()["hasExtensionToken"] is False


def test_what_the_candidate_is_looking_for_reaches_the_fit_check_empty_answers_left_out():
    from resume_agent.jobs import search_prefs

    p = normalize_profile(
        {
            "sections": [],
            "answers": [
                {"id": "qa_jobtype", "q": "What type of role are you looking for?", "a": "Full-time entry-level roles"},
                {"id": "qa_grad", "q": "Graduation date", "a": "May 2027"},
                {"id": "qa_dur", "q": "Internship duration you are available for", "a": ""},
                {"id": "qa_gender", "q": "Gender", "a": "Decline"},
            ],
        }
    )
    text = search_prefs(p)
    assert re.match(r"^WHAT THE CANDIDATE IS LOOKING FOR", text)
    assert "Full-time entry-level roles" in text
    assert "May 2027" in text
    assert not re.search(r"duration", text, re.I) and "Gender" not in text
    assert search_prefs(normalize_profile({"sections": [], "answers": []})) == ""


# Shaped like LinkedIn's public search fragment (jobs-guest/…/seeMoreJobPostings), trimmed.
LI_CARDS = """
<li>
  <div class="base-card relative w-full base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4481637634">
    <a class="base-card__full-link absolute top-0 right-0 bottom-0 left-0 p-0 z-[2]" href="https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634?position=1&amp;pageNum=0&amp;refId=abc&amp;trackingId=xyz" data-tracking-control-name="public_jobs_jserp-result_search-card">
      <span class="sr-only">Graduate Software Engineer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">
        Graduate Software Engineer
      </h3>
      <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://sg.linkedin.com/company/hcltech">HCLTech</a>
      </h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">Singapore, Singapore</span>
        <span class="job-search-card__salary-info">S$4,000 - S$5,000</span>
        <time class="job-search-card__listdate" datetime="2026-11-10">3 days ago</time>
      </div>
    </div>
  </div>
</li>
<li>
  <div class="base-card base-search-card job-search-card">
    <a class="base-card__full-link" href="https://sg.linkedin.com/jobs/view/backend-engineer-at-r&amp;d-labs-4400000001?position=2">
      <span class="sr-only">Backend Engineer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">Backend Engineer (Java &amp; Go)</h3>
      <h4 class="base-search-card__subtitle"><a href="#">R&amp;D Labs Pte. Ltd.</a></h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">Central Region, Singapore</span>
        <time class="job-search-card__listdate--new" datetime="2026-11-12">1 day ago</time>
      </div>
    </div>
  </div>
</li>"""


def test_job_search_linkedin_cards_are_read_links_lose_their_tracking():
    from resume_agent.discover import parse_linkedin_cards

    cards = parse_linkedin_cards(LI_CARDS)
    assert len(cards) == 2
    assert cards[0] == {
        "source": "linkedin",
        "title": "Graduate Software Engineer",
        "company": "HCLTech",
        "location": "Singapore, Singapore",
        "posted": "2026-11-10",
        "url": "https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634",
        "salary": "S$4,000 - S$5,000",
    }
    assert cards[1]["title"] == "Backend Engineer (Java & Go)"
    assert cards[1]["company"] == "R&D Labs Pte. Ltd."
    assert cards[1]["salary"] == ""
    assert len(parse_linkedin_cards("<html><body>No matching jobs found.</body></html>")) == 0


def test_job_search_mycareersfuture_results_name_the_real_employer_and_hide_hidden_pay():
    from resume_agent.discover import map_mcf

    out = map_mcf(
        [
            {
                "title": " Software Engineer ",
                "postedCompany": {"name": "TALENT AGENCY PTE. LTD."},
                "hiringCompany": {"name": "ACME ROBOTICS PTE. LTD."},
                "metadata": {
                    "jobDetailsUrl": "https://www.mycareersfuture.gov.sg/job/information-technology/software-engineer-acme-0123456789abcdef0123456789abcdef",
                    "newPostingDate": "2026-11-11",
                    "isPostedOnBehalf": True,
                    "isHideSalary": False,
                },
                "salary": {"minimum": 4000, "maximum": 5500, "type": {"salaryType": "Monthly"}},
                "address": {"districts": [{"location": "Central"}]},
            },
            {
                "title": "Backend Developer",
                "postedCompany": {"name": "BETA PTE. LTD."},
                "metadata": {
                    "jobDetailsUrl": "https://www.mycareersfuture.gov.sg/job/it/backend-beta-fedcba9876543210fedcba9876543210",
                    "newPostingDate": "2026-11-09",
                    "isHideSalary": True,
                },
                "salary": {"minimum": 3000, "maximum": 4000},
            },
            {"title": "No link", "metadata": {}},
        ]
    )
    assert len(out) == 2
    assert out[0]["title"] == "Software Engineer"
    assert out[0]["company"] == "ACME ROBOTICS PTE. LTD."
    assert out[0]["salary"] == "S$4000–5500/月"
    assert out[0]["location"] == "Central"
    assert out[1]["company"] == "BETA PTE. LTD."
    assert out[1]["salary"] == ""


def test_job_search_one_posting_is_listed_once_and_postings_already_in_the_list_are_marked():
    from resume_agent.discover import job_key, merge_found

    assert job_key("https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634?refId=1") == "linkedin:4481637634"
    assert job_key("https://www.linkedin.com/jobs/view/4481637634/") == "linkedin:4481637634"
    base = {"location": "Singapore", "salary": ""}
    from_linkedin = [
        {
            **base,
            "source": "linkedin",
            "title": "Graduate Software Engineer",
            "company": "HCLTech",
            "posted": "2026-11-10",
            "url": "https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634",
        },
        {
            **base,
            "source": "linkedin",
            "title": "Backend Engineer",
            "company": "R&D Labs Pte. Ltd.",
            "posted": "2026-11-12",
            "url": "https://sg.linkedin.com/jobs/view/backend-engineer-at-r-d-labs-4400000001",
        },
    ]
    second_query = [{**from_linkedin[0], "url": "https://www.linkedin.com/jobs/view/4481637634/"}]
    from_mcf = [
        {
            **base,
            "source": "mcf",
            "title": "Backend Engineer",
            "company": "R&D LABS PTE LTD",
            "posted": "2026-11-11",
            "url": "https://www.mycareersfuture.gov.sg/job/it/backend-engineer-rd-0123456789abcdef0123456789abcdef",
        },
        {
            **base,
            "source": "mcf",
            "title": "Software Engineer",
            "company": "Acme",
            "posted": "",
            "url": "https://www.mycareersfuture.gov.sg/job/it/software-engineer-acme-fedcba9876543210fedcba9876543210",
        },
    ]
    known = {job_key("https://sg.linkedin.com/jobs/view/graduate-software-engineer-at-hcltech-4481637634"): 20}
    out = merge_found([from_linkedin, second_query, from_mcf], known)
    assert [[f["title"], f["source"], f["existingId"]] for f in out] == [
        ["Backend Engineer", "linkedin", None],
        ["Graduate Software Engineer", "linkedin", 20],
        ["Software Engineer", "mcf", None],
    ]


def test_job_search_senior_titles_are_recognised_entry_level_ones_are_not():
    from resume_agent.discover import senior_title

    for t in [
        "Senior Java Software Engineer",
        "Sr. Backend Engineer",
        "Lead Java Developer",
        "Staff Software Engineer, GenAI",
        "Engineering Manager",
        "Backend Engineer (5+ years)",
        "Head of Platform",
    ]:
        assert senior_title(t), t
    for t in ["Junior Fullstack Software Engineer", "Graduate Software Engineer", "Software Engineer, Singpass", "Backend Developer", "Leading-edge AI Engineer Intern"]:
        assert not senior_title(t), t


def test_job_search_mycareersfuture_titles_must_carry_a_word_of_the_query():
    from resume_agent.discover import relevant_title

    assert relevant_title("Java Developer", "software developer")
    assert relevant_title("Software Engineering Intern", "software engineer intern")
    assert relevant_title("Engineer, Firmware Development (SSD)", "embedded software engineer")
    assert not relevant_title("Business Development Associate", "software developer")
    assert not relevant_title("(FULL / PART TIME) Business Development Assistant", "part time developer")
    assert not relevant_title("#FreshGrads \U0001f393 This one's for you!", "graduate software engineer")


def test_a_mycareersfuture_posting_is_read_from_its_api_record_closed_ones_say_so():
    from resume_agent.discover import mcf_job_text

    got = mcf_job_text(
        {
            "title": "Software Engineer",
            "description": "<p><strong>JOB DESCRIPTION</strong></p><ul><li>Embedded system development</li><li>C/C++ &amp; Linux</li></ul>",
            "postedCompany": {"name": "AGENCY PTE. LTD."},
            "hiringCompany": {"name": "REALTEK SINGAPORE PRIVATE LIMITED"},
            "metadata": {"isPostedOnBehalf": True, "isHideSalary": False},
            "employmentTypes": [{"employmentType": "Full Time"}],
            "positionLevels": [{"position": "Fresh/entry level"}],
            "minimumYearsExperience": 0,
            "salary": {"minimum": 4500, "maximum": 7500, "type": {"salaryType": "Monthly"}},
            "skills": [{"skill": "Linux"}, {"skill": "Firmware"}],
            "status": {"jobStatus": "Closed"},
        }
    )
    assert got["title"] == "Software Engineer | REALTEK SINGAPORE PRIVATE LIMITED"
    assert re.search(r"Status: Closed", got["text"])
    assert re.search(r"Position level: Fresh/entry level", got["text"])
    assert re.search(r"Minimum years of experience: 0", got["text"])
    assert re.search(r"• Embedded system development\n• C/C\+\+ & Linux", got["text"])
    assert re.search(r"Skills: Linux, Firmware", got["text"])
    assert not re.search(r"<[a-z]", got["text"])


def test_posting_conditions_only_known_values_are_kept_nothing_is_made_up():
    from resume_agent.jobs import asks_cover_letter, normalize_facts

    f = normalize_facts(
        {
            "type": "internship",
            "hours": "part",
            "months": "6",
            "minYears": 99,
            "degree": "bachelor",
            "student": "maybe",
            "workAuth": "citizen_pr",
            "salary": "S$1,200 / month",
            "materials": ["cover_letter", "cover_letter", "selfie", "transcript"],
            "coverLetterAsk": "Why you want to join",
            "workplace": "hybrid",
        }
    )
    assert f["type"] == "internship"
    assert f["months"] == 6
    assert f["minYears"] is None, "an impossible number is dropped, not clamped"
    assert f["student"] == "", "an unknown value becomes empty"
    assert f["materials"] == ["cover_letter", "transcript"]
    assert normalize_facts(None) is None, "no conditions from the model: none recorded"
    assert normalize_facts({})["type"] == "unknown"
    assert normalize_facts({"materials": "cover_letter"})["materials"] == []
    assert asks_cover_letter({**jd, "facts": f}) is True
    assert asks_cover_letter({**jd, "facts": {**f, "materials": []}}) is False
    assert asks_cover_letter(None) is False


def test_cover_letters_written_when_the_settings_say_always_or_the_posting_asks_invented_numbers_flagged():
    from resume_agent.jobs import normalize_facts
    from resume_agent.tailor import cover_letter_warnings, wants_cover_letter

    asks = {**jd, "facts": normalize_facts({"materials": ["cover_letter"]})}
    assert wants_cover_letter(False, jd) is False
    assert wants_cover_letter(True, jd) is True
    assert wants_cover_letter(False, asks) is True
    assert cover_letter_warnings(master, "My pipelines processed 2 million records.", jd) == []
    assert len(cover_letter_warnings(master, "I led a team of 12 engineers.", jd)) == 1


def test_requirement_filters_and_counts_over_the_job_list():
    from resume_agent.jobs import normalize_facts
    from resume_agent.reqs import NO_FILTER, fact_chips, passes, read_filter, req_stats

    def job(id_, facts, keywords, kw_have=None, extra=None):
        return {"id": id_, "jd": {**jd, "keywords": keywords, "facts": None if facts is None else normalize_facts(facts), **(extra or {})}, "kwHave": kw_have or []}

    ft = job(1, {"type": "fulltime", "minYears": 0, "materials": ["cover_letter"]}, ["Java", "React"], ["Java"])
    senior = job(2, {"type": "fulltime", "minYears": 3, "workAuth": "citizen"}, ["Java", "Go"])
    intern = job(3, {"type": "internship", "hours": "part", "months": 6, "student": "enrolled"}, ["python"], ["python"], {"closed": True})
    old = job(4, None, ["Java"])
    all_ = [ft, senior, intern, old]

    def keep(f):
        return [j["id"] for j in all_ if passes(j, {**NO_FILTER, **f})]

    assert keep({}) == [1, 2, 3, 4]
    assert keep({"types": ["fulltime"]}) == [1, 2], "a job read before conditions existed cannot match a type"
    assert keep({"types": ["intern_part"]}) == [3]
    assert keep({"types": ["intern_full"]}) == []
    open_hours = job(5, {"type": "internship"}, [])
    assert passes(open_hours, {**NO_FILTER, "types": ["intern_part"]}) and passes(open_hours, {**NO_FILTER, "types": ["intern_full"]}), "hours not stated: either kind"
    assert keep({"maxYears": 1}) == [1, 3, 4]
    assert keep({"hideCitizenOnly": True}) == [1, 3, 4]
    assert keep({"coverLetter": "yes"}) == [1]
    assert keep({"coverLetter": "no"}) == [2, 3, 4]
    assert keep({"hideClosed": True}) == [1, 2, 4]
    assert keep({"keyword": "java"}) == [1, 2, 4]

    s = req_stats(all_)
    assert s["noFacts"] == 1
    assert s["types"] == [{"label": "全职", "n": 2}, {"label": "兼职实习", "n": 1}]
    assert [y["label"] for y in s["years"]] == ["不要经验", "3 年以上", "没写"]
    assert s["keywords"][0] == {"k": "Java", "n": 3, "have": True}
    assert any(l["label"] == "已关闭" and l["n"] == 1 for l in s["limits"])
    assert any(m["label"] == "要求职信" and m["n"] == 1 for m in s["materials"])

    assert read_filter("not json") == NO_FILTER
    assert read_filter(json.dumps({"types": ["fulltime", "bogus"], "minFit": "x"}))["types"] == ["fulltime"]
    assert read_filter(json.dumps({"types": ["internship"]}))["types"] == ["intern_part", "intern_full"], "a filter saved before the split keeps both"
    chips = fact_chips(normalize_facts({"type": "internship", "hours": "part", "months": 6, "minYears": 2, "workAuth": "citizen"}))
    assert [f"{c['text']}{'!' if c.get('warn') else ''}" for c in chips] == ["兼职实习 6 个月", "2 年以上经验!", "仅限公民!"]


def test_a_fit_that_clashes_with_what_the_candidate_wants_is_capped_only_when_the_posting_backs_the_clash():
    from resume_agent.jobs import FIT_CONFLICT_CAP, normalize_facts, normalize_fit

    def fit(conflict, score=78):
        return {"score": score, "verdict": "x", "strengths": [], "gaps": [], "conflict": conflict}

    full_intern = normalize_facts({"type": "internship", "hours": "full", "months": 6})
    clash = normalize_fit(fit("fulltime_internship"), full_intern)
    assert clash["score"] == FIT_CONFLICT_CAP
    assert re.search(r"全职实习", clash.get("conflict") or "")
    assert normalize_fit(fit("fulltime_internship", 30), full_intern)["score"] == 30, "a lower score stays"
    job = normalize_facts({"type": "fulltime", "hours": "full"})
    made_up = normalize_fit(fit("graduates_only"), job)
    assert made_up["score"] == 78, "a clash the posting does not state is dropped"
    assert "conflict" not in made_up
    assert normalize_fit(fit("graduates_only"), normalize_facts({"type": "fulltime", "student": "graduated"}))["score"] == FIT_CONFLICT_CAP
    assert normalize_fit(fit("fulltime_internship"), normalize_facts({"type": "internship"}))["score"] == 78, "hours not stated: no clash"
    assert normalize_fit(fit("全职岗位，你还没毕业"), job)["score"] == 78, "free text is not a kind"
    assert "conflict" not in normalize_fit(fit(""), job)


def test_a_full_time_internship_is_capped_for_someone_who_wants_part_time_ones_even_when_the_model_missed_it():
    from resume_agent.jobs import FIT_CONFLICT_CAP, cap_for_prefs, normalize_facts

    fit = {"score": 88, "verdict": "x", "strengths": [], "gaps": []}
    prefs = "WHAT THE CANDIDATE IS LOOKING FOR\n- What type of role?: Full-time entry-level roles (main choice); part-time internships as a second option"
    full = normalize_facts({"type": "internship", "hours": "full"})
    assert cap_for_prefs(fit, full, prefs)["score"] == FIT_CONFLICT_CAP
    assert cap_for_prefs(fit, normalize_facts({"type": "internship"}), prefs)["score"] == 88, "hours not stated"
    assert cap_for_prefs(fit, normalize_facts({"type": "fulltime", "hours": "full"}), prefs)["score"] == 88, "a full-time job is not an internship"
    assert cap_for_prefs(fit, full, "- Role: part-time or full-time internships")["score"] == 88, "full-time internships accepted too"
    assert cap_for_prefs(fit, full, "")["score"] == 88
    named = {**fit, "score": 40, "conflict": "只招已经毕业的"}
    assert cap_for_prefs(named, full, prefs) is named, "an existing conflict is kept as it is"


def test_postings_are_read_without_the_site_around_them():
    from resume_agent.jobs import trim_posting

    linkedin = "\n".join(
        [
            "Skip to main content", "LinkedIn", "Jobs", "Clear text", "Sign in", "Join now",
            "Software Engineer, Singpass", "GovTech Singapore  Singapore, Singapore", "1 day ago  41 applicants",
            "See who GovTech Singapore has hired for this role", "Apply", "Save", "Use AI to assess how you fit", "Am I a good fit for this job?", "Tailor my resume",
            "What the role is", "Build Singpass. Requirements: Java or Go.", "Show more", "Seniority level", "Entry level", "Employment type", "Full-time",
            "Referrals increase your chances of interviewing at GovTech Singapore by 2x", "See who you know",
            "Similar jobs", "Senior Software Engineer", "Changi Airport Group", "People also viewed", "Software Engineer, Google Ads Team", "Google",
        ]
    )  # fmt: skip
    t = trim_posting(linkedin, "https://sg.linkedin.com/jobs/view/software-engineer-singpass-at-govtech-singapore-4436070851")
    assert re.match(r"^Software Engineer, Singpass\nGovTech Singapore", t), "title and company kept"
    assert re.search(r"Requirements: Java or Go\.", t)
    assert re.search(r"Employment type\nFull-time", t), "the criteria block is part of the posting"
    for gone in ["Join now", "Tailor my resume", "Show more", "Similar jobs", "Changi Airport", "Google Ads", "Referrals"]:
        assert gone not in t, gone

    mcf = "\n".join(
        [
            "By continuing to browse our site you agree to our use of cookies.", "Close", "Log In",
            "The machine translation for this job description is powered by Microsoft Translator.",
            "ACTXA PTE. LTD.", "Software Engineering Intern - IN26009", "Internship/Attachment", "Requirements", "Currently pursuing a Bachelor's degree.",
            "See how you compare with other applicants", "Log in to view", "Add these skills if you have them", "Python",
            "More jobs from this company", "Log in to Apply", "Privacy Statement",
        ]
    )  # fmt: skip
    m = trim_posting(mcf, "https://www.mycareersfuture.gov.sg/job/information-technology/software-engineering-intern-in26009-actxa-7ecd1263")
    assert re.match(r"^ACTXA PTE\. LTD\.\nSoftware Engineering Intern", m)
    assert re.search(r"Currently pursuing a Bachelor's degree\.\nPython$", m), "MyCareersFuture's skill tags stay"
    for gone in ["cookies", "See how you compare", "Log in", "Privacy Statement"]:
        assert gone not in m, gone

    other = "Apply\nSimilar jobs\nSave"
    assert trim_posting(other, "https://careers.example.com/job/1") == other, "other sites come back as they were"
    assert trim_posting(other, "") == other, "pasted text without a link too"
    from_api = "Title\n\nRequirements\n• C++"
    assert trim_posting(from_api, "https://www.mycareersfuture.gov.sg/job/x-1234") == from_api, "MyCareersFuture text from its API has no page around it"


def test_off_peak_deepseek_peak_is_weekdays_9_12_and_14_18_beijing_time():
    from resume_agent.offpeak import is_peak, peak_ends

    def bj(s):
        return datetime.fromisoformat(f"{s}+08:00")

    # Friday 13 November 2026.
    assert is_peak(bj("2026-11-13T08:59")) is False
    assert is_peak(bj("2026-11-13T09:00")) is True
    assert peak_ends(bj("2026-11-13T10:30")) == bj("2026-11-13T12:00")
    assert is_peak(bj("2026-11-13T12:30")) is False, "lunch break"
    assert peak_ends(bj("2026-11-13T17:59")) == bj("2026-11-13T18:00")
    assert is_peak(bj("2026-11-13T18:00")) is False
    assert is_peak(bj("2026-11-14T10:00")) is False, "Saturday"
    assert peak_ends(bj("2026-11-13T20:00")) is None


def test_batch_tailoring_waits_for_off_peak_and_a_free_slot_a_job_you_push_goes_now(monkeypatch):
    from resume_agent.batch import pump, run_now
    from resume_agent.jobs import add_jobs, get_job, set_job
    from resume_agent.llm import set_no_balance
    from resume_agent.settings import save_settings

    pushed: list = []
    monkeypatch.setattr(jobs.bg_queue, "push", lambda t: pushed.append(t))
    a, b = add_jobs(["https://example.com/batch/1", "https://example.com/batch/2"], auto_apply=True)["ids"]
    jd_json = json.dumps({"title": "Intern", "keywords": []})

    def hold(id_, **extra):
        set_job(id_, {"busy": None, "jd": jd_json, "stage": "parsed", "held": "tailor", **extra})

    peak = datetime.fromisoformat("2026-11-13T10:00+08:00")
    off = datetime.fromisoformat("2026-11-13T20:00+08:00")
    save_settings({"offPeakOnly": True, "llmMode": "deepseek", "apiKey": "sk-test"})
    hold(a)
    hold(b)
    pushed.clear()

    pump(peak)
    assert get_job(a)["held"] == "tailor", "nothing starts at peak"
    assert len(pushed) == 0

    monkeypatch.setattr(jobs.bg_queue, "size", lambda: 2)
    pump(off)
    assert get_job(a)["held"] == "tailor", "off-peak, but no free slot: still waits"
    monkeypatch.setattr(jobs.bg_queue, "size", lambda: 0)

    pump(off)
    assert get_job(a)["held"] is None
    assert get_job(a)["busy"] == "tailoring"
    assert len(pushed) == 2, "both start off-peak"

    hold(a)
    run_now([a])
    assert get_job(a)["busy"] == "tailoring", "现在就跑 skips the wait whatever the time"

    hold(b, stage="skipped")
    pump(peak)
    assert get_job(b)["held"] is None, "a skipped job stops waiting"

    hold(b)
    save_settings({"offPeakOnly": False})
    pump(peak)
    assert get_job(b)["held"] is None, "turning the setting off starts what was waiting"
    assert get_job(b)["busy"] == "tailoring"

    hold(a, busy=None)
    set_no_balance("¥-0.06")
    pump(off)
    assert get_job(a)["held"] == "tailor", "an empty balance keeps it waiting instead of failing it"
    set_no_balance(None)
    pump(off)
    assert get_job(a)["held"] is None
    save_settings({"apiKey": ""})


def test_costs_are_priced_by_the_time_of_each_call_an_empty_balance_stops_calls_before_they_are_made(monkeypatch):
    from resume_agent.cost import call_rmb
    from resume_agent.jobs import add_jobs, get_job, parse_job
    from resume_agent.llm import chat, llm_ready, set_no_balance
    from resume_agent.settings import save_settings

    row = {"prompt_tokens": 1_000_000, "cache_hit_tokens": 500_000, "completion_tokens": 100_000}
    # Friday 13 November 2026, UTC: 02:00 is 10:00 in Beijing (peak), 12:00 is 20:00 (off-peak).
    assert to_fixed(call_rmb({**row, "ts": "2026-11-13 02:00:00"}), 2) == to_fixed(0.5 * 2 + 0.5 * 0.04 + 0.1 * 8, 2)
    assert to_fixed(call_rmb({**row, "ts": "2026-11-13 12:00:00"}), 2) == to_fixed(0.5 * 1 + 0.5 * 0.02 + 0.1 * 4, 2)

    async def balance_402(*a, **k):
        return net.Response(402, '{"error":{"message":"Insufficient Balance"}}')

    async def no_sleep(s):
        return None

    monkeypatch.setattr(net, "request", balance_402)
    monkeypatch.setattr(net, "sleep", no_sleep)
    try:
        save_settings({"apiKey": "sk-test", "llmMode": "deepseek"})
        set_no_balance(None)
        assert llm_ready()["ok"] is True
        with pytest.raises(Exception, match="402"):
            asyncio.run(chat(messages=[{"role": "user", "content": "hi"}]))
        r = llm_ready()
        assert not r["ok"] and r["code"] == "no_balance", "a 402 marks the balance as used up"
        [id_] = add_jobs([], jd_text="Data Analyst at Example. SQL and Python required. " * 3, auto_apply=False)["ids"]
        calls = 0

        async def server_error(*a, **k):
            nonlocal calls
            calls += 1
            return net.Response(500, "{}")

        monkeypatch.setattr(net, "request", server_error)
        with pytest.raises(Exception, match="余额不足"):
            asyncio.run(parse_job(id_))
        assert calls == 0, "no call is made while the balance is empty"
        assert get_job(id_)["jd"] is None
    finally:
        set_no_balance(None)
        save_settings({"apiKey": ""})


def test_a_page_that_kept_its_layout_is_sent_as_the_fields_that_changed_anything_else_in_full():
    from resume_agent.observe import format_delta, format_obs

    def field(id_, label, value=""):
        return {**button(""), "id": id_, "kind": "text", "label": label, "value": value}

    def page(els, excerpt="Apply to Acme\nPersonal details"):
        return {"url": "https://jobs.example.com/apply", "title": "Apply", "errors": [], "elements": els, "excerpt": excerpt}

    many = [field(f"f0_{i + 10}", f"Question {i + 1}") for i in range(20)]
    before = page([field("f0_1", "First name"), field("f0_2", "Phone"), button("Next", id="f0_3"), *many])
    after = page([field("f0_1", "First name", "Ada"), field("f0_2", "Phone"), button("Next", id="f0_3"), *many])

    d = format_delta(before, after, 3, 4)
    assert d, "values changed, layout did not"
    assert re.match(r"^STEP 4 — same page and elements as the STEP 3 snapshot", d)
    assert re.search(r'\[f0_1\] text "First name" = "Ada"', d)
    assert "Phone" not in d and "Question 1" not in d, "unchanged elements are not repeated"
    assert re.search(r"Visible text: unchanged\.", d)
    assert len(d) < len(format_obs(after, 4)) / 3, "much smaller than the full snapshot"

    relabelled = page([field("f0_1", "Given name", "Ada"), field("f0_2", "Phone"), button("Next", id="f0_3"), *many])
    assert format_delta(before, relabelled, 3, 4) is None, "a changed label means a full snapshot"
    moved = {**after, "url": "https://jobs.example.com/apply/step-2"}
    assert format_delta(before, moved, 3, 4) is None, "another URL means a full snapshot"
    all_changed = page([{**e, "value": "x"} if e["kind"] == "text" else e for e in before["elements"]])
    assert format_delta(before, all_changed, 3, 4) is None, "when nearly everything changed, the full snapshot is not much bigger"

    with_error = {**after, "errors": ["Phone is required"], "excerpt": "Apply to Acme\nPhone is required"}
    e = format_delta(before, with_error, 3, 4)
    assert re.search(r'Errors/alerts on page now: "Phone is required"', e)
    assert re.search(r"Visible text \(start\), now:\nApply to Acme\nPhone is required", e)


def test_re_reading_a_job_with_the_same_posting_profile_and_prompt_does_not_call_the_model_again(monkeypatch):
    from resume_agent.jobs import add_jobs, get_job, parse_job, set_job
    from resume_agent.settings import save_settings

    calls = 0

    async def fake(*a, **k):
        nonlocal calls
        calls += 1
        content = json.dumps(
            {
                "title": "Software Intern",
                "company": "Acme",
                "location": "Singapore",
                "summary": "",
                "requirements": ["Python"],
                "niceToHave": [],
                "keywords": ["Python"],
                "language": "en",
                "closed": False,
                "facts": None,
                "fit": None,
            }
        )
        return net.Response(200, json.dumps({"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 100, "completion_tokens": 20}}))

    monkeypatch.setattr(net, "request", fake)
    try:
        save_settings({"apiKey": "sk-test", "llmMode": "deepseek"})
        [id_] = add_jobs([], jd_text="Software Intern at Acme. Requirements: Python, SQL. Apply by December. " * 3, auto_apply=False)["ids"]
        set_job(id_, {"busy": None})
        asyncio.run(parse_job(id_))
        assert calls == 1
        assert get_job(id_)["title"] == "Software Intern"
        asyncio.run(parse_job(id_))
        assert calls == 1, "nothing changed: the saved reading is reused"
        set_job(id_, {"jd_text": f"{get_job(id_)['jd_text']} Java is a plus."})
        asyncio.run(parse_job(id_))
        assert calls == 2, "a changed posting is read again"
    finally:
        save_settings({"apiKey": ""})
