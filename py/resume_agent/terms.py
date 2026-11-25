"""Catches model text that credits the candidate with a tool or skill the profile never mentions
(the first real run's fit and interview prep both claimed ROS experience that is not there)."""

from __future__ import annotations

import re
from functools import lru_cache

# Distinctive technical names; generic words (testing, embedded, spring, go) are left out on purpose.
KNOWN = [
    "Python", "Java", "C++", "C#", "JavaScript", "TypeScript", "Golang", "Rust", "Kotlin", "Swift", "Scala", "PHP", "Ruby",
    "SQL", "MySQL", "PostgreSQL", "SQLite", "Redis", "MongoDB", "Elasticsearch", "Cassandra", "DynamoDB",
    "Spring Boot", "Django", "Flask", "FastAPI", "React", "Vue", "Angular", "Next.js", "Node.js", "Express", "Svelte",
    "Docker", "Kubernetes", "AWS", "GCP", "Azure", "Linux", "Git", "GitHub Actions", "Jenkins", "CI/CD", "Terraform", "Nginx",
    "Kafka", "RabbitMQ", "Spark", "Hadoop", "Airflow", "Flink",
    "PyTorch", "TensorFlow", "scikit-learn", "Pandas", "NumPy", "OpenCV", "LangChain", "LLM", "NLP", "RAG", "CUDA",
    "ROS", "ARM", "FPGA", "Verilog", "VHDL", "MATLAB", "Simulink", "RTOS", "STM32",
    "JUnit", "pytest", "Jest", "Selenium", "Playwright", "Cypress", "GraphQL", "gRPC", "REST API",
    "Unity", "Unreal", "Figma", "Tableau", "Power BI", "Agile", "Scrum", "Jira",
]  # fmt: skip

# Other ways a profile may write the same thing (the first real profile says "Robot Operating System").
ALIASES: dict[str, list[str]] = {
    "ROS": ["Robot Operating System"],
    "Kubernetes": ["k8s"],
    "PostgreSQL": ["Postgres"],
    "Node.js": ["NodeJS"],
    "Next.js": ["NextJS"],
    "JavaScript": ["JS", "ECMAScript"],
    "TypeScript": ["TS"],
    "Golang": ["Go"],
    "scikit-learn": ["sklearn"],
    "Spring Boot": ["SpringBoot"],
    "Power BI": ["PowerBI"],
    "REST API": ["RESTful", "REST"],
    "AWS": ["Amazon Web Services"],
    "GCP": ["Google Cloud"],
    "LLM": ["large language model"],
    "NLP": ["natural language processing"],
    "RAG": ["retrieval-augmented", "retrieval augmented"],
}


@lru_cache(maxsize=4096)
def _pattern(term: str, case_sensitive: bool, with_version: bool) -> re.Pattern[str]:
    version = r"(?:[ -]?v?\d+(?:\.\d+)*)?" if with_version else ""
    return re.compile(r"(^|[^A-Za-z0-9+#])" + re.escape(term) + version + r"(?![A-Za-z0-9+#])", 0 if case_sensitive else re.I)


def _has(text: str, term: str, case_sensitive: bool, with_version: bool = False) -> bool:
    """Whether the term appears as a word of its own (so "Java" is not found in "JavaScript").
    with_version also accepts a version right after it, so a profile's "Vue3" or "HTML5" counts."""
    return _pattern(term, case_sensitive, with_version).search(text) is not None


def mentions(text: str, term: str) -> bool:
    """The text mentions the term, under its own name or an alias (short aliases only in their own case), maybe with a version."""
    return any(_has(text, name, name != term and len(name) <= 3, True) for name in [term, *ALIASES.get(term, [])])


def profile_text(p: dict) -> str:
    """Everything the profile says, as one string to search."""
    parts: list[str] = [p["summary"], p["extraFacts"]]
    for s in p["sections"]:
        parts.append(s["heading"])
        for e in s["entries"]:
            parts += [e["title"], e["subtitle"], e["location"], e["dates"], *[b["text"] for b in e["bullets"]]]
    for g in p["skills"]:
        parts += [g["label"], *g["items"]]
    return "\n".join(parts)


_TECHNICAL = re.compile(r"[A-Za-z][A-Za-z0-9.+#/-]*( [A-Z][A-Za-z0-9.+#-]*)?")
_ACRONYM = re.compile(r"[A-Z0-9/+#]{2,5}")


def unsupported_terms(text: str, profile: str, extra: list[str] | None = None) -> list[str]:
    """Tool and skill names mentioned in `text` that the profile never mentions. Short all-caps names
    (ROS, ARM, AWS) only count when written in capitals, so "a robotic arm" is not ARM."""

    def looks_technical(k: str) -> bool:
        return bool(_TECHNICAL.fullmatch(k)) and re.search(r"[A-Z]", k) is not None and len(k) >= 2

    terms: list[str] = []
    for t in [*KNOWN, *[k for k in (extra or []) if looks_technical(k)]]:
        if t not in terms:
            terms.append(t)
    out: list[str] = []
    for t in terms:
        acronym = bool(_ACRONYM.fullmatch(t))
        if not _has(text, t, acronym):
            continue
        if not mentions(profile, t):
            out.append(t)
    return out
