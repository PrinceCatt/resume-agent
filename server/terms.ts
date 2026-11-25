// Catches model text that credits the candidate with a tool or skill the profile never mentions
// (the first real run's fit and interview prep both claimed ROS experience that is not there).
import type { Profile } from "./profile.ts";

/** Distinctive technical names; generic words (testing, embedded, spring, go) are left out on purpose. */
const KNOWN = [
  "Python", "Java", "C++", "C#", "JavaScript", "TypeScript", "Golang", "Rust", "Kotlin", "Swift", "Scala", "PHP", "Ruby",
  "SQL", "MySQL", "PostgreSQL", "SQLite", "Redis", "MongoDB", "Elasticsearch", "Cassandra", "DynamoDB",
  "Spring Boot", "Django", "Flask", "FastAPI", "React", "Vue", "Angular", "Next.js", "Node.js", "Express", "Svelte",
  "Docker", "Kubernetes", "AWS", "GCP", "Azure", "Linux", "Git", "GitHub Actions", "Jenkins", "CI/CD", "Terraform", "Nginx",
  "Kafka", "RabbitMQ", "Spark", "Hadoop", "Airflow", "Flink",
  "PyTorch", "TensorFlow", "scikit-learn", "Pandas", "NumPy", "OpenCV", "LangChain", "LLM", "NLP", "RAG", "CUDA",
  "ROS", "ARM", "FPGA", "Verilog", "VHDL", "MATLAB", "Simulink", "RTOS", "STM32",
  "JUnit", "pytest", "Jest", "Selenium", "Playwright", "Cypress", "GraphQL", "gRPC", "REST API",
  "Unity", "Unreal", "Figma", "Tableau", "Power BI", "Agile", "Scrum", "Jira",
];

/** Other ways a profile may write the same thing (the first real profile says "Robot Operating System"). */
const ALIASES: Record<string, string[]> = {
  ROS: ["Robot Operating System"],
  Kubernetes: ["k8s"],
  PostgreSQL: ["Postgres"],
  "Node.js": ["NodeJS"],
  "Next.js": ["NextJS"],
  JavaScript: ["JS", "ECMAScript"],
  TypeScript: ["TS"],
  Golang: ["Go"],
  "scikit-learn": ["sklearn"],
  "Spring Boot": ["SpringBoot"],
  "Power BI": ["PowerBI"],
  "REST API": ["RESTful", "REST"],
  AWS: ["Amazon Web Services"],
  GCP: ["Google Cloud"],
  LLM: ["large language model"],
  NLP: ["natural language processing"],
  RAG: ["retrieval-augmented", "retrieval augmented"],
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/#]/g, "\\$&");

/**
 * Whether the term appears as a word of its own (so "Java" is not found in "JavaScript").
 * withVersion also accepts a version right after it, so a profile's "Vue3" or "HTML5" counts.
 */
function has(text: string, term: string, caseSensitive: boolean, withVersion = false) {
  const version = withVersion ? "(?:[ -]?v?\\d+(?:\\.\\d+)*)?" : "";
  const re = new RegExp(`(^|[^A-Za-z0-9+#])${esc(term)}${version}(?![A-Za-z0-9+#])`, caseSensitive ? "" : "i");
  return re.test(text);
}

/** The text mentions the term, under its own name or an alias (short aliases only in their own case), maybe with a version. */
export const mentions = (text: string, term: string) =>
  [term, ...(ALIASES[term] ?? [])].some((name) => has(text, name, name !== term && name.length <= 3, true));

/** Everything the profile says, as one string to search. */
export function profileText(p: Profile) {
  return [
    p.summary,
    p.extraFacts,
    ...p.sections.flatMap((s) => [s.heading, ...s.entries.flatMap((e) => [e.title, e.subtitle, e.location, e.dates, ...e.bullets.map((b) => b.text)])]),
    ...p.skills.flatMap((g) => [g.label, ...g.items]),
  ].join("\n");
}

/**
 * Tool and skill names mentioned in `text` that the profile never mentions. Short all-caps names
 * (ROS, ARM, AWS) only count when written in capitals, so "a robotic arm" is not ARM.
 */
export function unsupportedTerms(text: string, profile: string, extra: string[] = []) {
  const looksTechnical = (k: string) => /^[A-Za-z][A-Za-z0-9.+#/-]*( [A-Z][A-Za-z0-9.+#-]*)?$/.test(k) && /[A-Z]/.test(k) && k.length >= 2;
  const terms = [...new Set([...KNOWN, ...extra.filter(looksTechnical)])];
  const out: string[] = [];
  for (const t of terms) {
    const acronym = /^[A-Z0-9/+#]{2,5}$/.test(t);
    if (!has(text, t, acronym)) continue;
    if (!mentions(profile, t)) out.push(t);
  }
  return out;
}
